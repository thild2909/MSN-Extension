(async()=>{

    const LOG="[stepstone-crawler]";
    const ORIGIN=location.origin;

    //---------------------------------------------------
    // guard against double runs when the button is clicked repeatedly
    //---------------------------------------------------

    if(window.__stepstoneCrawlerRunning){
        alert("Crawler is already running on this tab. Wait for it to finish.");
        return;
    }

    window.__stepstoneCrawlerRunning=true;

    const core=window.CrawlerCore;

    if(!core){

        alert("core.js is not loaded in this tab. popup.js must inject core.js before content.js.");

        window.__stepstoneCrawlerRunning=false;

        return;

    }

    // StepStone hashes its class names per build (res-1uzl2mp) -> rely only on data-at / data-testid.
    const CARD='article[data-at="job-item"], article[data-testid="job-item"]';
    const TITLE='[data-at="job-item-title"]';
    const COMPANY='[data-at="job-item-company-name"]';
    const LOCATION='[data-at="job-item-location"]';
    const WFH='[data-at="job-item-work-from-home"]';
    const POSTED='[data-at="job-item-timeago"] time';
    const LOGO_LINK='a[data-at="company-logo"]';

    // detail page /jobs--...--14302852-inline.html
    const DETAIL_COMPANY='[data-at="metadata-company-name"]';
    const DETAIL_LOCATION='[data-at="metadata-location"]';
    const DETAIL_WORK_TYPE='[data-at="metadata-work-type"]';
    const DETAIL_DATE='[data-at="metadata-online-date"]';
    const DETAIL_CARD='[data-at="job-ad-company-card"]';
    const DETAIL_CMP='a[data-at="job-ad-company-logo-link"], a[data-at="header-company-logo"]';

    // "IT & Tech • 10000+ Employees" / "... • 51-500 Mitarbeiter"
    const SIZE_TEXT=/(\d[\d.,]*\s*(?:\+|-|–|bis|to)?\s*[\d.,]*)\s*(mitarbeiter(?:innen|in)?|besch[äa]ftigte[rn]?|employees?)\b/i;

    // company id inside the profile link: /cmp/en/<slug>-241382/work[.html]
    const EMPLOYER_ID=/-(\d+)\/work(?:\.html)?$/i;

    // "Published: 4 hours ago" / "Online seit: vor 4 Stunden"
    const PUBLISHED=/^(?:published|online seit|veröffentlicht)\s*:?\s*/i;

    // <a aria-label="Next" href="...&page=2">
    //
    // aria-label="Next" only exists on the English site and www.stepstone.de serves German by
    // default, so the one selector the entire walk depended on matched nothing: the run ended
    // after the open page and reported itself as complete. Tried in order of how much each can
    // be trusted - rel="next" is the standard and language independent, data-at is what the rest
    // of this file relies on, aria-label comes last. Every candidate is checked against the
    // CURRENT page number before it is used (see nextUrl), so a loose selector here cannot send
    // the walk sideways or backwards.
    const NEXT_LINKS=[
        'a[rel~="next"]',
        'a[data-at*="next" i]',
        'a[data-testid*="next" i]',
        'nav[aria-label="pagination"] a[aria-label="Next"]',
        'a[aria-label*="next" i]',
        'a[aria-label*="nächste" i]',
        'a[aria-label*="naechste" i]'
    ];

    // StepStone puts 25 ads on a page; only used to stop counting past the end of the list
    const PAGE_SIZE=25;

    // total job count: prefer the clean attribute, fall back to the "4.061" heading
    const TOTAL_ATTR="[data-resultlist-offers-total]";
    const TOTAL_TEXT='[data-at="search-jobs-count"]';

    const HARD_PAGE_CAP=200;

    // The badges "Partially remote" / "Teilweise Homeoffice" / "Home office possible" -> Hybrid,
    // "Full remote" -> Remote. Test HYBRID first because both contain the words "home office".
    // This is only the fallback level: see readMode().
    const HYBRID=/partially remote|partly remote|teilweise|hybrid|home.?office (?:possible|m[öo]glich)|homeoffice m[öo]glich/i;
    const REMOTE=/remote|home.?office|telearbeit/i;

    // Read the Location field: does it mention remote, and once every remote word plus
    // country/region name is stripped, is any city left over.
    const REMOTE_HINT=/remote|home.?office|homeoffice|telearbeit/i;
    const REMOTE_STRIP=/remote|home.?office|homeoffice|telearbeit|bundesweit|deutschlandweit|100\s*%/gi;
    const PLACE_NOISE=/\b(?:germany|deutschland|dach|europe|europa|eu|oder|or|und|and|in|innerhalb|nationwide|anywhere|only|based|work|from)\b/gi;

    // company page: "51-500 Mitarbeiter", "mehr als 10.000 Mitarbeiter", "1,001-5,000 employees"
    const SIZE_RANGE=/(\d[\d.,]*)\s*(?:-|–|—|bis|to)\s*(\d[\d.,]*)\s*(?:mitarbeiter\w*|besch[äa]ftigte\w*|employees?)/i;
    const SIZE_OPEN=/(?:mehr als|über|ueber|more than|over)\s*(\d[\d.,]*)\s*(?:mitarbeiter\w*|besch[äa]ftigte\w*|employees?)/i;
    const SIZE_LABEL=/^(?:mitarbeiter(?:zahl|innen)?|unternehmensgr[öo]ße|gr[öo]ße|company size|size|employees)$/i;

    // The pace floor is zero. A flat 400ms between pages and 200ms between detail requests was
    // paid whether or not StepStone minded; the gate widens the moment anything is actually
    // refused, which is the only time that wait buys anything.
    const gate=core.makeGate({minGap:0,limit:4,log:LOG});

    const fetcher=core.makeFetcher(gate,{
        log:LOG,
        // Two refusals in a row are answered by a real navigation, not by the rest of the
        // ladder - but only while there is a tab left to open. See core.makeFetcher.
        canEscalate:()=>tabs.available
    });

    const jobs=[];
    // job id -> the results page it was found on. A plain Set of ids was enough to dedupe, but
    // not to tell the two reasons a page can bring nothing new apart: a page re-read on purpose
    // (the rewind, a resumed run) versus StepStone answering a page number past the end of the
    // list by re-serving page 1. The first must not stop the walk; the second must.
    const visited=new Map();

    const startedAt=performance.now();

    const report=core.makeReporter("stepstone-crawler-status",LOG);

    // A 429/403/5xx is often "that did not look like a browser" rather than "too fast", and no
    // amount of backing off answers it. Reopening the URL as a real navigation does, and if the
    // check needs a person the tab is put in front of them - once, for the whole site.
    const tabs=core.makeTabFallback({
        log:LOG,
        report,
        lastStatus:fetcher.lastStatus,
        describe:describeUrl
    });

    // Enough of a URL to recognise it in a status line.
    //
    // This used to be `"page "+(paramOf(url,"page")||1)`, which is only ever right for the results
    // walk. Job ads and company pages carry no ?page= at all, so every one of them fell through to
    // the `||1` and announced itself as "page 1" - the detail phase reopened dozens of different
    // ads and printed the same line for all of them, which reads like a run stuck in a loop when it
    // is simply mislabelled.
    function describeUrl(url){

        const page=core.paramOf(url,"page",ORIGIN);

        if(page) return "page "+page;

        // .../jobs--Sports-Scientist-m-f-x-Berlin-Schmidt-Hagius-GmbH-Co-KG--13760838-inline.html
        const ad=/--(\d+)(?:-inline)?\.html/.exec(url);

        if(ad) return "job "+ad[1];

        try{
            return new URL(url,ORIGIN).pathname.replace(/^\/+|\/+$/g,"")||url;
        }
        catch(e){
            return url;
        }

    }

    const fetchDoc=(url,opts)=>core.tabFirst(fetcher,tabs,url,opts);

    const norm=core.norm;
    const pick=core.pick;
    const blocks=core.blocks;

    // A tab navigation kills the content script outright - no catch block runs and nothing is
    // written. The checkpoint turns that from "the whole run is gone" into "the next run starts
    // where this one stopped".
    const checkpoint=core.makeCheckpoint("stepstoneCheckpoint",{log:LOG});

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
        let wantDetails=true;

        try{

            const settings=await chrome.storage.local.get(["maxPages","concurrency","details"]);

            maxPages=Math.max(0,+settings.maxPages||0);

            if(settings.concurrency) concurrency=Math.min(12,Math.max(1,+settings.concurrency));

            if(settings.details===false) wantDetails=false;

        }
        catch(e){
            console.warn(LOG,"could not read settings, using defaults",e);
        }

        // the setting is the ceiling, not a fixed width: the gate drops below it while refused
        gate.limit=concurrency;
        gate.maxLimit=concurrency;

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
        // 2. read the current page fully BEFORE moving to the next one
        //---------------------------------------------------

        const total=readTotal(document);

        if(total) console.log(LOG,`${total} jobs match the current filters`);

        const paging=await crawlAllPages(maxPages,total);

        console.log(LOG,`${paging.pages} page(s) read -> ${jobs.length} jobs`
            +(paging.stoppedEarly?" (stopped early)":""));

        if(jobs.length===0){

            alert("No job cards found. Open a stepstone.de search results page and run again.");
            return;

        }

        //---------------------------------------------------
        // 3. group by company
        //---------------------------------------------------

        const companies=buildCompanies(jobs);

        console.log(LOG,`${jobs.length} jobs -> ${companies.length} companies`);

        //---------------------------------------------------
        // 4. Employees / work type are not on the card -> open the job's detail page.
        //    One page per company (its newest listing) - opening every listing instead would
        //    multiply the request count by the jobs-per-company ratio to add nothing but the
        //    other branches' locations, and that is where StepStone starts returning 429.
        //---------------------------------------------------

        const byKey=new Map(companies.map(company=>[company.key,company]));

        const targets=!wantDetails?[]
            :companies.filter(company=>company.jobUrl).map(company=>({url:company.jobUrl,key:company.key}));

        let failed=0;
        let processed=0;
        let withSize=0;

        if(targets.length){

            await core.mapPool(targets,concurrency,async(target,index)=>{

                target.failed=false;

                const doc=await fetchDoc(target.url);

                if(!doc){

                    failed++;

                    // marked so the retry pass can come back for it once the queue has drained
                    target.failed=true;

                }
                else{

                    const detail=readDetail(doc);
                    const company=byKey.get(target.key);

                    if(company){

                        const had=!!company.employees;

                        applyDetail(company,detail);

                        if(!had&&company.employees) withSize++;
                        else if(!company.employees&&index<3) console.warn(LOG,"no employee count on",target.url);

                    }

                }

                if(!target.counted){
                    target.counted=true;
                    processed++;
                }

                report(`[${processed}/${targets.length}] job detail`);

            },{
                log:LOG,
                // A detail page refused at the busiest moment of the run gets one more go once
                // the queue has drained: a blank Employees cell is indistinguishable from
                // "this company publishes no headcount".
                shouldRetry:target=>target.failed===true,
                onRetryPass:count=>report(`Retrying ${count} detail page(s) that failed...`)
            });

        }

        //---------------------------------------------------
        // 5. export to excel + trigger the download
        //---------------------------------------------------

        finish({companies,total,paging,targets:targets.length,wantDetails,withSize,failed,crashed:null});

    }
    catch(e){

        console.error(LOG,"crawl aborted:",e);

        // Everything collected up to the crash is real data. Throwing it away because the last
        // step failed is the single most expensive thing this crawler used to do.
        salvage(e);

    }
    finally{

        window.__stepstoneCrawlerRunning=false;

    }

    //---------------------------------------------------
    // helper: write the file
    //---------------------------------------------------

    function finish(state){

        // the crash path calls this too, and an exception raised INSIDE it would come back round
        // and download a second copy of the same file
        if(fileWritten) return;

        fileWritten=true;

        // fixed header: companies with missing data must still keep all 7 columns.
        // "No." is written because the rows are in StepStone's own order - without a number
        // there is nothing in the file to check that order against, or to point at when a row
        // is missing.
        const HEADERS=["No.","Company Name","Location","Positions","Recruitment time","Employees","Remote/Onsite"];

        const results=state.companies.map((company,index)=>({
            "No.":index+1,
            "Company Name":company.name,
            "Location":company.locations.join(", "),
            "Positions":company.positions.join(" | "),
            "Recruitment time":company.posted,
            "Employees":company.employees,
            "Remote/Onsite":company.modes.join(", ")
        }));

        const written=core.exportCsv(results,{
            headers:HEADERS,
            filename:"stepstone_companies.csv",
            log:LOG
        });

        const withTime=results.filter(r=>r["Recruitment time"]).length;
        const elapsed=Math.round((performance.now()-startedAt)/1000);

        const paging=state.paging||{pages:0,failed:0,recovered:0,counted:0,reason:"end"};

        // "Done" on its own reads as "that was all of it", which is exactly wrong when StepStone
        // cut the walk short - the file then looks complete while half the list is missing.
        const problems=[
            rewound?`Rewound to page 1: the tab was on page ${rewound+1}, so pages 1-${rewound} `
                +"would otherwise have been skipped entirely.":"",
            paging.recovered?`${paging.recovered} page(s) were recovered on the second pass.`:"",
            paging.counted?`StepStone's "Next" link could not be found on ${paging.counted} page(s), so `
                +"the crawler counted ?page= forward instead. That is the intended fallback and "
                +"nothing is missing because of it - but if the count above is short, this is the "
                +"first thing to check.":"",
            paging.failed?`${paging.failed} page(s) could not be read at all - those jobs are missing.`:"",
            paging.reason==="blocked"
                ? "StepStone stopped serving results part way through - this is a rate limit, not the "
                    +"end of the list. Wait a few minutes and run again, or lower 'parallel'."
                :"",
            paging.reason==="limit"?"Stopped at the max pages limit - there are more results.":"",
            written.clipped?`${written.clipped} cell(s) truncated to fit Excel's 32,767 character limit.`:""
        ].filter(Boolean);

        const summary=`Done in ${elapsed}s: ${results.length} companies from ${jobs.length} jobs`
            +(state.total?` of the ${state.total} StepStone reports`
                +(jobs.length<state.total?` - ${state.total-jobs.length} NOT READ`:" - complete"):"")
            +` over ${paging.pages} page(s), ${withTime} with recruitment time`
            +(state.wantDetails?`, ${state.targets} detail page(s) read, ${state.withSize} with employee count`
                :", job details off")
            +`, ${state.failed} request errors.`
            +(resumed?`\nResumed ${resumed} job(s) from an earlier unfinished run.`:"")
            +(core.describeSizes(state.companies)?`\n${core.describeSizes(state.companies)}`:"")
            +(problems.length?"\n\n"+problems.join("\n"):"")
            +(fetcher.describe()?`\nRequests: ${fetcher.describe()}`:"")
            +(tabs.describe()?`\n${tabs.describe()}`:"")
            +(state.crashed?`\n\nThe run stopped early: ${state.crashed}.`
                +"\nEverything collected before that point is in the file above.":"");

        report(summary);

        // the run reached the file, so there is nothing left to resume
        if(!state.crashed) checkpoint.clear();

        // let the download start before the alert blocks the page
        setTimeout(()=>alert(summary+"\nSaved as stepstone_companies.csv"),0);

    }

    // build the file out of whatever survived the crash
    function salvage(error){

        try{

            if(jobs.length===0){
                alert("Crawl failed before anything was collected: "+(error&&error.message||error));
                return;
            }

            const companies=buildCompanies(jobs);

            finish({
                companies,
                total:0,
                paging:null,
                targets:0,
                wantDetails:false,
                withSize:companies.filter(c=>c.employees).length,
                failed:0,
                crashed:(error&&error.message||String(error))
            });

        }
        catch(e){

            console.error(LOG,"could not salvage the run either:",e);

            alert("Crawl failed: "+(error&&error.message||error)+"\nOpen DevTools console for details.");

        }

    }

    //---------------------------------------------------
    // helper: read the current page's list fully BEFORE moving on
    // The "Next" button is a real <a>: clicking it reloads the page and kills the content
    // script, so the crawler follows its href with fetch instead.
    // Stops when: a page comes back with no cards, a page reached by counting repeats one
    // already read, pagination points back at a page already read, or the max pages limit is
    // reached. Note what is NOT on that list any more - "the Next link could not be found".
    // That is a fact about one CSS selector, not about the list, and treating it as the end of
    // the results is what truncated a 4,000 job search to the 25 ads on screen.
    //---------------------------------------------------

    async function crawlAllPages(maxPages,total){

        const limit=maxPages?Math.min(maxPages,HARD_PAGE_CAP):HARD_PAGE_CAP;

        const here=core.paramOf(location.href,"page",ORIGIN)||1;

        // the open page is already rendered and costs no request, so read it whatever happens
        const first=collectFrom(document,here);

        report(`Open page: +${first.added} job(s), ${jobs.length} total`);

        // the last page that can hold anything, so counting forward stops at the end of the list
        // instead of walking to the cap. 0 when the total could not be read.
        const lastPage=total?Math.ceil(total/PAGE_SIZE):0;

        // URLs the crawler counted its way to rather than read off a link. Kept apart because a
        // counted page that brings nothing new is StepStone re-serving an earlier page, which is
        // how it answers a page number past the end - and that has to end the walk.
        const counted=new Set();

        let lastPageHadCards=first.cards>0;

        // The same search one page further on. Deliberately NOT core.bumpParam: that reads a
        // missing ?page= as 0, so it steps from the first page (which carries no page param at
        // all) to "page=1" - the same page again, which the loop guard then reads as pagination
        // going in a circle.
        function stepPage(url){

            try{

                const next=new URL(url,ORIGIN);

                next.searchParams.set("page",String((core.paramOf(url,"page",ORIGIN)||1)+1));

                const clean=cleanUrl(next.toString());

                counted.add(clean);

                return clean;

            }
            catch(e){
                return "";
            }

        }

        // can the walk step forward from `page` at all, or is that already the end of the list
        function moreAfter(page){
            return lastPageHadCards&&(!lastPage||page<lastPage);
        }

        // The Next chain only ever goes FORWARD, so starting wherever the tab happens to sit
        // silently drops every earlier page - a tab left on page 5 lost 100 jobs and the summary
        // said nothing about them. Rewind to page 1 instead; the pages already in `visited` are
        // deduped on arrival, so the only cost is the requests, not the data.
        //
        // The open page's own Next link is the preferred first hop, but when it cannot be found
        // the walk did not merely stop early - it never started. walkPages ends before its first
        // iteration on an empty `first`, so the run exported the 25 ads already on screen and
        // reported reason "end", i.e. "that was the whole list". Counting forward is the floor
        // under that, exactly as it is for every later hop.
        const start=here>1?pageUrl(1)
            :nextUrl(document,location.href)||(moreAfter(here)?stepPage(location.href):"");

        rewound=here>1?here-1:0;

        if(rewound) report(`Tab was on page ${here} - rewinding to page 1 so pages 1-${rewound} are not lost...`);

        const walk=await core.walkPages({

            first:start,

            fetchDoc:(url,opts)=>fetchDoc(url,opts),

            onDoc:async (doc,url)=>{

                const page=core.paramOf(url,"page",ORIGIN)||1;

                const found=collectFrom(doc,page);

                lastPageHadCards=found.cards>0;

                report(`Page ${page}: +${found.added} job(s), ${jobs.length} total`);

                await checkpoint.save({jobs});

                if(found.cards===0){
                    console.warn(LOG,"a page had no job cards - end of the list or a bot check");
                    return "stop";
                }

                // A counted page that brought nothing new AND is made of ads belonging to other
                // pages is StepStone answering a page number past the end by re-serving an
                // earlier page. "Nothing new" on its own is not enough: the rewind re-reads the
                // tab's own page on purpose, and so does a resumed run - both add nothing and
                // both must carry on.
                if(found.added===0&&found.elsewhere>0&&counted.has(url)){
                    console.warn(LOG,`page ${page} was reached by counting and came back holding`
                        +" ads from a page already read - that is the end of the list");
                    return "stop";
                }

                return "";

            },

            // The Next link is the better source - it is what the site itself says comes next.
            // But it is one selector against markup that is renamed per build AND per language,
            // and when it missed, "there is no next page" and "we could not find the next page"
            // were the same answer: the walk ended after one page and the run called itself
            // complete. Counting forward is the floor under that - StepStone's pagination is a
            // plain ?page= counter, and the first page with no cards ends the walk.
            nextOf:(doc,url)=>{

                const found=nextUrl(doc,url);

                if(found) return found;

                const page=core.paramOf(url,"page",ORIGIN)||1;

                if(!moreAfter(page)) return "";

                console.warn(LOG,`no "Next" link on page ${page} - counting forward instead`);

                return stepPage(url);

            },

            // The next URL normally comes out of the page we just failed to read, so without this
            // one bad moment at page 27 of 60 threw away two thirds of the list.
            guessNext:url=>stepPage(url),

            maxPages:limit,
            report,
            log:LOG

        });

        await checkpoint.save({jobs},true);

        return {
            // walkPages starts its counter at 1 for the page already on screen, so it is already
            // the total number of pages read - adding another one over-reported every run by 1
            pages:walk.pages,
            failed:walk.skipped,
            recovered:walk.recovered,
            counted:counted.size,
            reason:walk.reason,
            stoppedEarly:walk.reason!=="end"
        };

    }

    // the same search, on a given page number
    function pageUrl(page){

        const url=new URL(location.href);

        url.searchParams.set("page",String(page));

        return cleanUrl(url.toString());

    }

    //---------------------------------------------------
    // helper: collect the jobs of one page
    //---------------------------------------------------

    // `page` and `rank` are the ad's position in the StepStone results, and they are the only
    // record of it: the crawler does NOT read the pages in site order (it reads the open page
    // first, then rewinds to page 1), so the order of `jobs` is the order it fetched them.
    // buildCompanies sorts on these to put the sheet back into the order the site shows.
    function collectFrom(doc,page){

        const cards=doc.querySelectorAll(CARD);

        let added=0;
        let dropped=0;
        let elsewhere=0;
        let rank=0;

        cards.forEach(card=>{

            const job=readCard(card,page,rank++);

            // readCard always returns an id now - see the note there. This counts the ones it had
            // to invent, because that means a build renamed the attribute AND the ad carried no
            // link either, which is worth one line. It is no longer a job being thrown away.
            if(!job.hasOwnId) dropped++;

            if(visited.has(job.id)){

                // This ad was read as part of a DIFFERENT page, so this page is a copy of one
                // already seen rather than a page being re-read on purpose. An unknown page (an
                // old checkpoint) counts as the same page: erring towards carrying on costs one
                // wasted request, erring the other way costs the rest of the list.
                const from=visited.get(job.id);

                if(from&&from!==page) elsewhere++;

                return;

            }

            visited.set(job.id,page);

            jobs.push(job);

            added++;

        });

        // a card with neither an id nor a link used to be SKIPPED here, which threw the ad away
        // over a missing attribute. It is kept now and identified by where it sat in the list.
        if(dropped){
            console.warn(LOG,`${dropped} of ${cards.length} card(s) on page ${page} had neither an`
                +" id nor a link - they were kept and identified by their place in the list");
        }

        return {cards:cards.length,added,dropped,elsewhere};

    }

    // getAttribute("href") is null on an element that is not a link, and new URL(null,ORIGIN)
    // resolves to ".../null" - a job URL that looks real and 404s on every detail fetch.
    function linkHref(el){

        const href=el&&el.getAttribute&&el.getAttribute("href");

        if(!href) return "";

        try{
            return cleanUrl(new URL(href,ORIGIN).toString());
        }
        catch(e){
            return "";
        }

    }

    // the title element is the link on today's markup, but it has been a heading inside one
    function jobLink(card,title){

        if(!title) return linkHref(card.querySelector("a[href]"));

        return linkHref(title)
            ||linkHref(title.querySelector&&title.querySelector("a[href]"))
            ||linkHref(title.closest&&title.closest("a[href]"))
            ||linkHref(card.querySelector("a[href]"));

    }

    function readCard(card,page,rank){

        const logo=card.querySelector(LOGO_LINK);
        const title=card.querySelector(TITLE);
        const posted=readPosted(card);

        const companyUrl=linkHref(logo);
        const jobUrl=jobLink(card,title);
        const name=norm(title);
        const company=pick(card,COMPANY);

        // id="job-item-13961958". StepStone hashes and renames attributes per build, so fall back
        // to the ad's own URL rather than dropping the card: either one is unique per ad and that
        // is all `visited` needs.
        //
        // And when neither is there, fall back to where the ad sits in the list rather than
        // returning "" - the caller used to drop the job on that, so an ad with no id AND no link
        // was lost entirely. The page number is deliberately left out: StepStone answers a page
        // number past the end by re-serving an earlier page, and the walk only knows that because
        // the ads come back with ids it has already seen.
        const own=(card.getAttribute("id")||"").replace(/^job-item-/,"")||jobUrl;

        return {
            id:own||`${company}|${name}|#${rank}`,
            hasOwnId:!!own,
            page,
            rank,
            title:name,
            company,
            location:pick(card,LOCATION),
            workFromHome:pick(card,WFH),
            postedText:posted.text,
            postedAt:posted.at,
            companyUrl,
            employerId:employerId(companyUrl),
            jobUrl
        };

    }

    // the company id is the most reliable grouping key: the same company written differently
    // ("N26 GmbH" / "N26") still lands on one row.
    function employerId(companyUrl){

        const match=(companyUrl||"").match(EMPLOYER_ID);

        return match?match[1]:"";

    }

    //---------------------------------------------------
    // helper: the posting date
    // <time datetime="2026-07-29T09:03:04+02:00">6 days ago</time>
    // -> show the text, compare newer/older by datetime so it is language independent
    //---------------------------------------------------

    function readPosted(card){

        const time=card.querySelector(POSTED);

        if(!time) return {text:"",at:0};

        const stamp=Date.parse(time.getAttribute("datetime")||"");

        return {text:norm(time),at:isNaN(stamp)?0:stamp};

    }

    //---------------------------------------------------
    // helper: group jobs by company
    //---------------------------------------------------

    function buildCompanies(list){

        const map=new Map();

        // Site order, not the order the crawler happened to fetch in. Those are not the same:
        // when the tab sits on page 5 the open page is read FIRST and the walk then rewinds to
        // page 1, so page 5's companies came out at the top of the sheet and page 5's ads at the
        // front of every Positions cell. Resuming a checkpoint scrambled it further. (page,rank)
        // is where the ad actually sits in the results, so sorting on it puts both the rows and
        // the cells back into the order StepStone shows.
        const ordered=[...list].sort((a,b)=>(a.page||0)-(b.page||0)||(a.rank||0)-(b.rank||0));

        // Group by company id; without an id, fall back to the folded name rather than the
        // lowercased one, so "N26 GmbH" and "N26 GmbH." do not become two rows each holding a
        // slice of the positions.
        //
        // core.companyKeys is what makes the two agree. The employer id comes off the LOGO link,
        // and whether that renders is a property of the card - a sponsored ad or a build that
        // renamed data-at drops it - so the same employer arrived as "id:241382" on one page and
        // "name:n26" on the next: two rows, which is the duplicate the folded name exists to stop.
        const keyOf=core.companyKeys(ordered,job=>job.employerId,job=>job.company||"(unknown)");

        for(const job of ordered){

            const name=job.company||"(unknown)";

            const key=keyOf(job);

            job.key=key;

            let company=map.get(key);

            if(!company){

                company={
                    key,
                    name,
                    employerId:job.employerId,
                    // rank of this company's FIRST ad in the results - the sheet's "No." column
                    seq:map.size,
                    jobs:0,
                    locations:[],
                    positions:[],
                    modes:[],
                    posted:"",
                    postedAt:0,
                    companyUrl:job.companyUrl,
                    jobUrl:job.jobUrl,
                    employees:"",
                    // "label" | "near" | "" - see core.headcount
                    employeesSource:""
                };

                map.set(key,company);

            }

            company.jobs++;

            keep(company.positions,job.title);
            push(company.locations,job.location);
            push(company.modes,readMode(job.workFromHome,job.location));

            // the newest listing, and its URL as the detail page to open
            if(job.postedAt>company.postedAt){
                company.postedAt=job.postedAt;
                company.posted=job.postedText;
                if(job.jobUrl) company.jobUrl=job.jobUrl;
            }

            // the row may have been opened by an ad whose logo link never rendered, so take the id
            // from whichever of this company's ads did carry one
            if(!company.employerId&&job.employerId) company.employerId=job.employerId;

            if(!company.companyUrl&&job.companyUrl) company.companyUrl=job.companyUrl;
            if(!company.jobUrl&&job.jobUrl) company.jobUrl=job.jobUrl;

        }

        // First appearance in the search results, so row 1 of the sheet is the first hit on
        // page 1 and the "No." column can be read straight against the site. Ranking by ad count
        // instead put a company from page 40 above the first hit on page 1, which made the file
        // impossible to check against StepStone and hid the fact that whole pages were missing.
        return [...map.values()].sort((a,b)=>a.seq-b.seq);

    }

    function push(list,value){
        if(value&&!list.includes(value)) list.push(value);
    }

    // Positions is one entry per AD, not per distinct title.
    //
    // push() was used here too, and it drops a value the list already holds - so a company running
    // four separate "Softwareentwickler" ads reached the file as one position and read as though it
    // were hiring for one. Location and Remote/Onsite keep using push(), because those describe the
    // company and really are a set: "Berlin, Berlin, Berlin" is noise, three identical job titles
    // are three jobs.
    //
    // An ad whose title could not be read is still an ad, so it is marked rather than dropped - the
    // number of entries in the cell always equals the number of ads behind the row.
    function keep(list,value){
        list.push(value||"(untitled)");
    }

    // The Location field is where the truth is. StepStone's work-from-home badge only has two
    // levels, and while the user filters on wfh=2 EVERY card says "Partially remote" ->
    // reading the badge first turns the whole sheet into "Hybrid".
    //   "Germany (remote)"            -> Remote  (no city at all)
    //   "Erlangen Innenstadt, remote" -> Hybrid  (a city plus remote)
    //   "Berlin"                      -> let the badge decide
    // The title is deliberately NOT read: "... oder remote" is marketing, not a data field.
    function locationMode(location){

        const text=String(location||"");

        // "Berlin, Germany (Hybrid)" already states it
        if(HYBRID.test(text)) return "Hybrid";

        if(!REMOTE_HINT.test(text)) return "";

        const rest=text
            .replace(REMOTE_STRIP," ")
            .replace(PLACE_NOISE," ")
            .replace(/[^\p{L}\p{N}]+/gu," ")
            .trim();

        return rest?"Hybrid":"Remote";

    }

    function readMode(workFromHome,location){

        const fromLocation=locationMode(location);
        if(fromLocation) return fromLocation;

        const badge=String(workFromHome||"");

        if(HYBRID.test(badge)) return "Hybrid";
        if(REMOTE.test(badge)) return "Remote";

        return "Onsite";

    }

    //---------------------------------------------------
    // helper: read one listing's detail page
    // The company card block holds exactly what the list card lacks: "IT & Tech • 10000+ Employees".
    //---------------------------------------------------

    function readDetail(doc){

        const cmp=doc.querySelector(DETAIL_CMP);
        const companyUrl=cmp?cleanUrl(new URL(cmp.getAttribute("href"),ORIGIN).toString()):"";

        const size=readSize(doc);

        return {
            company:pick(doc,DETAIL_COMPANY),
            location:pick(doc,DETAIL_LOCATION),
            workType:pick(doc,DETAIL_WORK_TYPE),
            posted:pick(doc,DETAIL_DATE).replace(PUBLISHED,""),
            employees:size.text,
            employeesSource:size.source,
            companyUrl,
            employerId:employerId(companyUrl)
        };

    }

    // merge the detail page data into the company without overwriting what is already there
    function applyDetail(company,detail){

        if(!company.employees&&detail.employees){
            company.employees=detail.employees;
            company.employeesSource=detail.employeesSource;
        }

        push(company.locations,detail.location);
        push(company.modes,readMode(detail.workType,detail.location));

        if(!company.posted&&detail.posted) company.posted=detail.posted;

        if(!company.companyUrl&&detail.companyUrl) company.companyUrl=detail.companyUrl;

    }

    //---------------------------------------------------
    // helper: the headcount
    // "IT & Tech • 10000+ Employees" on the company card, or the Mitarbeiter label
    // on the /cmp/ page when something points there.
    //---------------------------------------------------

    function readSize(doc){

        const card=doc.querySelector(DETAIL_CARD);

        if(card){

            // blocks() instead of textContent: the "2 Jobs" button sits right next to it, so
            // textContent would run together into "Mitarbeiter2" and the regex would swallow the 2.
            const match=blocks(card).join(" ").match(SIZE_TEXT);

            // the company card is a dedicated block, so a match inside it is the field itself
            if(match) return {text:match[0].trim(),source:"label"};

        }

        // A label with the value in the next block ("Mitarbeiter" + "1.001-5.000"), then a small
        // element that IS the value. What is NOT done any more is running the same regexes over
        // norm(doc.body): a German advert saying "unser Team von 25 Mitarbeitern" matched
        // SIZE_TEXT and became the company's headcount, in a cell indistinguishable from a real
        // one. An empty cell is recoverable; a plausible wrong number is not.
        return core.headcount(doc,{
            label:SIZE_LABEL,
            value:new RegExp(SIZE_RANGE.source+"|"+SIZE_OPEN.source+"|"+SIZE_TEXT.source,"i"),
            scope:"[data-at],[data-testid],li,dd,dt,td,p,span,div"
        });

    }

    //---------------------------------------------------
    // helper: URL of the next page
    //---------------------------------------------------

    // `from` is the URL this document was fetched from. A "next" link has to actually move
    // FORWARD, and checking that is what makes the deliberately loose selector list safe: a
    // "Weitere Infos" link, a rel="next" on something that is not pagination, or a language
    // variant that happens to match all fail the same test and are ignored rather than sending
    // the walk sideways or into a circle.
    function nextUrl(doc,from){

        const here=core.paramOf(from||location.href,"page",ORIGIN)||1;

        for(const selector of NEXT_LINKS){

            for(const link of doc.querySelectorAll(selector)){

                const href=link.getAttribute("href");

                if(!href) continue;

                let candidate;

                try{
                    candidate=cleanUrl(new URL(href,ORIGIN).toString());
                }
                catch(e){
                    continue;
                }

                if((core.paramOf(candidate,"page",ORIGIN)||1)>here) return candidate;

            }

        }

        return "";

    }

    // strip #hash so two URLs differing only by anchor are not treated as two pages
    function cleanUrl(href){

        const url=new URL(href,ORIGIN);

        return url.origin+url.pathname+url.search;

    }

    //---------------------------------------------------
    // helper: the total job count the page declares
    //---------------------------------------------------

    function readTotal(doc){

        const box=doc.querySelector(TOTAL_ATTR);

        const attr=box&&+box.getAttribute("data-resultlist-offers-total");

        if(attr) return attr;

        // "4.061" - the dot is the German thousands separator
        const text=pick(doc,TOTAL_TEXT).replace(/[.,\s]/g,"");

        return /^\d+$/.test(text)?+text:0;

    }

})();
