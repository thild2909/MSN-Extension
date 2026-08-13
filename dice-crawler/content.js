(async()=>{

    const LOG="[dice-crawler]";
    const ORIGIN=location.origin;

    //---------------------------------------------------
    // guard against double runs when the button is clicked repeatedly
    //---------------------------------------------------

    if(window.__diceCrawlerRunning){
        alert("Crawler is already running on this tab. Wait for it to finish.");
        return;
    }

    window.__diceCrawlerRunning=true;

    const core=window.CrawlerCore;

    if(!core){

        alert("core.js is not loaded in this tab. popup.js must inject core.js before content.js.");

        window.__diceCrawlerRunning=false;

        return;

    }

    //---------------------------------------------------
    // selectors
    //
    // Dice is a Next.js app styled with Tailwind, so every class name on the page is a utility
    // ("mb-0 text-sm font-normal text-zinc-600") that changes with the design and means nothing.
    // Only data-testid, role and aria-* are read here - they are what the site's own tests use and
    // they survive a restyle.
    //---------------------------------------------------

    // The results list, and the ONLY safe way to tell it from the "Similar Jobs" strip in the
    // detail pane on the right: that strip carries role="list" AND aria-label="Job search results"
    // as well, and its entries are job-cards too. Reading the page without this scope pulled 2-4
    // jobs belonging to a completely different search into every page of the export.
    const LIST='[data-testid="job-search-split-view-card-list-scroll"]';
    const LIST_FALLBACK='[role="list"][aria-label="Job search results"]';

    // one <div role="listitem"> per card. With "Group by company" on it holds a company header
    // plus N job entries; with it off it holds exactly one job card, company name included.
    const GROUP='[role="listitem"]';
    const ENTRY='[data-testid="grouped-job-entry"]';
    const CARD='[data-testid="job-card"]';

    const TITLE='[data-testid="grouped-job-entry-title"],[data-testid="job-search-job-detail-link"]';
    const COMPANY_LINK='a[href*="/company-profile/"]';
    const COMPANY_NAME='[data-testid="job-card-company-name"]';

    // both layouts carry these on the entry itself
    const JOB_ID="data-id";
    const JOB_GUID="data-job-guid";

    // "11850 results (653 new)" - matched at the START of a paragraph, so it is the count field
    // rather than any sentence in a job description that happens to contain the word.
    const TOTAL=/^([\d,]+)\s+results\b/i;

    // Dice puts 30 jobs on a results page. Only used to work out where the list ends, so the walk
    // stops there instead of paying for pages that cannot hold anything.
    const PAGE_SIZE=30;

    // Dice serves 25 pages per search and no more, whatever the result count says. Measured, not
    // guessed: ?page=26 through ?page=400 all come back 200 with a full list, the pager still
    // reads "Page 25", and the jobs are the same ones page 25 already gave (page 27, 100 and 300
    // were byte-for-byte the same 30 ads). Walking past 25 therefore costs a request per page and
    // adds nothing, so the run says so in the summary instead of quietly looking complete.
    const PAGE_CAP=25;

    // "Today" / "3d ago" / "13d ago" / "30+ days ago"
    const AGE=/(\d+)\s*\+?\s*(mo|min|minute|hour|day|week|month|year|[mhdwy])s?\s*ago/i;

    // is this half of the meta line the date rather than the place - only needed when one half is
    // missing, which no real Dice card has done, but "Today" turning into a location and then into
    // "Onsite" is exactly the kind of invented value this family does not write
    const WHEN=/^\s*(?:today|yesterday)\b|\bago\b/i;

    const UNIT={m:1,min:1,minute:1,h:60,hour:60,d:1440,day:1440,w:10080,week:10080,mo:43200,month:43200,y:525600,year:525600};

    // the meta line under a title: "Hybrid in Dallas, Texas • 11d ago", "Remote • 4d ago",
    // "No location provided • Today". The bullet is the separator Dice renders between the two.
    const BULLET=/\s*[•·]\s*/;

    // The three shapes Dice writes a work model in, checked against every location string on six
    // real result pages: "Hybrid in Dallas, Texas", "Remote", "Remote or Jacksonville, Florida",
    // and otherwise a plain place. REMOTE_OR is an either/or offer, not a split week, so it counts
    // as Remote - but the city it names is still the job's location and is kept.
    const HYBRID=/^hybrid\s+in\s+/i;
    const REMOTE_OR=/^remote\s+or\s+/i;
    const REMOTE=/^remote$/i;
    const NO_LOCATION=/^no location provided$/i;

    // The pace floor is zero: nothing is paid until Dice actually pushes back. See _shared/core.js.
    const MIN_GAP=0;

    const gate=core.makeGate({minGap:MIN_GAP,limit:4,log:LOG});

    const fetcher=core.makeFetcher(gate,{
        log:LOG,
        // Two refusals in a row are answered by a real navigation rather than the rest of the
        // retry ladder - but only while there is a tab left to open.
        canEscalate:()=>tabs.available
    });

    const jobs=[];

    // job id -> the results page it was first seen on. A plain Set would dedupe just as well, but
    // it could not tell the two reasons a page brings nothing new apart: a page re-read on purpose
    // (the rewind, a resumed run), which must not stop the walk, versus Dice answering a page
    // number past its 25 page ceiling by re-serving page 25, which must.
    const visited=new Map();

    const startedAt=performance.now();

    const report=core.makeReporter("dice-crawler-status",LOG);

    // A 403/429 from a content script's fetch is as often "that did not look like a browser" as
    // "too fast", and backing off only answers one of the two. Reopening the URL as a real
    // top-level navigation answers the other. `extract` names the one element the crawl reads, so
    // the worker sends back ~100KB of list instead of a 340KB page that is mostly the app's own
    // JSON payload.
    const tabs=core.makeTabFallback({
        log:LOG,
        report,
        lastStatus:fetcher.lastStatus,
        extract:[LIST,LIST_FALLBACK],
        describe:url=>"page "+(core.paramOf(url,"page",ORIGIN)||1)
    });

    // Cut the page down to the results list before parsing it.
    //
    // A Dice search page is ~340KB and roughly two thirds of it is the Next.js flight payload plus
    // the job detail pane on the right - none of which is read here. DOMParser runs on the crawl's
    // own main thread, so at parallel 6 the parses queue rather than overlap and the parse, not
    // the network, is what a wide run waits on.
    //
    // "" rather than null when the marker is missing: null tells core "this page has been read and
    // does not carry it", which would make a 200-with-a-bot-check indistinguishable from the end
    // of the list. "" falls through to parsing the whole page, which is what an unrecognised page
    // deserves.
    function sliceList(html){

        const at=html.indexOf("job-search-split-view-card-list-scroll");

        if(at<0) return "";

        // back up to the start of the tag carrying the marker, so the cut never begins mid-attribute
        const open=html.lastIndexOf("<div",at);

        // everything after <aside is the detail pane, Similar Jobs included
        const end=html.indexOf("<aside",at);

        return html.slice(open<0?at:open,end<0?html.length:end);

    }

    // did the cut actually land - if not, the whole page is parsed as before and nothing is lost
    const hasCards=doc=>!!doc.querySelector(CARD+","+ENTRY);

    const fetchDoc=(url,opts)=>core.tabFirst(fetcher,tabs,url,
        Object.assign({slice:sliceList,sliced:hasCards},opts||{}));

    const norm=core.norm;

    // A tab navigation kills the content script outright - no catch block runs and nothing is
    // written. The checkpoint turns that from "the whole run is gone" into "the next run starts
    // where this one stopped".
    const checkpoint=core.makeCheckpoint("diceCheckpoint",{log:LOG});

    // set the moment the file is handed to the browser, so the crash path can never write a second one
    let fileWritten=false;

    let resumed=0;
    let rewound=0;

    try{

        //---------------------------------------------------
        // 0. core.js must be injected into the tab BEFORE content.js
        //---------------------------------------------------

        if(!core){

            const msg="core.js is not loaded in this tab. popup.js must inject core.js before content.js.";
            console.error(LOG,msg);
            alert(msg);
            return;

        }

        //---------------------------------------------------
        // 1. read the settings saved by the popup
        //---------------------------------------------------

        let maxPages=0;
        let concurrency=4;

        try{

            const settings=await chrome.storage.local.get(["maxPages","concurrency"]);

            maxPages=Math.max(0,+settings.maxPages||0);

            if(settings.concurrency) concurrency=Math.min(12,Math.max(1,+settings.concurrency));

        }
        catch(e){
            console.warn(LOG,"could not read settings, using defaults",e);
        }

        // the setting is the ceiling, not a fixed width: the gate drops below it while refused
        gate.limit=concurrency;
        gate.maxLimit=concurrency;

        // the tab fallback is built before the crawl knows how much work there is, so its defaults
        // are sized for a bad day rather than for a search where every page has to be reopened
        tabs.setLimit(concurrency);

        //---------------------------------------------------
        // 1b. pick up an unfinished run on the same search
        //---------------------------------------------------

        const saved=await checkpoint.load();

        if(saved&&Array.isArray(saved.jobs)&&saved.jobs.length){

            for(const job of saved.jobs){

                if(!job||!job.id||visited.has(job.id)) continue;

                visited.set(job.id,job.page||0);
                jobs.push(job);
                resumed++;

            }

            report(`Resumed ${resumed} job(s) from an unfinished run on this search.`);

        }

        //---------------------------------------------------
        // 2. read the page already on screen, then walk the rest
        //---------------------------------------------------

        const total=readTotal(document);

        if(total) console.log(LOG,`Dice advertises ${total} job(s) for this search`);

        // Ask now, while nothing is on fire. A worker that turns out to be unreachable at page 18
        // has already cost the run the minutes it took to get there.
        if(await tabs.ready()) console.log(LOG,"tab fallback is ready");

        const paging=await crawlAllPages(maxPages,total);

        console.log(LOG,`${paging.pages} page(s) read -> ${jobs.length} jobs`
            +(paging.stoppedEarly?" (stopped early)":""));

        if(jobs.length===0){

            alert("No job cards found. Open a www.dice.com/jobs search results page and run again.");
            return;

        }

        //---------------------------------------------------
        // 3. group by company
        //---------------------------------------------------

        const companies=buildCompanies(jobs);

        console.log(LOG,`${jobs.length} jobs -> ${companies.length} companies`);

        //---------------------------------------------------
        // 4. export to excel + trigger the download
        //
        // There is no detail phase, on purpose. Everything the sheet needs is on the card:
        // company, title, location, how long ago it was posted, and whether the job is remote,
        // hybrid or on site. The one column with no source is Employees - Dice's company profile
        // is a client-rendered shell (a plain GET returns 4KB of <script> tags and nothing else)
        // and no job page states a headcount either, so opening one page per company would cost
        // the run several hundred requests to fill in nothing.
        //---------------------------------------------------

        finish({companies,total,paging,crashed:null});

    }
    catch(e){

        console.error(LOG,"crawl aborted:",e);

        // Everything collected up to the crash is real data. Throwing it away because the last
        // step failed is the single most expensive thing a crawler can do.
        salvage(e);

    }
    finally{

        window.__diceCrawlerRunning=false;

    }

    //---------------------------------------------------
    // helper: write the file
    //---------------------------------------------------

    function finish(state){

        // the crash path calls this too, and an exception raised INSIDE it would come back round
        // and download a second copy of the same file
        if(fileWritten) return;

        fileWritten=true;

        // fixed header: companies with missing data must still keep all 6 columns
        const HEADERS=["Company Name","Location","Positions","Recruitment time","Employees","Remote/Onsite"];

        const results=state.companies.map(company=>({
            "Company Name":company.name,
            "Location":company.locations.join(", "),
            "Positions":company.positions.join(" | "),
            "Recruitment time":company.posted,
            "Employees":company.employees,
            "Remote/Onsite":company.modes.join(", ")
        }));

        const written=core.exportCsv(results,{
            headers:HEADERS,
            filename:"dice_companies.csv",
            log:LOG
        });

        const withTime=results.filter(r=>r["Recruitment time"]).length;
        const withMode=results.filter(r=>r["Remote/Onsite"]).length;
        const elapsed=Math.round((performance.now()-startedAt)/1000);

        const paging=state.paging||{pages:0,failed:0,recovered:0,reason:"end",capped:false,repeated:false,deepest:0};

        // "Done" on its own reads as "that was all of it", which is exactly wrong when the walk was
        // cut short: the file then looks complete while most of the search is missing.
        const problems=[

            "Employees is always blank: Dice's company profile is rendered entirely in the browser "
                +"(a plain request returns an empty shell) and no job page states a headcount, so "
                +"there is nothing to read.",

            rewound?`Rewound to page 1: the tab was on page ${rewound+1}, so pages 1-${rewound} `
                +"would otherwise have been skipped entirely.":"",

            paging.recovered?`${paging.recovered} page(s) were recovered on the second pass.`:"",

            paging.failed?`${paging.failed} page(s) could not be read at all - those jobs are missing.`:"",

            paging.capped
                ? (paging.repeated
                    ? `Stopped at page ${paging.deepest}: Dice re-sent a list it had already served, `
                        +"which is how it says that is as deep as it goes for this search. "
                    : `Reached page ${PAGE_CAP}, which is as deep as Dice serves any search - past `
                        +"that it re-sends the same list whatever page number is asked for. ")
                    +"Narrow the search (location, employment type, posted date) and run again to "
                    +"reach the rest."
                :"",

            paging.reason==="blocked"
                ? "Dice stopped serving results part way through - that is a refusal, not the end of "
                    +"the list. Wait a few minutes and run again, or lower 'parallel'."
                :"",

            paging.reason==="limit"?"Stopped at the max pages limit - there are more results.":"",

            written.clipped?`${written.clipped} cell(s) truncated to fit Excel's 32,767 character limit.`:""

        ].filter(Boolean);

        // Say the gap out loud. "748 jobs" reads like a complete run until it is put next to the
        // 11,850 Dice advertises.
        const coverage=state.total
            ? ` of the ${state.total} Dice reports`
                +(jobs.length<state.total?` - ${state.total-jobs.length} NOT READ`:" - complete")
            :"";

        const summary=`Done in ${elapsed}s: ${results.length} companies from ${jobs.length} jobs`
            +coverage
            +` over ${paging.pages} page(s), ${withTime} with recruitment time, `
            +`${withMode} with Remote/Onsite.`
            +(resumed?`\nResumed ${resumed} job(s) from an earlier unfinished run.`:"")
            +(problems.length?"\n\n"+problems.join("\n"):"")
            +(fetcher.describe()?`\nRequests: ${fetcher.describe()}`:"")
            +(tabs.describe()?`\n${tabs.describe()}`:"")
            +(state.crashed?`\n\nThe run stopped early: ${state.crashed}.`
                +"\nEverything collected before that point is in the file above.":"");

        report(summary);

        // the run reached the file, so there is nothing left to resume
        if(!state.crashed) checkpoint.clear();

        // let the download start before the alert blocks the page
        setTimeout(()=>alert(summary+"\nSaved as dice_companies.csv"),0);

    }

    // build the file out of whatever survived the crash
    function salvage(error){

        try{

            if(jobs.length===0){
                alert("Crawl failed before anything was collected: "+(error&&error.message||error));
                return;
            }

            finish({
                companies:buildCompanies(jobs),
                total:0,
                paging:null,
                crashed:(error&&error.message||String(error))
            });

        }
        catch(e){

            console.error(LOG,"could not salvage the run either:",e);

            alert("Crawl failed: "+(error&&error.message||error)+"\nOpen DevTools console for details.");

        }

    }

    //---------------------------------------------------
    // helper: walk the result pages
    //
    // Dice's paginator has no links in it. "Next", "Last" and the page number are <span
    // role="link"> elements the app handles in JavaScript - there is no href anywhere in the nav,
    // so there is nothing to follow and counting ?page= forward is the only way through. That is
    // safe here because ?page=N is a real server-rendered request: the search page arrives with
    // all 30 cards already in the HTML, so the pages are fetched rather than clicked and the walk
    // never touches the live tab.
    //---------------------------------------------------

    async function crawlAllPages(maxPages,total){

        const here=core.paramOf(location.href,"page",ORIGIN)||1;

        // The last page that can hold anything. Two ceilings, and the lower one wins: what the
        // result count implies, and what Dice will actually serve.
        const lastPage=Math.min(total?Math.ceil(total/PAGE_SIZE):PAGE_CAP,PAGE_CAP);

        const limit=maxPages?Math.min(maxPages,lastPage):lastPage;

        // the open page is already rendered and costs no request, so read it whatever happens
        const first=collectFrom(document,here);

        report(`Open page (${here}): +${first.added} job(s), ${jobs.length} total`);

        if(first.cards===0){
            console.warn(LOG,"the open page has no job cards - is this a Dice search results page?");
        }

        // The walk only ever goes FORWARD, so starting wherever the tab happens to sit silently
        // drops every earlier page - a tab left on page 5 loses 120 jobs and the summary says
        // nothing about them. Rewind to page 1 instead; the jobs already in `visited` are deduped
        // on arrival, so the only cost is the requests, not the data.
        rewound=here>1?here-1:0;

        if(rewound) report(`Tab was on page ${here} - rewinding to page 1 so pages 1-${rewound} are not lost...`);

        const start=here>1?pageUrl(1):(here<limit?pageUrl(here+1):"");

        // Dice repeated a page it had already served, which is how it says "that is as deep as I go"
        let repeated=false;

        // the highest page actually read. Claiming the ceiling was reached has to be based on
        // having reached it - a run that was refused at page 9 must not report "stopped at 25".
        let deepest=here;

        const walk=await core.walkPages({

            first:start,

            fetchDoc:(url,opts)=>fetchDoc(url,opts),

            onDoc:async (doc,url)=>{

                const page=core.paramOf(url,"page",ORIGIN)||1;

                const found=collectFrom(doc,page);

                if(page>deepest) deepest=page;

                report(`Page ${page}/${limit}: +${found.added} job(s), ${jobs.length} total`);

                await checkpoint.save({jobs});

                if(found.cards===0){
                    console.warn(LOG,`page ${page} has no job cards - end of the list`);
                    return "stop";
                }

                // A full page that brought nothing new, made of jobs that belong to OTHER pages,
                // is Dice answering a page number past its ceiling by re-sending an earlier list.
                // "Nothing new" on its own is not enough: the rewind re-reads pages on purpose and
                // so does a resumed run, and both must carry on.
                if(found.added===0&&found.elsewhere>0){

                    console.warn(LOG,`page ${page} came back holding jobs already read on other `
                        +"pages - Dice is re-sending an earlier page, which is its end of the list");

                    repeated=true;

                    return "stop";

                }

                return "";

            },

            // There is no next link to read - see the note above this function.
            nextOf:(doc,url)=>{

                const page=core.paramOf(url,"page",ORIGIN)||1;

                return page<limit?pageUrl(page+1):"";

            },

            // The next URL is normally derived from the page just read, so without this one bad
            // moment at page 9 of 25 would throw away everything behind it.
            guessNext:url=>{

                const page=core.paramOf(url,"page",ORIGIN)||1;

                return page<limit?pageUrl(page+1):"";

            },

            // +1 for the page already on screen, which walkPages does not fetch
            maxPages:limit+1,
            report,
            log:LOG

        });

        await checkpoint.save({jobs},true);

        return {
            pages:walk.pages,
            failed:walk.skipped,
            recovered:walk.recovered,
            reason:walk.reason,
            // the ceiling was reached, either by walking into it or by Dice repeating itself
            capped:repeated||deepest>=PAGE_CAP,
            repeated,
            deepest,
            stoppedEarly:walk.reason!=="end"
        };

    }

    // the same search, on a given page number
    function pageUrl(page){

        const url=new URL(location.href);

        url.searchParams.set("page",String(page));

        // strip #hash so two URLs differing only by anchor are not treated as two pages
        return url.origin+url.pathname+url.search;

    }

    //---------------------------------------------------
    // helper: collect the jobs of one page
    //
    // Handles both layouts of the list, because the user's "Group by company" toggle decides which
    // one the live tab is showing and the crawler cannot set it:
    //
    //   off - one <div role="listitem"> per job, company name inside it
    //   on  - one <div role="listitem"> per COMPANY, holding a header and N grouped-job-entry divs
    //
    // Fetched pages are always the ungrouped layout (the toggle is client-side state and never
    // reaches the server), so in practice page 1 can be grouped and pages 2+ never are.
    //---------------------------------------------------

    function collectFrom(root,page){

        const list=root.querySelector(LIST)||root.querySelector(LIST_FALLBACK)||root;

        let cards=0;
        let added=0;
        let dropped=0;
        let elsewhere=0;

        // the entry's position in THIS page's list, so an ad with no identity of its own still
        // gets one. Counted across the whole page rather than per group: with "Group by company"
        // on, a per-group counter would hand two different companies' first ads the same rank.
        let rank=0;

        list.querySelectorAll(GROUP).forEach(group=>{

            const company=readCompany(group);

            // grouped: N entries under one company header. ungrouped: the card IS the entry.
            let entries=[...group.querySelectorAll(ENTRY)];

            if(entries.length===0) entries=[...group.querySelectorAll(CARD)];

            entries.forEach(entry=>{

                cards++;

                const job=readEntry(entry,company,page,rank++);

                // readEntry always returns an id now - see the note there. This counts the ones
                // that had to be invented, because that is a build having renamed the attribute
                // and it is worth saying out loud; it is no longer a job being thrown away.
                if(!job.hasOwnId) dropped++;

                if(visited.has(job.id)){

                    // first seen on a DIFFERENT page -> this page is a copy of one already read,
                    // rather than a page being re-read on purpose. An unknown page (an old
                    // checkpoint) counts as the same page: erring towards carrying on costs one
                    // wasted request, erring the other way costs the rest of the list.
                    const from=visited.get(job.id);

                    if(from&&from!==page) elsewhere++;

                    return;

                }

                visited.set(job.id,page);

                jobs.push(job);

                added++;

            });

        });

        // a card with no identity used to be SKIPPED here, which threw the job away over a missing
        // attribute. It is kept now and identified by its own URL, or failing that by where it sat
        // in the list - but a build that renamed the attribute is still worth one line, because
        // the fallback keys are weaker than the real ones.
        if(dropped){
            console.warn(LOG,`${dropped} of ${cards} card(s) on page ${page} had no job id of their `
                +"own - they were kept and identified by their URL or their place in the list");
        }

        return {cards,added,dropped,elsewhere};

    }

    //---------------------------------------------------
    // helper: the company a listitem belongs to
    // <a href="/company-profile/c9d243fe-...?companyname=Trace3">Trace3</a>
    //---------------------------------------------------

    function readCompany(group){

        const links=[...group.querySelectorAll(COMPANY_LINK)];

        // the logo link comes first and has no text in it, so prefer whichever link is labelled
        const link=links.find(a=>norm(a))||links[0]||null;

        const href=link?link.getAttribute("href")||"":"";

        // /company-profile/<uuid>?companyname=... - the id is a far better grouping key than the
        // name, which Dice writes inconsistently ("Vaco by Highspring" vs "VACO BY HIGHSPRING")
        const id=(href.match(/\/company-profile\/([0-9a-f-]{16,})/i)||[])[1]||"";

        // ?companyname= carries the name even when the link has no text, which is what the logo
        // link is - one less way for a row to end up as "(unknown)"
        let name=norm(group.querySelector(COMPANY_NAME))||norm(link);

        if(!name&&href){

            try{
                name=new URL(href,ORIGIN).searchParams.get("companyname")||"";
            }
            catch(e){}

        }

        return {id,name:name||"(unknown)",url:href?absolute(href):""};

    }

    //---------------------------------------------------
    // helper: read one job entry
    //---------------------------------------------------

    function readEntry(entry,company,page,rank){

        const title=entry.querySelector(TITLE);

        const meta=readMeta(entry);

        const jobUrl=title?absolute(title.getAttribute("href")||""):"";
        const name=norm(title)||(title?title.getAttribute("aria-label")||"":"");

        // data-id is the listing id, data-job-guid the one in the detail URL. Either is unique per
        // ad and that is all `visited` needs, so a build that drops one is survivable.
        //
        // What is NOT survivable is dropping the ad. This used to return "" and the caller threw
        // the whole job away, so one renamed attribute emptied every page - the job was lost over
        // its id. The ad's own URL is the floor under that, and its place in the list the floor
        // under THAT.
        //
        // The last resort deliberately leaves the page number out. Dice answers a page past its
        // 25 page ceiling by re-serving page 25, and the walk only knows that because the ads come
        // back with ids it has already seen; keying on the page would hand every one of them a
        // fresh id, and the run would keep asking for pages that add nothing until the cap.
        const own=entry.getAttribute(JOB_ID)||entry.getAttribute(JOB_GUID)||"";

        return {
            id:own||jobUrl||`${company.name}|${name}|#${rank}`,
            hasOwnId:!!own,
            page,
            title:name,
            company:company.name,
            companyId:company.id,
            companyUrl:company.url,
            location:meta.location,
            mode:meta.mode,
            postedText:meta.posted,
            postedAge:meta.age,
            jobUrl
        };

    }

    //---------------------------------------------------
    // helper: the meta line under a title
    // "Madison, New Jersey • Today" / "Hybrid in Dallas, Texas • 11d ago" / "Remote • 4d ago"
    //
    // Read by position rather than by class: the paragraph carries six Tailwind utilities and no
    // name of its own. Everything with an id or a data-testid is one of the labelled fields
    // (company name, the Easy Apply / employment type / salary badges), so the first anonymous
    // paragraph left over is the location line.
    //---------------------------------------------------

    function readMeta(entry){

        let text="";

        for(const p of entry.querySelectorAll("p")){

            if(p.getAttribute("id")||p.getAttribute("data-testid")) continue;

            text=norm(p);

            if(text) break;

        }

        const parts=text.split(BULLET).map(part=>part.trim()).filter(Boolean);

        let where="";
        let posted="";

        if(parts.length>1){
            where=parts.slice(0,-1).join(" ");
            posted=parts[parts.length-1];
        }
        else if(parts.length===1){
            // one half of the line is missing: a date is recognisable, anything else is the place
            if(WHEN.test(parts[0])) posted=parts[0];
            else where=parts[0];
        }

        return {
            location:readLocation(where),
            mode:readMode(where),
            posted,
            age:postedAge(posted)
        };

    }

    // "Hybrid in Dallas, Texas" -> "Dallas, Texas". "No location provided" is not a place, and
    // "Remote" on its own is kept as written because it is the only location the ad gives.
    function readLocation(where){

        if(!where||NO_LOCATION.test(where)) return "";

        return where.replace(HYBRID,"").replace(REMOTE_OR,"");

    }

    // Dice states the work model in the location field itself and nowhere else, which is why there
    // is no detail request behind this column: "Remote" on its own, "Hybrid in <city>", or a plain
    // city, which is on site. A job with no location declared gets nothing rather than a guess.
    function readMode(where){

        if(!where||NO_LOCATION.test(where)) return "";

        if(HYBRID.test(where)) return "Hybrid";
        if(REMOTE.test(where)||REMOTE_OR.test(where)) return "Remote";

        return "Onsite";

    }

    // "Today" -> 0, "3d ago" -> 4320, "30+ days ago" -> 43200. Only used to pick a company's
    // newest listing, so a value that cannot be read sorts last rather than first.
    function postedAge(text){

        const value=String(text||"");

        if(/^\s*today\b/i.test(value)) return 0;
        if(/^\s*yesterday\b/i.test(value)) return UNIT.d;

        const match=value.match(AGE);

        if(!match) return Infinity;

        const unit=match[2].toLowerCase();

        return +match[1]*(UNIT[unit]||UNIT[unit[0]]||1);

    }

    function absolute(href){

        if(!href) return "";

        try{
            return new URL(href,ORIGIN).toString();
        }
        catch(e){
            return "";
        }

    }

    //---------------------------------------------------
    // helper: group jobs by company
    //---------------------------------------------------

    function buildCompanies(list){

        const map=new Map();

        // The company profile id when there is one - the same employer written two ways still
        // lands on one row. Without an id, core.nameKey folds case, punctuation and legal-form
        // suffixes, so "Vaco by Highspring" and "Vaco By Highspring, Inc." do not become two rows
        // each holding a slice of the positions.
        //
        // core.companyKeys is what makes the two agree. Whether the logo link rendered is a
        // property of the CARD, so the same employer arrives with an id on one page and without on
        // the next, and keying each ad on its own gave it "id:c9d2..." and "name:vaco" - two rows,
        // which is the duplicate the folded name is there to prevent.
        const keyOf=core.companyKeys(list,job=>job.companyId,job=>job.company);

        for(const job of list){

            const key=keyOf(job);

            let company=map.get(key);

            if(!company){

                company={
                    key,
                    name:job.company||"(unknown)",
                    jobs:0,
                    locations:[],
                    positions:[],
                    modes:[],
                    posted:"",
                    postedAge:Infinity,
                    companyUrl:job.companyUrl,
                    // Dice publishes no headcount anywhere reachable - see the note in step 4
                    employees:""
                };

                map.set(key,company);

            }

            company.jobs++;

            keep(company.positions,job.title);
            push(company.locations,job.location);
            push(company.modes,job.mode);

            // the newest listing is the one the "Recruitment time" column reports
            if(job.postedAge<company.postedAge){
                company.postedAge=job.postedAge;
                company.posted=job.postedText;
            }

            if(!company.companyUrl&&job.companyUrl) company.companyUrl=job.companyUrl;

        }

        // most listings first, then alphabetically on a tie
        return [...map.values()].sort((a,b)=>b.jobs-a.jobs||a.name.localeCompare(b.name));

    }

    function push(list,value){
        if(value&&!list.includes(value)) list.push(value);
    }

    // Positions is one entry per JOB, not per distinct title.
    //
    // push() was used here too, and it drops a value the list already holds - so a company running
    // four separate "Software Engineer" ads reached the file as one position and read as though it
    // were hiring for one. The Location and Remote/Onsite columns keep using push(), because those
    // describe the company and really are a set: "Dallas, Dallas, Dallas" is noise, "Software
    // Engineer | Software Engineer | Software Engineer" is three jobs.
    //
    // A job whose title could not be read is still a job, so it is marked rather than dropped -
    // the number of entries in the cell always equals the number of ads behind the row.
    function keep(list,value){
        list.push(value||"(untitled)");
    }

    //---------------------------------------------------
    // helper: the result count the page declares
    // <p>11850 results (653 new)</p>
    //---------------------------------------------------

    function readTotal(doc){

        for(const p of doc.querySelectorAll("p")){

            const match=norm(p).match(TOTAL);

            if(match) return +match[1].replace(/,/g,"")||0;

        }

        return 0;

    }

})();
