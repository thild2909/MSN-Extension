(async()=>{

    const LOG="[foundit-crawler]";
    const ORIGIN=location.origin;

    //---------------------------------------------------
    // guard against double runs when the button is clicked repeatedly
    //---------------------------------------------------

    if(window.__founditCrawlerRunning){
        alert("Crawler is already running on this tab. Wait for it to finish.");
        return;
    }

    window.__founditCrawlerRunning=true;

    const core=window.CrawlerCore;

    if(!core){

        alert("core.js is not loaded in this tab. popup.js must inject core.js before content.js.");

        window.__founditCrawlerRunning=false;

        return;

    }

    //---------------------------------------------------
    // where the jobs actually are
    //
    // foundit is a Next.js app and its search page comes in two completely different shapes,
    // decided by whether the URL carries a query string:
    //
    //   /search/data-engineer-jobs                  server-rendered. 20 cards in the HTML, and the
    //                                               whole search API response in the RSC payload.
    //   /search/data-engineer-jobs?query=data...    a shimmer skeleton. Zero cards, zero data - the
    //                                               list is fetched by the browser after load.
    //
    // Both render identically once the tab has run them, which is why the second shape is the URL a
    // person ends up on and copies. It is also why every page past the open one is fetched from the
    // FIRST shape: a fetched skeleton contains nothing at all.
    //
    // Page N of the server-rendered form is the same path with "-N" on the end. Measured on two
    // searches: 465 results -> pages 1..24, page 25 answers 307; 3,722 results -> pages 1..187,
    // page 188 answers 307. There is no depth ceiling of the kind Dice has - foundit serves the
    // whole list.
    //---------------------------------------------------

    // the results column, and the SEO link farm that follows it (~200KB of pills, no jobs)
    const LIST='id="middleSection"';
    const LIST_END='id="seoSearchBtmLayoutContainer"';

    const CARD=".jobCardWrapper";
    const TITLE=".jobCardTitle";
    const TITLE_LINK=".jobCardTitle a";
    const COMPANY=".jobCardCompany";
    const COMPANY_LINK='a[href*="-jobs-career"]';
    const LOCATION=".jobCardLocation";

    // "Showing 465 results For Data Engineer Jobs" - only ever read off this element, never off a
    // regex run over the page, so a job description that says "465 results" cannot become a total
    const COUNT=".searchPageResultsCount";
    const TOTAL=/([\d,]+)\s*results\b/i;

    // /search/plaza-premium-group-675550-jobs-career -> 675550. The one stable identity an employer
    // has here: foundit writes the same company's name several ways across ads.
    const COMPANY_ID=/-(\d{3,})-jobs-career\b/;

    // https://www.foundit.my/job/senior-data-engineer-plaza-premium-group-malaysia-62308220
    const JOB_ID=/-(\d{5,})(?:[/?#]|$)/;

    // the pager: <button ...>Next</button>, carrying disabled="" on the last page. There is no href
    // on it and the number links only ever span 1..10 whatever page you are on, so the walk counts
    // "-N" forward and uses the pager purely as a second opinion about where the list ends.
    const PAGER=".pagination";

    // "Posted a day ago" / "Posted 5 days ago". Rendered by the browser, so it exists on the open
    // tab and never on a fetched page - which is why the sheet takes its dates from postedAt in the
    // payload and only falls back to this wording.
    const POSTED=/^\s*posted\b/i;
    const AGE=/(\d+)\s*(minute|hour|day|week|month|year|min|hr|h|d|w|mo|y)s?\s+ago/i;
    const UNIT={min:1,minute:1,h:60,hr:60,hour:60,d:1440,day:1440,w:10080,week:10080,mo:43200,month:43200,y:525600,year:525600};

    const DAY=86400000;

    // foundit puts 20 jobs on a results page. meta.paging.limit says so on every page read so far;
    // this is only the value used before the first page has been read.
    const PAGE_SIZE=20;

    // Only used when the result count cannot be read at all. The walk stops on its own signals well
    // before this (an empty page, a repeated page, a pager that says it is the last one); this is
    // the backstop that keeps a broken count from turning into an unbounded run.
    const MAX_PAGES=1000;

    // Where the whole search API response is parked in the server-rendered page: every job with its
    // company id, its locations and postedAt, which is more than the cards themselves carry.
    const PAYLOAD_KEY='"jobSearchAPIData":';
    const PUSH=/self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g;

    // where sliceSearch() parks the payload it lifted out, so the parse happens once. Read back as
    // an attribute selector rather than "#id": identical in a browser, and the fixtures' selector
    // engine understands one and not the other.
    const HOLDER="founditPayloadHolder";
    const HOLDER_SELECTOR='[id="founditPayloadHolder"]';

    // Query parameters that do NOT change which jobs the search returns. Anything else in the URL
    // is a filter, and filters are the one thing this crawler cannot carry: they only exist on the
    // client-rendered shape of the page, and every page it fetches is the server-rendered one. A
    // filtered tab would otherwise produce a file that is page 1 of the user's search followed by
    // pages 2..N of a different, wider one.
    const HARMLESS=/^(query|queryDerived|searchId|resultId|sort|start|limit|txtKeywords|utm_[a-z_]+|gclid|fbclid|ref|src)$/i;

    // The pace floor is zero: nothing is paid until foundit actually pushes back. See _shared/core.js.
    const MIN_GAP=0;

    const gate=core.makeGate({minGap:MIN_GAP,limit:4,log:LOG});

    const fetcher=core.makeFetcher(gate,{
        log:LOG,
        // Two refusals in a row are answered by a real navigation rather than the rest of the retry
        // ladder - but only while there is a tab left to open.
        canEscalate:()=>tabs.available
    });

    const jobs=[];

    // job id -> the results page it was first seen on. A Set would dedupe just as well, but it
    // could not tell the two reasons a page brings nothing new apart: a page read twice on purpose
    // (the open tab overlapping page 1, a resumed run), which must not stop the walk, versus
    // foundit answering a page past the end with a 307 back to page 1, which must.
    const visited=new Map();

    // document -> its parsed payload (or null). Keyed on the document rather than the URL because
    // the open tab is a document with no URL of its own as far as this crawler is concerned.
    const PARSED=new WeakMap();

    const startedAt=performance.now();

    const report=core.makeReporter("foundit-crawler-status",LOG);

    // Akamai sits in front of foundit and tells a content script's fetch apart from a navigation:
    // the same URL that answers 200 in a tab answers 403 to a fetch that looks even slightly thin.
    // `extract` names the part of the page the DOM reader wants, so a rescued page comes back as
    // ~150KB of list rather than a 2MB document that is mostly the app's own JSON.
    const tabs=core.makeTabFallback({
        log:LOG,
        report,
        lastStatus:fetcher.lastStatus,
        extract:["#middleSection"],
        describe:url=>"page "+pageOf(url)
    });

    const fetchDoc=(url,opts)=>core.tabFirst(fetcher,tabs,url,
        Object.assign({slice:sliceSearch,sliced:hasContent},opts||{}));

    const norm=core.norm;

    // A tab navigation kills the content script outright - no catch block runs and nothing is
    // written. The checkpoint turns that from "the whole run is gone" into "the next run starts
    // where this one stopped".
    const checkpoint=core.makeCheckpoint("founditCheckpoint",{log:LOG});

    // set the moment the file is handed to the browser, so the crash path can never write a second one
    let fileWritten=false;

    let resumed=0;

    // the search path with any "-N" stripped: every page URL is built off this
    const base=basePath(location.pathname);

    // /search/... is what a foundit search looks like, and popup.js already refuses to inject
    // anywhere else. This is the second opinion, and it is only ever a reason to stop when the page
    // ALSO has no job cards on it - a URL shape is a weaker fact than a page full of ads.
    const looksLikeSearch=/^\/search\//.test(location.pathname||"");

    // filters in the URL that the fetched pages cannot carry - see HARMLESS above
    const filters=filterParams(location.search);

    // how many jobs the payload answered for, against how many the DOM had to answer for on its
    // own. Only the payload carries a company id and a posting date, so this is the difference
    // between a full sheet and one with two more empty columns.
    let fromPayload=0;
    let fromCards=0;

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

        if(!looksLikeSearch){

            if(!document.querySelector(CARD)){

                alert("This does not look like a foundit search results page.\n\n"
                    +"Open something like https://www.foundit.my/search/data-engineer-jobs and run again.");

                return;

            }

            console.warn(LOG,`${location.pathname} is not a /search/ URL, but it has job cards on `
                +"it - reading it, and paging off this path");

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

        if(saved&&Array.isArray(saved.jobs)&&saved.jobs.length&&saved.base===base){

            for(const job of saved.jobs){

                if(!job||!job.id||visited.has(job.id)) continue;

                visited.set(job.id,job.page||0);
                jobs.push(job);
                resumed++;

            }

            report(`Resumed ${resumed} job(s) from an unfinished run on this search.`);

        }

        //---------------------------------------------------
        // 2. read the page already on screen, then walk the whole list
        //---------------------------------------------------

        // The open tab is read only when its URL carries no filters. A filtered tab shows a search
        // this crawler cannot reproduce on the pages it fetches, and mixing the two would put one
        // page of the user's search and twenty pages of a different one into the same file.
        const open=filters.length?{cards:0,added:0}:collectFrom(document,pageOf(location.href));

        if(filters.length){

            console.warn(LOG,"the open tab is filtered by "+filters.join(", ")
                +" - reading the unfiltered search instead");

        }
        else if(open.cards){
            report(`Open page: +${open.added} job(s) already on screen`);
        }

        const total=readTotal(document);

        if(total) console.log(LOG,`foundit advertises ${total} job(s) for this search`);
        else console.warn(LOG,"could not read the result count off the open page");

        // Ask now, while nothing is on fire. A worker that turns out to be unreachable at page 40
        // has already cost the run the minutes it took to get there.
        if(await tabs.ready()) console.log(LOG,"tab fallback is ready");

        const paging=await crawlAllPages(maxPages,total);

        console.log(LOG,`${paging.pages} page(s) read -> ${jobs.length} jobs`
            +(paging.stoppedEarly?" (stopped early)":""));

        if(jobs.length===0){

            alert("No job cards found. Open a foundit search results page (for example "
                +"https://www.foundit.my/search/data-engineer-jobs) and run again.");

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
        // There is no detail phase, on purpose. Company name, title, location and the posting date
        // are all on the results page. The two columns that stay empty have no source anywhere on
        // foundit: there is no headcount field on a card, in the search payload, on a job page or
        // in any of the fifteen search facets the site offers, and there is no work-model field
        // either - no remote/hybrid/on-site value, and no facet to filter by one. Opening a page
        // per company would cost hundreds of requests to fill in nothing.
        //---------------------------------------------------

        finish({companies,total,paging,crashed:null});

    }
    catch(e){

        console.error(LOG,"crawl aborted:",e);

        // Everything collected up to the crash is real data. Throwing it away because the last step
        // failed is the single most expensive thing a crawler can do.
        salvage(e);

    }
    finally{

        window.__founditCrawlerRunning=false;

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
            filename:"foundit_companies.csv",
            log:LOG
        });

        const withTime=results.filter(r=>r["Recruitment time"]).length;
        const elapsed=Math.round((performance.now()-startedAt)/1000);

        const paging=state.paging||{pages:0,failed:0,recovered:0,reason:"end",repeated:false,deepest:0};

        // "Done" on its own reads as "that was all of it", which is exactly wrong when the walk was
        // cut short: the file then looks complete while most of the search is missing.
        const problems=[

            "Employees and Remote/Onsite are always blank: foundit publishes neither. There is no "
                +"headcount on a card, in the search payload, on a job page or in any of its search "
                +"facets, and no work-model field either - so there is nothing to read.",

            filters.length?`The open tab was filtered by ${filters.join(", ")}. Those filters only `
                +"exist on the browser-rendered page, and every page after the first is fetched as "
                +"the plain search, so the file is the UNFILTERED search. Use foundit's own search "
                +"terms (or a /search/<something>-jobs URL) to narrow it instead.":"",

            fromCards&&fromPayload?`${fromCards} of ${fromCards+fromPayload} job(s) were read off the `
                +"cards alone - those carry no company id and no posting date, so they group by name "
                +"and have no recruitment time.":"",

            fromCards&&!fromPayload?"Every job was read off the cards alone: foundit's search payload "
                +"was not where this crawler expects it, so company ids and posting dates are "
                +"missing. The page layout has probably changed.":"",

            paging.recovered?`${paging.recovered} page(s) were recovered on the second pass.`:"",

            paging.failed?`${paging.failed} page(s) could not be read at all - those jobs are missing.`:"",

            paging.repeated?`Stopped at page ${paging.deepest}: foundit sent back a page it had `
                +"already served, which is how it answers a page number past the end of the list.":"",

            paging.reason==="blocked"
                ? "foundit stopped serving results part way through - that is a refusal, not the end "
                    +"of the list. Wait a few minutes and run again, or lower 'parallel'."
                :"",

            paging.reason==="limit"?"Stopped at the max pages limit - there are more results.":"",

            written.clipped?`${written.clipped} cell(s) truncated to fit Excel's 32,767 character limit.`:""

        ].filter(Boolean);

        // Say the gap out loud. "300 jobs" reads like a complete run until it is put next to the
        // 465 foundit advertises.
        const coverage=state.total
            ? ` of the ${state.total} foundit reports`
                +(jobs.length<state.total?` - ${state.total-jobs.length} NOT READ`:" - complete")
            :"";

        const summary=`Done in ${elapsed}s: ${results.length} companies from ${jobs.length} jobs`
            +coverage
            +` over ${paging.pages} page(s), ${withTime} with recruitment time.`
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
        setTimeout(()=>alert(summary+"\nSaved as foundit_companies.csv"),0);

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
    // Page 1 is fetched even when the tab is already showing it. The tab may be the browser-rendered
    // shape of the search, whose ordering is its own, so treating what is on screen as "page 1 done"
    // would skip whatever the server-rendered page 1 holds instead. One extra request buys the
    // guarantee; the jobs that overlap are deduped on arrival.
    //---------------------------------------------------

    async function crawlAllPages(maxPages,total){

        // What the result count implies. foundit serves every page of it - there is no equivalent
        // of Dice's 25 page ceiling here - so this is the real end of the list, and MAX_PAGES only
        // stands in when the count could not be read at all.
        const last=total?Math.ceil(total/PAGE_SIZE):MAX_PAGES;

        const limit=maxPages?Math.min(maxPages,last):last;

        // A run where every page needs a tab is the normal bad day behind Akamai, so the budget has
        // to be the size of the run rather than the default sized for a rare rescue. Capped,
        // because `limit` is MAX_PAGES when the result count could not be read and a budget of two
        // thousand tab loads is not a budget.
        tabs.setBudget(Math.min(400,Math.max(80,limit*2)));

        // foundit answered with a page it had already served, which is how it says "past the end"
        let repeated=false;

        // the highest page actually read
        let deepest=0;

        const walk=await core.walkPages({

            first:pageUrl(1),

            fetchDoc:(url,opts)=>fetchDoc(url,opts),

            onDoc:async (doc,url)=>{

                const page=pageOf(url);

                const found=collectFrom(doc,page);

                if(page>deepest) deepest=page;

                report(`Page ${page}/${limit}: +${found.added} job(s), ${jobs.length} total`);

                await checkpoint.save({base,jobs});

                if(found.cards===0){
                    console.warn(LOG,`page ${page} has no job cards - end of the list`);
                    return "stop";
                }

                // A full page that brought nothing new, made of jobs that belong to OTHER pages, is
                // foundit answering a page number past the end: it redirects to page 1 rather than
                // 404ing, so the request succeeds and the list looks real. "Nothing new" on its own
                // is not enough - the open tab overlaps page 1 on purpose, and so does a resumed
                // run, and both must carry on.
                if(found.added===0&&found.elsewhere>0){

                    console.warn(LOG,`page ${page} came back holding jobs already read on other `
                        +"pages - foundit is re-sending an earlier page, which is its end of the list");

                    repeated=true;

                    return "stop";

                }

                return "";

            },

            nextOf:(doc,url)=>{

                const page=pageOf(url);

                if(page>=limit) return "";

                // the pager is a second opinion, not the primary one: its number links only ever
                // span 1..10, but "Next" does carry disabled="" on the last page
                if(atLastPage(doc)){
                    console.log(LOG,`page ${page} is the last one according to the pager`);
                    return "";
                }

                return pageUrl(page+1);

            },

            // The next URL is normally derived from the page just read, so without this one bad
            // moment at page 9 of 24 would throw away everything behind it: the page is stepped
            // over, remembered, and retried once the walk is done.
            //
            // Deliberately NOT the "end" answer some crawlers here give past their last page. The
            // walk never asks for a page beyond `limit`, and every page up to it exists - foundit
            // serves its whole list - so a page that did not come back is a refusal and has to be
            // reported as one. Answering "end" would file the last page of a search failing under
            // "that was all of it".
            guessNext:url=>{

                const page=pageOf(url);

                return page<limit?pageUrl(page+1):"";

            },

            // walkPages counts the first page as already read, so the budget is one over the last
            // page number it may ask for
            maxPages:limit+1,
            report,
            log:LOG

        });

        await checkpoint.save({base,jobs},true);

        return {
            pages:walk.pages,
            failed:walk.skipped,
            recovered:walk.recovered,
            reason:walk.reason,
            repeated,
            deepest,
            stoppedEarly:walk.reason!=="end"
        };

    }

    // /search/data-engineer-jobs, /search/data-engineer-jobs-7 -> /search/data-engineer-jobs
    function basePath(pathname){

        const path=String(pathname||"").replace(/\/+$/,"")||"/";

        // a search slug never ends in a number of its own ("...-jobs", "jobs-in-penang"), so a
        // trailing "-<digits>" is the page number and nothing else
        return path.replace(/-\d{1,4}$/,"");

    }

    function pageUrl(page){
        return ORIGIN+base+(page>1?"-"+page:"");
    }

    function pageOf(url){

        try{

            const path=new URL(url,ORIGIN).pathname.replace(/\/+$/,"");

            const match=path.match(/-(\d{1,4})$/);

            return match?+match[1]:1;

        }
        catch(e){
            return 1;
        }

    }

    // which query parameters would change the result set - see HARMLESS
    function filterParams(search){

        const names=[];

        try{

            new URLSearchParams(search||"").forEach((value,name)=>{

                if(value&&!HARMLESS.test(name)&&names.indexOf(name)<0) names.push(name);

            });

        }
        catch(e){}

        return names;

    }

    //---------------------------------------------------
    // helper: cut the page down before parsing it
    //
    // A foundit search page is ~2MB and the results are perhaps 8% of it: the rest is the RSC
    // payload (which carries every job description in full) and the SEO link farm underneath the
    // list. DOMParser runs on the crawl's own main thread - a content script has no worker to hand
    // it to - so at parallel 4 the parses queue rather than overlap, and the parse rather than the
    // network is what a wide run waits on.
    //
    // The payload is lifted here rather than parsed later because it does not survive the cut: it
    // lives in script tags at the very bottom of the document, split across ~340 push() calls.
    //
    // "" rather than null when neither marker is there: null tells core "this page has been read
    // and does not carry it", which would make a 200-with-a-bot-check indistinguishable from the
    // end of the list. "" falls through to parsing the whole page, which is what an unrecognised
    // page deserves.
    //---------------------------------------------------

    function sliceSearch(html){

        const raw=payloadRaw(html);
        const cards=cardsRegion(html);

        if(!raw&&!cards) return "";

        return (raw?'<div id="'+HOLDER+'" data-json="'+escapeAttr(raw)+'"></div>':"")+cards;

    }

    // did the cut actually land - if not, the whole page is parsed as before and nothing is lost
    function hasContent(doc){
        return !!doc.querySelector(HOLDER_SELECTOR)||!!doc.querySelector(CARD);
    }

    function cardsRegion(html){

        const at=html.indexOf(LIST);

        if(at<0) return "";

        // back up to the start of the tag carrying the marker, so the cut never begins mid-attribute
        const open=html.lastIndexOf("<div",at);

        const end=html.indexOf(LIST_END,at);

        return html.slice(open<0?at:open,end<0?html.length:end);

    }

    function escapeAttr(text){
        return text.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;");
    }

    //---------------------------------------------------
    // helper: the search API response the page was rendered from
    //
    // Next.js streams it as a series of self.__next_f.push([1,"<chunk>"]) calls whose chunks are
    // split at arbitrary points - a job record routinely straddles two of them - so the chunks are
    // JSON.parsed back into strings and joined before anything is looked for. Every field the sheet
    // needs beyond the card text is in here and only in here: the company id, and postedAt.
    //---------------------------------------------------

    function payloadRaw(text){

        const flat=flightText(text);

        if(!flat) return "";

        const at=flat.indexOf(PAYLOAD_KEY);

        if(at<0) return "";

        const start=flat.indexOf("{",at+PAYLOAD_KEY.length);

        if(start<0) return "";

        return balanced(flat,start);

    }

    function flightText(text){

        const parts=[];

        let match;

        // .exec on a /g regex is stateful, and this function is called once per page
        PUSH.lastIndex=0;

        while((match=PUSH.exec(text))){

            try{
                parts.push(JSON.parse(match[1]));
            }
            catch(e){}

        }

        return parts.join("");

    }

    // the object or array starting at `from`, string literals respected. A brace counter that does
    // not skip strings stops early on the first "}" inside a job description, and every foundit
    // record carries one.
    function balanced(text,from){

        const open=text[from];
        const close=open==="{"?"}":"]";

        let depth=0;
        let inString=false;
        let escaped=false;

        for(let i=from;i<text.length;i++){

            const ch=text[i];

            if(inString){

                if(escaped) escaped=false;
                else if(ch==="\\") escaped=true;
                else if(ch==='"') inString=false;

                continue;

            }

            if(ch==='"'){
                inString=true;
                continue;
            }

            if(ch===open) depth++;
            else if(ch===close&&!--depth) return text.slice(from,i+1);

        }

        return "";

    }

    // the payload of an already-parsed document: the holder sliceSearch() left behind, or - for the
    // open tab and for a page rescued through a real navigation - the script tags themselves
    function readPayload(doc){

        // Every page is asked for its payload at least twice - once for the jobs, once to ask
        // whether it is the last page - and the answer is 100KB of JSON. Parsing it once per page
        // rather than once per question is the difference between a cost and a habit.
        if(PARSED.has(doc)) return PARSED.get(doc);

        const holder=doc.querySelector(HOLDER_SELECTOR);

        const raw=holder
            ?holder.getAttribute("data-json")||""
            :payloadRaw([...doc.querySelectorAll("script")].map(node=>node.textContent||"").join("\n"));

        let payload=null;

        if(raw){

            try{
                payload=JSON.parse(raw);
            }
            catch(e){
                console.warn(LOG,"the search payload was there but would not parse",e);
            }

        }

        PARSED.set(doc,payload);

        return payload;

    }

    //---------------------------------------------------
    // helper: collect the jobs of one page
    //
    // Two readers over the same page, because they fail in different places. The payload has every
    // field and is gone the moment foundit changes how it ships its data; the cards have no company
    // id and no date but are what the page IS, and they are all a tab-rescued page comes back with.
    // Whichever answers, the job is read once - they are merged on the job id.
    //---------------------------------------------------

    function collectFrom(root,page){

        const payload=readPayload(root);

        const rows=payload&&Array.isArray(payload.data)?payload.data:[];

        let cards=0;
        let added=0;
        let elsewhere=0;
        let unnamed=0;

        const seen=new Set();

        const take=(job,source)=>{

            if(!job) return;

            seen.add(job.id);

            cards++;

            if(visited.has(job.id)){

                // first seen on a DIFFERENT page -> this page is a copy of one already read, rather
                // than a page being read twice on purpose. An unknown page (an old checkpoint)
                // counts as the same page: erring towards carrying on costs one wasted request,
                // erring the other way costs the rest of the list.
                const from=visited.get(job.id);

                if(from&&from!==page) elsewhere++;

                return;

            }

            visited.set(job.id,page);

            jobs.push(job);

            added++;

            // counted on the way IN, not per row read: a page re-read on purpose would otherwise
            // report its jobs twice and the summary's "read off the cards alone" would drift
            if(source==="payload") fromPayload++;
            else fromCards++;

            if(!job.hasOwnId) unnamed++;

        };

        for(const row of rows){
            take(readRow(row,page),"payload");
        }

        // Cards the payload did not account for. On a server-rendered page there are none - the
        // page was rendered FROM the payload - so this is the path a rescued page and a changed
        // layout both take.
        let rank=0;

        for(const card of root.querySelectorAll(CARD)){

            const job=readCard(card,page,rank++);

            if(!job||seen.has(job.id)) continue;

            take(job,"cards");

        }

        if(unnamed){
            console.warn(LOG,`${unnamed} of ${cards} card(s) on page ${page} had no job id of their `
                +"own - they were kept and identified by their URL or their place in the list");
        }

        return {cards,added,elsewhere};

    }

    //---------------------------------------------------
    // helper: one job out of the search payload
    //---------------------------------------------------

    function readRow(row,page){

        if(!row) return null;

        const id=String(row.jobId||row.id||"");

        if(!id) return null;

        const company=row.company||{};

        // locations arrive as [{country:"Malaysia"},{city:"Kuala Lumpur",country:"Malaysia"}] and
        // the card renders them in that order, city where there is one - "Malaysia, Kuala Lumpur"
        const places=[];

        for(const place of [].concat(row.locations||[])){

            const name=String((place&&(place.city||place.country))||"").trim();

            if(name&&places.indexOf(name)<0) places.push(name);

        }

        const posted=+row.postedAt||+row.createdAt||0;

        return {
            id,
            hasOwnId:true,
            page,
            title:String(row.title||"").trim(),
            company:String(company.name||row.companyName||"").trim()||"(unknown)",
            companyId:company.companyId?String(company.companyId):"",
            companyUrl:"",
            location:places.join(", "),
            mode:modeOf(places.join(", ")),
            postedText:postedWords(posted),
            postedAge:posted?Math.max(0,(Date.now()-posted)/60000):Infinity,
            jobUrl:String(row.jdUrl||"")
        };

    }

    //---------------------------------------------------
    // helper: one job card, read off the page itself
    //---------------------------------------------------

    function readCard(card,page,rank){

        const link=card.querySelector(TITLE_LINK);

        const heading=card.querySelector(TITLE);

        // the <a> holds the title in spans broken up by the search-term highlight, so the heading's
        // own title="" attribute is the clean copy of it
        const title=(heading&&heading.getAttribute("title"))
            ||(link&&link.getAttribute("aria-label"))
            ||norm(link)
            ||"";

        const jobUrl=link?absolute(link.getAttribute("href")||""):"";

        const own=(jobUrl.match(JOB_ID)||[])[1]||"";

        const nameEl=card.querySelector(COMPANY);
        const profile=card.querySelector(COMPANY_LINK);

        const company=norm(nameEl)||"(unknown)";

        // the career link only renders in the browser, so this is filled in on the open tab and
        // empty on a fetched page - which is exactly what core.companyKeys() is built to reconcile
        const companyId=profile?((profile.getAttribute("href")||"").match(COMPANY_ID)||[])[1]||"":"";

        const location=norm(card.querySelector(LOCATION));

        const posted=postedOn(card);

        // An unreadable id is not a lost job. The ad's own URL is the floor under the id, and its
        // place in the list the floor under that - never the page number on its own, because pages
        // are re-read on purpose and a page-based key would hand one ad a new identity each time.
        return {
            id:own||jobUrl||`${company}|${title}|#${rank}`,
            hasOwnId:!!own,
            page,
            title,
            company,
            companyId,
            companyUrl:profile?absolute(profile.getAttribute("href")||""):"",
            location,
            mode:modeOf(location),
            postedText:posted.text,
            postedAge:posted.age,
            jobUrl
        };

    }

    // "Posted a day ago" sits in a <label> under the card with nothing but a utility class on it,
    // so it is found by what it says rather than by where it is
    function postedOn(card){

        for(const label of card.querySelectorAll("label")){

            const text=norm(label);

            if(!POSTED.test(text)) continue;

            return {text,age:agedMinutes(text)};

        }

        return {text:"",age:Infinity};

    }

    function agedMinutes(text){

        const value=String(text||"");

        if(/\b(today|just now|a few (seconds|minutes))\b/i.test(value)) return 0;
        if(/\ba day ago\b/i.test(value)) return UNIT.d;

        const match=value.match(AGE);

        if(!match) return Infinity;

        return +match[1]*(UNIT[match[2].toLowerCase()]||1);

    }

    // foundit's own wording, so a run that read the date off the payload and one that read it off
    // the card do not produce two different vocabularies in the same column
    function postedWords(ms){

        if(!ms) return "";

        const days=Math.floor((Date.now()-ms)/DAY);

        if(days<=0) return "Posted today";
        if(days===1) return "Posted a day ago";

        return `Posted ${days} days ago`;

    }

    // foundit has no work-model field: not on the card, not in the search payload, not on a job
    // page, and there is no facet to filter by one. The only time it says anything at all is when
    // the location itself IS the answer, so that is the only time this writes anything. A city is
    // not evidence of an office, and "Onsite" inferred from one would be indistinguishable in the
    // file from a value the site actually published.
    function modeOf(location){
        return /\b(remote|work\s*from\s*home)\b/i.test(String(location||""))?"Remote":"";
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
    // helper: is this the last page
    //
    // Two answers, either of which is enough. The payload stops advertising a next cursor, and the
    // pager's "Next" button carries disabled="". The number links are no help - they span 1..10 on
    // every page of a 187 page search.
    //---------------------------------------------------

    function atLastPage(doc){

        const payload=readPayload(doc);

        const paging=payload&&payload.meta&&payload.meta.paging;

        if(paging&&paging.cursors&&!paging.cursors.next) return true;

        const pager=doc.querySelector(PAGER);

        if(!pager) return false;

        for(const button of pager.querySelectorAll("button")){

            if(!/^next$/i.test(norm(button))) continue;

            return !!(button.disabled||button.getAttribute("disabled")!==null);

        }

        return false;

    }

    //---------------------------------------------------
    // helper: group jobs by company
    //---------------------------------------------------

    function buildCompanies(list){

        const map=new Map();

        // The company id when there is one - the same employer written two ways still lands on one
        // row. Without an id, core.nameKey folds case, punctuation and legal-form suffixes, so
        // "CSI Interfusion" and "CSI Interfusion Sdn Bhd" do not become two rows each holding a
        // slice of the positions.
        //
        // core.companyKeys is what makes the two agree, and foundit needs it more than most: the id
        // is in the payload and in the browser-rendered career link, and in neither the cards of a
        // page rescued through a tab - so within one run the same employer arrives both ways.
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
                    // foundit publishes no headcount anywhere - see the note in step 4
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
    // push() drops a value the list already holds, so a company running four separate "Data
    // Engineer" ads would reach the file as one position and read as though it were hiring for one.
    // foundit is full of agencies doing exactly that. The Location and Remote/Onsite columns keep
    // using push(), because those describe the company and really are a set.
    //
    // A job whose title could not be read is still a job, so it is marked rather than dropped - the
    // number of entries in the cell always equals the number of ads behind the row.
    function keep(list,value){
        list.push(value||"(untitled)");
    }

    //---------------------------------------------------
    // helper: the result count the page declares
    // "Showing 465 results For Data Engineer Jobs"
    //---------------------------------------------------

    function readTotal(doc){

        const payload=readPayload(doc);

        const paging=payload&&payload.meta&&payload.meta.paging;

        if(paging&&+paging.total) return +paging.total;

        for(const el of doc.querySelectorAll(COUNT)){

            const match=norm(el).match(TOTAL);

            if(match) return +match[1].replace(/,/g,"")||0;

        }

        return 0;

    }

})();
