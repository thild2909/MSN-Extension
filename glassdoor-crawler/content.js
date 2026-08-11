(async()=>{

    const LOG="[gd-crawler]";

    // every country site (glassdoor.com, .com.au, .co.uk, .de, .com.hk, .com.my, .sg, ...) is built the
    // same way, so nothing here is hard-coded to one host: links are resolved against the current origin.
    const ORIGIN=location.origin;
    const HOST=location.hostname.replace(/^www\./,"");

    // "glassdoor.com.au" -> "com_au", used to keep one file per country instead of overwriting
    const COUNTRY=HOST.replace(/^glassdoor\./,"").replace(/\./g,"_")||"com";

    const FILENAME=`glassdoor_companies_${COUNTRY}.xlsx`;

    //---------------------------------------------------
    // guard against double runs when the button is clicked repeatedly
    //---------------------------------------------------

    if(window.__gdCrawlerRunning){
        alert("Crawler is already running on this tab. Wait for it to finish.");
        return;
    }

    window.__gdCrawlerRunning=true;

    const core=window.CrawlerCore;

    if(!core){

        alert("core.js is not loaded in this tab. popup.js must inject core.js before content.js.");

        window.__gdCrawlerRunning=false;

        return;

    }

    // Glassdoor does not paginate through the URL: "Show more jobs" must be clicked to load more.
    const LOAD_MORE='button[data-test="load-more"]';
    const CARD='[data-test="jobListing"]';

    // <h1 data-test="search-title">387 Remote jobs</h1> -> the total job count, used to work out the number of clicks
    const SEARCH_TITLE='[data-test="search-title"]';

    // upper bound for when the page reports a huge job count or each click loads very little
    const MAX_AUTO_CLICKS=100;

    // The longest a batch is ever given, used until enough real batches have been seen to know
    // what "normal" is here. After that the wait is derived from what this search actually does -
    // see batchTimeout(). A flat 15s was paid three times over at the end of every run, because
    // the last thing a click loop does is wait out three timeouts to prove the list has ended.
    const LOAD_TIMEOUT=15000;

    // ...but never less than this, however fast the batches have been: one slow response at the
    // end of a run must not be read as "the list is finished".
    const MIN_TIMEOUT=3000;

    // how many batches are enough to know what a normal one costs here
    const TIMING_SAMPLE=3;

    // How long the card count has to stop growing before a batch counts as fully rendered.
    //
    // This is a detection interval, not a toll: there is no way to know changes have stopped
    // except by watching a quiet moment go by. It is now as short as that idea allows, because it
    // no longer has to protect the tail of the final batch - crawlAllPages reads once more after
    // the loop for that. All it still buys is not clicking again mid-render.
    const BATCH_SETTLE=30;

    // Belt and braces behind the MutationObserver, for the two cases where watching alone is not
    // enough: a list rendered into a closed shadow root produces no mutations we can see, and a
    // page with something always moving on it (an ad slot, a lazy image, a countdown) never gives
    // the settle above its 80 quiet milliseconds.
    //
    // Deliberately the same interval the old poll used, so this change cannot be slower than what
    // it replaces in any case - the observer only ever gets there first.
    const BACKSTOP_POLL=250;

    // how many times a click that did not grow the list is worth trying again before the list is
    // treated as finished. Glassdoor's button occasionally no-ops when it scrolls out of view.
    const STUCK_LIMIT=3;

    // "3d" / "24h" / "30d+" inside <div data-test="job-age">
    const POSTED=/(\d+)\s*\+?\s*(mo|[mhdwy])\b/i;

    const UNIT={m:1,h:60,d:1440,w:10080,mo:43200,y:525600};

    // headcount range behind each checkbox in the popup
    const SIZE_BUCKET={
        "1-10":[1,10],
        "11-20":[11,20],
        "21-50":[21,50],
        "51-100":[51,100],
        "101-200":[101,200],
        "201-500":[201,500],
        "501-1000":[501,1000],
        "1001-2000":[1001,2000],
        "2001-5000":[2001,5000],
        "5001-10000":[5001,10000],
        "10001+":[10001,Infinity]
    };

    const jobs=[];
    const visited=new Set();

    // Cross-origin reads go through the service worker, which Glassdoor answers with 403
    // because the request carries none of the page's cookies or headers. After this many
    // failures in a row the fallback is dropped instead of doubling every request.
    const WORKER_GIVE_UP=5;

    let workerFailures=0;

    // Both of these are read by functions that run while the try block below is still executing,
    // so they have to be initialised before it - a const sitting next to the function that uses it
    // at the end of the file is still in its temporal dead zone and throws on first use.

    // how long each "Show more jobs" batch actually took, so the timeout can stop being a guess
    const batchMs=[];

    // readOverview walks the document three times looking for three different layouts, and it was
    // being run twice on every page that came back: once to decide whether the page was worth
    // keeping, then again to read it. On a run with several hundred companies that is several
    // hundred needless passes over a full job page.
    const overviews=new WeakMap();

    //---------------------------------------------------
    // reading three fields without reading a megabyte
    //
    // The "Company overview" block is a few hundred bytes in the middle of a job page that is
    // usually 1-2 MB, nearly all of it a JSON blob for Glassdoor's own JavaScript. Every path to
    // those three fields used to carry the whole page: DOMParser walked all of it here, and the tab
    // fallback structure-cloned all of it twice on the way.
    //
    // DOMParser is the part that matters. A content script has no worker to hand it to, so the
    // parses run on the same main thread as the crawl and do not overlap each other at all: past
    // about four requests in flight, parsing rather than the network is what the detail phase
    // spends its time on, and raising "parallel" made it slower instead of faster.
    //
    // Two markers, deliberately different. The loose one is exactly what readOverview keys off, so
    // "not in the page" here means the same thing as "no overview" there and can be answered
    // without parsing anything. The tight one is what the CUT is placed around, and it insists on
    // being inside a class attribute - the same hashed names appear in the page's inline CSS, and
    // a cut around the stylesheet contains no markup at all.
    //---------------------------------------------------

    // for the tab fallback: which elements are worth sending back instead of the document
    const OVERVIEW_SELECTORS=['[class*="overviewItem" i]','[class*="companyOverview" i]'];

    const OVERVIEW_ANY=/overviewItem|company overview/i;
    const OVERVIEW_MARKUP=/class="[^"]{0,300}overviewItem/i;

    // how much of the page around the marker is kept. Generous: the three items are siblings in
    // every layout seen, and being slightly wrong here costs a re-parse, not a row.
    const SLICE_BEFORE=4000;
    const SLICE_AFTER=40000;

    // ...and how far either end may be nudged to land on a tag boundary. Bounded, because the
    // nearest "<" going backwards can be most of a megabyte away - that is exactly what the JSON
    // blob this is trying to avoid looks like from the inside, one long run of text with no tags
    // in it. Unbounded, the search for a tidy boundary walked to the front of the script and the
    // "cut" came back as the whole page: all of the cost, none of the saving.
    const SLICE_BOUNDARY=500;

    function sliceOverview(html){

        // nothing any of the three layouts keys off is in this page: it has been read, and it
        // carries no overview. That is not a refusal, so it must not go round the retry ladder.
        if(!OVERVIEW_ANY.test(html)) return null;

        const at=html.search(OVERVIEW_MARKUP);

        // the block is in there under a shape this does not recognise -> "" asks for the whole
        // page to be parsed, exactly as it always was
        if(at<0) return "";

        // Both ends prefer a tag boundary - DOMParser recovers from most things, but a fragment
        // that begins halfway through an attribute is not one of them - and settle for the plain
        // offset when the nearest boundary is further away than SLICE_BOUNDARY. Text that starts
        // mid-word is just text; a cut the size of the page is the thing to avoid.
        const wantFrom=Math.max(0,at-SLICE_BEFORE);
        const wantTo=Math.min(html.length,at+SLICE_AFTER);

        const back=html.lastIndexOf("<",wantFrom);
        const forward=html.indexOf(">",wantTo);

        const from=back>=0&&wantFrom-back<=SLICE_BOUNDARY?back:wantFrom;
        const to=forward>=0&&forward-wantTo<=SLICE_BOUNDARY?forward+1:wantTo;

        return html.slice(from,to);

    }

    // did the cut land on the block, or on the words "company overview" in a job description?
    function hasOverview(doc){
        return Object.keys(overviewOf(doc)).length>0;
    }

    const SAMESITE_PROBE=4;

    const sameSite={

        tried:0,
        hits:0,

        worked(){
            this.tried++;
            this.hits++;
        },

        missed(){
            this.tried++;
        },

        get worthGuessing(){
            return this.hits>0||this.tried<SAMESITE_PROBE;
        },

        describe(){

            if(!this.tried) return "";

            return this.hits
                ?`Same-site: ${this.hits}/${this.tried} listings read from ${HOST} directly`
                :`Same-site: the ${this.tried} guesses at ${HOST} carried nothing, so the rest went `
                    +"straight to the site the jobs live on";

        }

    };

    const startedAt=performance.now();

    const sleep=core.sleep;
    const norm=core.norm;
    const pick=core.pick;
    const blocks=core.blocks;

    const report=core.makeReporter("gd-crawler-status",LOG);

    // The pace floor is zero: a fixed 150ms toll was paid on every company page whether or not
    // Glassdoor minded. The gate widens it the moment anything is actually refused.
    //
    // minLimit is what keeps "parallel" meaning something. Every refusal used to take a slot out
    // of the pool and only every third clean page gave one back, so the detail phase settled at
    // one request at a time within a minute of starting and stayed there - see core.makeGate.
    const gate=core.makeGate({minGap:0,limit:6,minLimit:3,log:LOG});

    //---------------------------------------------------
    // One HTTP request, from whichever side is allowed to make it.
    //
    // A search on one Glassdoor site links to job pages on another country domain
    // (glassdoor.com lists .com.au jobs). A content script fetch obeys the page's CORS rules, so
    // a cross-origin job page can only be read by the service worker, which is allowed to use
    // the extension's host_permissions.
    //---------------------------------------------------

    const fetcher=core.makeFetcher(gate,{

        log:LOG,

        request:async url=>{

            if(new URL(url).origin===ORIGIN){

                const response=await fetch(url,{
                    credentials:"include",
                    headers:{"Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}
                });

                return {
                    status:response.status,
                    url:response.url,
                    header:name=>response.headers.get(name),
                    text:()=>response.text()
                };

            }

            const reply=await chrome.runtime.sendMessage({type:"gd-fetch",url});

            if(!reply||reply.error){

                workerFailures++;

                // thrown, not returned: a dead channel is a transport failure, and the core
                // fetcher retries those rather than writing the page off
                throw new Error(reply&&reply.error||"no answer from the extension service worker");

            }

            if(reply.status<200||reply.status>=300){

                workerFailures++;

                if(workerFailures===WORKER_GIVE_UP){
                    console.warn(LOG,`${WORKER_GIVE_UP} cross-site reads in a row were refused - `
                        +`giving up on them and only reading ${HOST} from now on`);
                }

            }
            else{
                workerFailures=0;
            }

            return {
                status:reply.status,
                url,
                header:name=>name==="retry-after"&&reply.retryAfter?String(reply.retryAfter):null,
                text:async()=>reply.html||""
            };

        },

        // A 403 on a CROSS-SITE read is the service worker's request carrying none of the page's
        // cookies. It is not this crawler's pace, and it has never once cleared by waiting - the
        // same URL opened in a tab comes back straight away.
        //
        // Letting it fall through to the refusal branch cost the run twice over: every one of them
        // parked EVERY worker for up to thirty seconds and took a slot out of the pool, and the
        // detail phase of a .com search hits it on nearly every company (that is what the
        // WORKER_GIVE_UP counter below is already counting). "stop" ends this URL's ladder without
        // charging the pool for it; the tab fallback still picks it up, because the 403 has already
        // been recorded as this URL's last answer.
        inspect:(response,url)=>{

            if(response.status!==403) return;

            try{
                if(new URL(url).origin!==ORIGIN) return "stop";
            }
            catch(e){
                // an unparseable URL is not the case this is here for
            }

        },

        // Two refusals in a row are answered by a real navigation, not by the rest of the ladder -
        // but only while there is a tab left to open. See core.makeFetcher.
        canEscalate:()=>tabs.available

    });

    // A 429/403/5xx is often "that did not look like a browser" rather than "too fast", and no
    // amount of backing off answers it. Reopening the URL as a real navigation does, and if the
    // check needs a person the tab is put in front of them - once, for the whole site.
    const tabs=core.makeTabFallback({
        log:LOG,
        report,
        lastStatus:fetcher.lastStatus,

        // A Glassdoor job page is well over a megabyte, almost all of it the page's own JSON, and
        // three fields are read out of it. Asking for the overview block alone means that megabyte
        // is not cloned across the tab boundary twice and not handed to DOMParser at the end of it.
        extract:OVERVIEW_SELECTORS,

        // The tab path is the whole crawl once the fetches are being refused, and it used to be one
        // tab at a time. Now it is a pool - set to the same "parallel" the fetches use, see below -
        // so the page budget buys several times the pages per minute it used to.
        budget:250,


        describe:url=>{

            try{
                return new URL(url).pathname;
            }
            catch(e){
                return url;
            }

        }
    });

    // A tab navigation kills the content script outright - no catch block runs and nothing is
    // written. The checkpoint turns that from "the whole run is gone" into "the next run starts
    // where this one stopped".
    const checkpoint=core.makeCheckpoint("gdCheckpoint",{log:LOG});

    // set the moment the file is handed to the browser, so the crash path can never write a second one
    let fileWritten=false;

    let resumed=0;

    try{

        //---------------------------------------------------
        // 0. XLSX must be injected into the tab BEFORE content.js
        //---------------------------------------------------

        if(typeof XLSX==="undefined"){

            const msg="XLSX is not loaded in this tab. popup.js must inject xlsx.full.min.js before content.js.";
            console.error(LOG,msg);
            alert(msg);
            return;

        }

        //---------------------------------------------------
        // 1. read the settings saved by the popup
        //---------------------------------------------------

        let maxClicks=0;
        let concurrency=6;
        let sizes=[];

        try{

            const settings=await chrome.storage.local.get(["maxClicks","concurrency","sizes"]);

            maxClicks=+settings.maxClicks||0;

            if(settings.concurrency) concurrency=Math.min(12,Math.max(1,+settings.concurrency));

            // only accept the checkbox keys content.js knows about
            if(Array.isArray(settings.sizes)) sizes=settings.sizes.filter(key=>SIZE_BUCKET[key]);

        }
        catch(e){
            console.warn(LOG,"could not read settings, loading everything",e);
        }

        // the setting is the ceiling, not a fixed width: the gate drops below it while refused
        gate.limit=concurrency;
        gate.maxLimit=concurrency;

        // ...but never below half of it. A refusal is worth narrowing for; it is not worth going
        // serial for, because what actually rescues those pages is a tab, and tabs are per-page.
        gate.minLimit=Math.max(1,Math.ceil(concurrency/2));

        // The same width on the tab side. This is the one that decides whether a run whose fetches
        // are all refused is parallel at all: past that point every page is a tab, and the tab
        // worker used to open exactly one at a time whatever this said.
        tabs.setLimit(concurrency);

        //---------------------------------------------------
        // 1b. pick up an unfinished run on the same search
        //     "Show more jobs" has to be clicked from the top every time, so a run that died
        //     after 60 clicks was 60 clicks of work with nothing to show for it.
        //---------------------------------------------------

        const saved=await checkpoint.load();

        if(saved&&Array.isArray(saved.jobs)&&saved.jobs.length){

            for(const job of saved.jobs){

                if(!job||!job.id||visited.has(job.id)) continue;

                visited.add(job.id);
                jobs.push(job);
                resumed++;

            }

            report(`Resumed ${resumed} job(s) from an unfinished run on this search.`);

        }

        //---------------------------------------------------
        // 2. read the whole list currently loaded BEFORE clicking "Show more jobs",
        //    repeating until there are no jobs left
        //---------------------------------------------------

        const plan=plannedClicks(maxClicks);

        if(plan.source==="auto"){
            console.log(LOG,`"${plan.title}" -> ${plan.total} jobs, ${plan.perPage} per page `
                +`-> ${plan.clicks} click(s) needed`);
        }
        else if(plan.source==="none"){
            console.warn(LOG,"could not read the job count, clicking until the button disappears");
        }

        const loading=await crawlAllPages(plan.clicks);

        console.log(LOG,`read ${loading.rounds} batch(es), clicked "Show more jobs" ${loading.clicks} time(s), `
            +`${loading.cards} card(s) -> ${jobs.length} jobs`+(loading.stoppedEarly?" (stopped early)":""));

        // The heading counts every matching job, the list serves far fewer: "Show more jobs"
        // disappears after a few hundred cards. That gap is Glassdoor's, not a crawl error.
        if(plan.total&&loading.cards<plan.total){
            console.warn(LOG,`the heading claims ${plan.total} jobs but the list only served `
                +`${loading.cards}: Glassdoor stops loading more`
                +(loading.stoppedEarly?"":" (its \"Show more jobs\" button was gone)"));
        }

        if(jobs.length===0){

            alert(`No jobs found. Open a ${HOST} job search page and run again.`);
            return;

        }

        //---------------------------------------------------
        // 3. group by company
        //---------------------------------------------------

        const companies=buildCompanies(jobs);

        console.log(LOG,`${jobs.length} jobs -> ${companies.length} companies`);

        //---------------------------------------------------
        // 4. Industry / Revenue / Employees live in the "Company overview" block of the
        //    JOB PAGE and are not on the card -> one request per company
        //---------------------------------------------------

        let failed=0;
        let processed=0;
        let withOverview=0;

        await core.mapPool(companies,concurrency,async(company,index)=>{

            company.failed=false;

            // a copy of this listing on the local domain is only worth having if it actually
            // carries the overview - that block is the entire reason for the request
            const doc=company.jobUrl
                ?await fetchDoc(company.jobUrl,{
                    accept:hasOverview,

                    // parse the overview block, not the megabyte of JSON around it - see
                    // sliceOverview. `sliced` is the check that the cut landed on the real block;
                    // when it did not, the whole page is parsed as before and nothing is lost.
                    slice:sliceOverview,
                    sliced:hasOverview
                })
                :null;

            if(!doc){

                failed++;

                // marked so the retry pass can come back for it once the queue has drained: a
                // blank overview is indistinguishable from "Glassdoor publishes none for them"
                if(company.jobUrl) company.failed=true;

            }
            else{

                const overview=overviewOf(doc);

                company.industry=overview.industry||"";
                company.revenue=overview.revenue||"";

                // "Employees" on the current layout, "Size" on the older one
                company.employees=overview.employees||overview.size||"";

                if(company.industry||company.revenue||company.employees) withOverview++;
                else if(index<3) console.warn(LOG,"no company overview on",company.jobUrl);

            }

            if(!company.counted){
                company.counted=true;
                processed++;
            }

            report(`[${processed}/${companies.length}] ${company.name}`);

        },{
            log:LOG,
            shouldRetry:company=>company.failed===true,
            onRetryPass:count=>report(`Retrying ${count} company page(s) that failed...`)
        });

        //---------------------------------------------------
        // 5. filter by headcount
        //    Size is only known after reading the job page -> filtering here only trims
        //    rows from the file, it saves no requests.
        //---------------------------------------------------

        let rows=companies;
        let dropped=0;
        let droppedUnknown=0;

        if(sizes.length){

            rows=companies.filter(company=>matchesSize(company.employees,sizes));

            dropped=companies.length-rows.length;
            droppedUnknown=companies.filter(company=>!sizeRange(company.employees)).length;

            console.log(LOG,`company size filter [${sizes.join(", ")}] kept `
                +`${rows.length}/${companies.length} companies`
                +(droppedUnknown?` (${droppedUnknown} had no employee count)`:""));

        }

        //---------------------------------------------------
        // 6. export to excel + trigger the download
        //---------------------------------------------------

        finish({rows,companies:companies.length,plan,loading,withOverview,failed,
            sizes,dropped,droppedUnknown,crashed:null});

    }
    catch(e){

        console.error(LOG,"crawl aborted:",e);

        // Everything collected up to the crash is real data. Throwing it away because the last
        // step failed is the single most expensive thing this crawler used to do.
        salvage(e);

    }
    finally{

        window.__gdCrawlerRunning=false;

    }

    //---------------------------------------------------
    // helper: write the file
    //---------------------------------------------------

    function finish(state){

        // the crash path calls this too, and an exception raised INSIDE it would come back round
        // and download a second copy of the same file
        if(fileWritten) return;

        fileWritten=true;

        // fixed header: companies with missing data must still keep all 8 columns
        const HEADERS=["Company Name","Industry","Revenue","Location","Positions",
            "Recruitment time","Employees","Remote/Onsite"];

        const results=state.rows.map(company=>({
            "Company Name":company.name,
            "Industry":company.industry,
            "Revenue":company.revenue,
            "Location":company.locations.join(", "),
            "Positions":company.positions.join(" | "),
            "Recruitment time":company.posted,
            "Employees":company.employees,
            "Remote/Onsite":company.modes.join(", ")
        }));

        const written=core.exportXlsx(results,{
            headers:HEADERS,
            widths:[30,26,20,22,60,16,18,16],
            filename:FILENAME,
            log:LOG
        });

        const withTime=results.filter(r=>r["Recruitment time"]).length;
        const elapsed=Math.round((performance.now()-startedAt)/1000);

        const plan=state.plan||{total:0};
        const loading=state.loading||{clicks:0};

        const summary=`Done in ${elapsed}s on ${HOST}: ${results.length} companies from ${jobs.length} jobs`
            +(plan.total?` (the heading claims ${plan.total})`:"")
            +` (${loading.clicks} load-more clicks), ${state.withOverview} with company overview, `
            +`${withTime} with recruitment time, ${state.failed} request errors`+describeFailures()
            +(state.sizes&&state.sizes.length?`, ${state.dropped} dropped by the size filter`
                +(state.droppedUnknown?` (${state.droppedUnknown} of them had no size)`:""):"")
            +"."
            +(resumed?`\nResumed ${resumed} job(s) from an earlier unfinished run.`:"")
            +(sameSite.describe()?`\n${sameSite.describe()}`:"")
            +(tabs.describe()?`\n${tabs.describe()}`:"")
            +(written.clipped?`\n${written.clipped} cell(s) truncated to fit Excel's 32,767 character limit.`:"")
            +(state.crashed?`\n\nThe run stopped early: ${state.crashed}.`
                +"\nEverything collected before that point is in the file above.":"");

        report(summary);

        // when most company pages were refused there is something to do about it, so say what
        const advice=state.companies&&state.failed>state.companies/2
            ? "\n\nMost company pages were refused. Two things usually fix it:"
              +"\n- run the crawler on the site the jobs live on (the job links here point at "
              +hostOfFirstJob()+"), so every read stays on one domain"
              +"\n- lower \"parallel\" in the popup to 2-3"
            : "";

        // the run reached the file, so there is nothing left to resume
        if(!state.crashed) checkpoint.clear();

        // let the download start before the alert blocks the page
        setTimeout(()=>alert(summary+"\nSaved as "+FILENAME+advice),0);

    }

    // build the file out of whatever survived the crash
    function salvage(error){

        try{

            if(jobs.length===0){
                alert("Crawl failed before anything was collected: "+(error&&error.message||error));
                return;
            }

            finish({
                rows:buildCompanies(jobs),
                companies:0,
                plan:null,
                loading:null,
                withOverview:0,
                failed:0,
                sizes:[],
                dropped:0,
                droppedUnknown:0,
                crashed:(error&&error.message||String(error))
            });

        }
        catch(e){

            console.error(LOG,"could not salvage the run either:",e);

            alert("Crawl failed: "+(error&&error.message||error)+"\nOpen DevTools console for details.");

        }

    }

    //---------------------------------------------------
    // helper: how many clicks are needed
    // When "max clicks" is left blank -> derive it from the total job count in the title
    // divided by the number of cards currently shown for one page.
    //---------------------------------------------------

    function plannedClicks(setting){

        if(setting) return {clicks:setting,source:"setting",total:0,perPage:0,title:""};

        const title=norm(document.querySelector(SEARCH_TITLE));
        const total=readJobCount(title);
        const perPage=countCards();
        const clicks=autoClicks(total,perPage);

        return {clicks,source:clicks?"auto":"none",total,perPage,title};

    }

    // "387 Remote jobs", "1,234 jobs in Singapore", "20,000+ jobs"
    function readJobCount(title){

        const match=(title||"").match(/([\d,]+)\s*\+?/);

        return match?+match[1].replace(/,/g,""):0;

    }

    // the first page already holds perPage cards -> only the rest needs clicking
    function autoClicks(total,perPage){

        if(!total||!perPage) return 0;

        return Math.min(MAX_AUTO_CLICKS,Math.max(0,Math.ceil(total/perPage)-1));

    }

    //---------------------------------------------------
    // helper: read the whole loaded list BEFORE clicking "Show more jobs"
    // Glassdoor loads more through JS with no ?page= -> the button has to be clicked for real.
    // Each round reads first, then clicks exactly once and waits for the new batch to appear
    // before clicking again, so two clicks never overlap.
    // Stops when: the button disappears, or two clicks in a row do not grow the card count
    // (usually a login wall).
    //---------------------------------------------------

    async function crawlAllPages(maxClicks){

        let clicks=0;
        let stuck=0;
        let rounds=0;
        let stoppedEarly=false;

        for(;;){

            // read first: old cards are already in visited, so only new ones are taken
            const found=collectFrom(document);

            rounds++;

            report(`Batch ${rounds}: +${found.added} job(s), ${jobs.length} total`);

            const button=document.querySelector(LOAD_MORE);

            // no button left = the whole list has been loaded
            if(!button||button.disabled) break;

            if(maxClicks&&clicks>=maxClicks){
                console.log(LOG,"reached the max clicks setting");
                stoppedEarly=true;
                break;
            }

            const before=countCards();

            // scroll to the button to be safe: Glassdoor only loads more when it is in the viewport
            if(button.scrollIntoView) button.scrollIntoView({block:"center"});

            const started=performance.now();

            button.click();

            clicks++;

            // wait for the new batch to appear AND finish rendering before reading it and clicking
            // again. The wait ends the moment the DOM stops changing, so a fast batch is not made
            // to sit out a fixed poll interval and a slow one is not read half-written.
            const grew=await waitForBatch(before,batchTimeout());

            if(grew) batchMs.push(performance.now()-started);

            if(!grew){

                stuck++;

                // A click that did not grow the list is usually the end - but not always: the
                // button no-ops when it is scrolled out of view or the request behind it was
                // rate limited. Giving up on the second one cost the tail of the list, so the
                // retries now nudge the page and wait longer each time before believing it.
                if(stuck>=STUCK_LIMIT){
                    console.warn(LOG,`${stuck} clicks in a row did not load more - a login wall or `
                        +"the end of the list. Stopping.");
                    stoppedEarly=true;
                    break;
                }

                window.scrollBy(0,-200);

                await sleep(600*stuck);

                continue;

            }

            stuck=0;

            await checkpoint.save({jobs});

        }

        // One last read, after the loop has decided the list is over.
        //
        // Every round reads at the TOP, so a batch that was still rendering when it was read is
        // picked up by the next round - except the final one, which has no next round. That made
        // the settle inside waitForBatch load-bearing for data rather than just for pacing: cut it
        // and the tail of the last batch was silently lost. Reading once more here costs one pass
        // over cards that are nearly all in `visited` already, and takes that job away from a
        // timing constant, where it never belonged.
        const last=collectFrom(document);

        if(last.added) console.log(LOG,`${last.added} card(s) arrived after the last batch was read`);

        return {clicks,rounds,cards:countCards(),stoppedEarly};

    }

    function countCards(){
        return document.querySelectorAll(CARD).length;
    }

    //---------------------------------------------------
    // how long to give a batch
    //
    // The flat 15 second ceiling was only ever right for the LAST three clicks of a run - the ones
    // that are waiting to find out the list has ended. Every other click finishes in a second or
    // two, and the ceiling never applied to them. But the last three always paid it in full, so
    // ending a run cost 45 seconds of watching nothing happen.
    //
    // Once a few real batches have been timed, the ceiling comes from them instead: four times the
    // slowest one seen. That is far more patient than any batch has actually needed and far less
    // patient than 15 seconds, and on a genuinely slow connection it grows by itself.
    //---------------------------------------------------

    function batchTimeout(){

        if(batchMs.length<TIMING_SAMPLE) return LOAD_TIMEOUT;

        const slowest=Math.max.apply(null,batchMs);

        return Math.min(LOAD_TIMEOUT,Math.max(MIN_TIMEOUT,slowest*4));

    }

    //---------------------------------------------------
    // wait for the next batch of cards to arrive and finish rendering
    //
    // This used to be a 250ms poll that ran document.querySelectorAll over the whole page every
    // time - on a list that grows to a thousand cards, four full-document scans a second for the
    // entire run - and then slept a further flat 120ms in case the batch was not done. Watching
    // the DOM instead costs nothing while nothing is happening, notices the batch the moment it
    // lands, and knows it is complete when the changes stop.
    //---------------------------------------------------

    function waitForBatch(before,timeout){

        return new Promise(resolve=>{

            let settle=null;
            let backstop=null;
            let cap=null;
            let done=false;

            const finish=grew=>{

                if(done) return;

                done=true;

                clearTimeout(settle);
                clearInterval(backstop);
                clearTimeout(cap);

                observer.disconnect();

                resolve(grew);

            };

            // counting is the expensive part, so it happens once per quiet moment rather than
            // once per mutation - a batch of thirty cards is thirty mutations and one count
            const check=()=>{
                if(countCards()>before) finish(true);
            };

            const observer=new MutationObserver(()=>{

                clearTimeout(settle);

                settle=setTimeout(check,BATCH_SETTLE);

            });

            // The list is re-rendered by React rather than appended to in place, so the container
            // itself can be replaced. Watching the document covers both, and the debounce above is
            // what keeps that from being expensive.
            observer.observe(document.documentElement,{childList:true,subtree:true});

            backstop=setInterval(check,BACKSTOP_POLL);

            cap=setTimeout(()=>finish(countCards()>before),timeout);

            // the batch may have landed between the click and this line
            check();

        });

    }

    //---------------------------------------------------
    // helper: collect jobs from the loaded list
    //---------------------------------------------------

    function collectFrom(root){

        const cards=root.querySelectorAll(CARD);

        let added=0;

        cards.forEach(card=>{

            const id=card.getAttribute("data-jobid");

            if(!id||visited.has(id)) return;

            visited.add(id);

            jobs.push(readCard(card,id));

            added++;

        });

        if(cards.length===0){
            console.warn(LOG,'no [data-test="jobListing"] on this page');
        }

        return {cards:cards.length,added};

    }

    //---------------------------------------------------
    // helper: read one card
    // Glassdoor hashes its class names per build -> rely only on data-test and id.
    //---------------------------------------------------

    function readCard(card,id){

        const title=card.querySelector('[data-test="job-title"]');
        const location=pick(card,'[data-test="emp-location"]');

        const posted=pick(card,'[data-test="job-age"]');
        const age=posted.match(POSTED);

        // MODULE:n=jsearch-job-listing:eid=658:jlid=1010217143323 -> eid is the company id
        const brand=card.getAttribute("data-brandviews")||"";
        const employerId=(brand.match(/eid=(\d+)/)||[])[1]||"";

        return {
            id,
            employerId,
            title:norm(title),
            company:readCompany(card),
            location,
            postedText:posted,
            postedAge:age?+age[1]*UNIT[age[2].toLowerCase()]:Infinity,
            jobUrl:title?absolute(title.getAttribute("href")):""
        };

    }

    // The company name lives in the #job-employer-<id> block, right next to the rating
    // ("Thermo Fisher Scientific" + "3.5") -> drop fragments that are only a number.
    function readCompany(card){

        const box=card.querySelector('[id^="job-employer-"]')||card;

        const parts=blocks(box).filter(text=>!/^\d(\.\d+)?$/.test(text));

        return parts[0]||"";

    }

    function absolute(href){
        return href?new URL(href,ORIGIN).toString():"";
    }

    //---------------------------------------------------
    // helper: the "Company overview" block of a job page
    // -> {employees:"51 to 200 Employees", industry:"...", revenue:"$10+ billion (USD)"}
    // Two layouts are in the wild, and the newer one puts the VALUE before the label:
    //
    //   <div class="CompanyOverview_companyOverviewItem__...">
    //     <span class="...companyOverviewItemValue__...">51 to 200 Employees</span>
    //     <span class="...companyOverviewItemLabel__...">Employees</span>
    //
    //   <div class="JobDetails_overviewItem__..."><span>Size</span><div>10000+ Employees</div>
    //
    // The class names are hashed per build, so match on the stable part only, case-insensitively
    // ("overviewItem" vs "companyOverviewItem").
    //---------------------------------------------------

    function overviewOf(doc){

        let found=overviews.get(doc);

        if(!found){

            found=readOverview(doc);

            overviews.set(doc,found);

        }

        return found;

    }

    function readOverview(doc){

        const out={};

        for(const value of doc.querySelectorAll('[class*="overviewItemValue" i]')){

            const row=value.parentElement;
            const label=row&&row.querySelector('[class*="overviewItemLabel" i]');

            if(label) out[norm(label).toLowerCase()]=norm(value);

        }

        if(Object.keys(out).length) return out;

        // older layout: label first, value after
        for(const item of doc.querySelectorAll('[class*="overviewItem" i]')){

            const parts=blocks(item);

            if(parts.length>=2) out[parts[0].toLowerCase()]=parts.slice(1).join(" ");

        }

        if(Object.keys(out).length) return out;

        // fallback when the class is renamed: find it by heading and pair up label/value
        for(const heading of doc.querySelectorAll("h2")){

            if(!/company overview/i.test(norm(heading))) continue;

            const grid=heading.nextElementSibling;

            if(!grid) continue;

            const parts=blocks(grid);

            for(let i=0;i+1<parts.length;i+=2) out[parts[i].toLowerCase()]=parts[i+1];

            break;

        }

        return out;

    }

    //---------------------------------------------------
    // helper: filter by headcount
    // Glassdoor uses its own ranges ("1 to 50 Employees", "10000+ Employees"), which do not
    // line up with the checkboxes -> compare by testing whether the two ranges overlap.
    // "1 to 50" overlaps 1-10, 11-20 and 21-50 alike.
    //---------------------------------------------------

    function sizeRange(text){

        if(!text) return null;

        const clean=String(text).replace(/,/g,"");

        // "51 to 200", "51-200", "51 – 200"
        const span=clean.match(/(\d+)\s*(?:to|–|—|-)\s*(\d+)/i);

        if(span) return [+span[1],+span[2]];

        // "10000+", "more than 10000", "over 10000"
        const open=clean.match(/(?:more than|over)\s*(\d+)|(\d+)\s*\+/i);

        if(open) return [+(open[1]||open[2]),Infinity];

        const one=clean.match(/\d+/);

        return one?[+one[0],+one[0]]:null;

    }

    function matchesSize(text,sizes){

        const range=sizeRange(text);

        // with no readable headcount there is no way to claim a match
        if(!range) return false;

        return sizes.some(key=>{

            const bucket=SIZE_BUCKET[key];

            return bucket&&range[0]<=bucket[1]&&range[1]>=bucket[0];

        });

    }

    //---------------------------------------------------
    // helper: group jobs by company
    //---------------------------------------------------

    function buildCompanies(list){

        const map=new Map();

        for(const job of list){

            const name=job.company||"(unknown)";

            // group by employer id when the card carried one: the same company written two ways
            // ("Thermo Fisher Scientific" / "Thermo Fisher") still lands on one row. Falling back
            // to the folded name rather than the raw one keeps "ACME Ltd" and "ACME Ltd." together.
            const key=job.employerId?"id:"+job.employerId:"name:"+core.nameKey(name);

            let company=map.get(key);

            if(!company){

                company={
                    name,
                    employerId:job.employerId,
                    jobs:0,
                    locations:[],
                    positions:[],
                    modes:[],
                    posted:"",
                    postedAge:Infinity,
                    jobUrl:job.jobUrl,
                    industry:"",
                    revenue:"",
                    employees:""
                };

                map.set(key,company);

            }

            company.jobs++;

            push(company.positions,job.title);
            push(company.locations,job.location);
            push(company.modes,readMode(job.location));

            // the newest listing, and its URL as the one to read the Company overview from
            if(job.postedAge<company.postedAge){
                company.postedAge=job.postedAge;
                company.posted=job.postedText;
                company.jobUrl=job.jobUrl;
            }

        }

        // most listings first, then alphabetically on a tie
        return [...map.values()].sort((a,b)=>b.jobs-a.jobs||a.name.localeCompare(b.name));

    }

    function push(list,value){
        if(value&&!list.includes(value)) list.push(value);
    }

    // Glassdoor puts the work location in a single field: "Remote", "Hybrid" or a city name.
    // A city name means working at that place -> Onsite.
    function readMode(text){

        if(!text) return "";

        if(/hybrid/i.test(text)) return "Hybrid";
        if(/remote|work from home/i.test(text)) return "Remote";

        return "Onsite";

    }

    //---------------------------------------------------
    // helper: fetch + parse a job page
    // A search lists jobs of the whole region, so on glassdoor.com the links point at
    // glassdoor.com.au, .co.uk, ... Reading those through the service worker earns a 403:
    // the request leaves the extension without the cookies, referer and headers the page has,
    // and Glassdoor turns it away. The same listing is served under the same path on the site
    // we are already on -> ask our own origin first, and keep the original URL as a fallback.
    //---------------------------------------------------

    // Three ways to get one page, cheapest first.
    //
    // `opts.accept` decides whether a page that came back is the page we wanted. Without it the
    // same-site guess won: Glassdoor answers an unknown /job-listing/ path on the local domain
    // with a 200 that carries no Company overview, and `if(doc) return doc` then took it and
    // never tried the real URL - so the row came out blank while the listing was readable all
    // along. A rejected candidate is still kept, in case nothing better arrives.
    //
    // Only once BOTH plain fetches have been refused is a tab opened, and only for the original
    // URL: a tab load is seconds rather than milliseconds, so spending two of them on the same
    // listing would be paying twice for one answer.
    async function fetchDoc(url,opts){

        const candidates=sameSiteFirst(url);
        const accept=opts&&opts.accept;

        // Every recent page has needed a tab, so walking the candidates first would only be delay:
        // none of them are coming back either. core.tabFirst does this for the crawlers whose
        // fetchDoc is a single URL; this one has to do it itself because it has candidates.
        if(tabs.preferred){

            const early=await tabs.fetchDoc(candidates[candidates.length-1]);

            if(early) return early;

        }

        let fallback=null;

        for(let i=0;i<candidates.length;i++){

            const guess=i<candidates.length-1;

            const doc=await fetcher.fetchDoc(candidates[i],opts);

            if(!doc){

                if(guess) sameSite.missed();

                continue;

            }

            tabs.clean();

            // the last candidate is the original URL: there is nothing left to prefer over it
            if(!accept||!guess||accept(doc)){

                if(guess) sameSite.worked();

                return doc;

            }

            sameSite.missed();

            console.warn(LOG,"same-site copy had no company overview, trying",candidates[i+1]);

            fallback=fallback||doc;

        }

        if(fallback) return fallback;

        return tabs.fetchDoc(candidates[candidates.length-1]);

    }

    //---------------------------------------------------
    // is the same-site guess worth making?
    //
    // Rewriting a .com.au job URL onto the site we are already on is free when it works, because
    // the request stays same-origin and keeps the page's cookies. When it does NOT work it costs a
    // whole extra request per company, and whether it works is a property of the search, not of
    // the listing: either this domain mirrors the region's job pages or it does not.
    //
    // So it is measured once instead of assumed every time. After PROBE guesses with nothing to
    // show for them the crawler stops making it, which halves the requests in the detail phase -
    // the longest part of a Glassdoor run. One success is enough to keep it: it means the mirror
    // is real and the misses were something else.
    //---------------------------------------------------

    function sameSiteFirst(url){

        let target;

        try{
            target=new URL(url);
        }
        catch(e){
            return [url];
        }

        if(target.origin===ORIGIN) return [url];

        const local=new URL(target.pathname+target.search,ORIGIN).toString();

        // the worker refusing cross-site reads leaves the local copy as the only thing left to try
        if(workerFailures>=WORKER_GIVE_UP) return [local];

        return sameSite.worthGuessing?[local,url]:[url];

    }

    // which Glassdoor site the listings actually belong to (a .com search lists .com.au jobs)
    function hostOfFirstJob(){

        const job=jobs.find(item=>item.jobUrl);

        try{
            return job?new URL(job.jobUrl).hostname:HOST;
        }
        catch(e){
            return HOST;
        }

    }

    function describeFailures(){

        const text=fetcher.describe();

        return text?` (${text})`:"";

    }

})();
