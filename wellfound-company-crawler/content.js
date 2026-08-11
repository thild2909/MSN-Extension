(async()=>{

    const LOG="[wf-crawler]";

    //---------------------------------------------------
    // guard against double runs when the button is clicked repeatedly
    //---------------------------------------------------

    if(window.__wfCrawlerRunning){
        alert("Crawler is already running on this tab. Wait for it to finish.");
        return;
    }

    window.__wfCrawlerRunning=true;

    const core=window.CrawlerCore;

    if(!core){

        alert("core.js is not loaded in this tab. popup.js must inject core.js before content.js.");

        window.__wfCrawlerRunning=false;

        return;

    }

    // "501-1000 Employees" sitting alone in its own element
    const SIZE_EXACT=/^[\d,]+(\s*[-–—]\s*[\d,]+|\s*\+)?\s*(employees|people)$/i;

    // the same string, but embedded in a longer piece of text
    const SIZE_LOOSE=/[\d,]+(?:\s*[-–—]\s*[\d,]+|\s*\+)?\s*(?:employees|people)/i;

    // when scanning a whole detail page, only accept "employees" to limit false positives
    const SIZE_DOC=/[\d,]+(?:\s*[-–—]\s*[\d,]+|\s*\+)?\s*employees/i;

    // How the job is worked. Anchored at BOTH ends on purpose: it is matched against the
    // text before the separator, which must be the mode and nothing else.
    const WORK_MODE=/^(?:remote(?:\s+only)?|onsite(?:\s+or\s+remote)?|on[-\s]?site|in[-\s]office|in[-\s]person|hybrid)$/i;

    // Mode and place are split by a bullet, but the glyph has changed before -> accept any
    const LOC_SEP=/\s*[•·∙●|–—]\s*/;

    // "San Francisco +1" - the +N badge is a nested span, so it rides along in the text
    const LOC_BADGE=/\s*\+\s*\d+\s*$/;

    // "Posted 3 days ago", "1 week ago", "Recently posted", "Today"
    const POSTED=/(?:posted\s+)?(?:\d+\s*\+?\s*(?:minute|min|hour|hr|day|week|month|year)s?\s+ago|just\s+now|yesterday|today|recently(?:\s+posted)?)/i;

    // Wellfound job links: /jobs/123-title or the short form /l/123
    const JOB_LINK='a[href*="/jobs/"], a[href^="/l/"]';

    const COMPANY_CARD='[data-testid="startup-header"]';

    // anchors pointing at /jobs/ that are not one specific position
    const JOB_NOISE=/^(?:jobs?|all jobs|see (?:all|more).*|view (?:all|more).*|show more|\d+\s+jobs?|apply(?:\s+now)?)$/i;

    // how far past the last advertised page to look before giving up (see the tail walk)
    const TAIL_PROBE=5;

    // consecutive 403s that mean "blocked", not "slow down" (see the forbidden breaker)
    const FORBIDDEN_LIMIT=8;

    // ...and how many of the requests this breaker turns away are worth one that goes out anyway,
    // to find out whether it still is. The breaker used to latch for the whole run - `tripped` was
    // set and never cleared - so a bad half minute at company 40 committed all 800 after it to a
    // tab load each, long after Wellfound had stopped minding.
    //
    // Small on purpose, because it MULTIPLIES with the tab fallback's own re-test: once tabs are
    // carrying the run, core.tabFirst does not consult this guard at all except on the pages where
    // the fallback has deliberately let the cheap path go first (every preferAfter+recheck = 13th).
    // At 25 the two together came to one plain request per 325 pages, which on any real search is
    // the same as never.
    const FORBIDDEN_RECHECK=2;

    // The pace floor is zero on purpose. A fixed 150ms toll was paid on every one of ~1,700
    // requests whether or not Wellfound minded - about four minutes of a run spent waiting for
    // nothing. The gate below widens the moment anything is actually refused, so being rate
    // limited is what slows the crawler down, not the fear of it.
    const gate=core.makeGate({minGap:0,limit:6,log:LOG});

    // Circuit breaker for 403. If Wellfound is blocking detail pages outright rather than
    // rate limiting, retrying 855 companies x 5 attempts x growing backoff would hang for
    // half an hour and still export nothing. After FORBIDDEN_LIMIT refusals in a row, stop
    // asking for detail pages and finish the run from the list-page data we already hold.
    const forbidden={

        streak:0,
        total:0,
        tripped:false,

        // `tripped` can now be cleared again, so it no longer answers "did this run get blocked?"
        // - and that is the question the summary asks, to explain a column filled from tabs
        everTripped:false,

        // requests the guard has skipped since the last one it let through - see FORBIDDEN_RECHECK
        skipped:0,

        hit(url){

            this.streak++;
            this.total++;

            if(this.streak>=FORBIDDEN_LIMIT&&!this.tripped){

                this.tripped=true;
                this.everTripped=true;

                console.warn(LOG,`${this.streak} requests in a row returned 403 (last: ${url}).`
                    +" Wellfound is blocking detail pages - they will be reopened in a background"
                    +" tab instead, and a plain request tried again now and then in case that stops.");

            }

        },

        // True while the cheap path is not worth sending - except for every FORBIDDEN_RECHECK-th
        // request, where one is let through to see whether the block has lifted.
        blocked(){

            if(!this.tripped) return false;

            // Nothing else is going to read these pages, so a request that will probably be
            // refused has stopped being the more expensive option - it is the only one left. What
            // it costs in cooldowns is bounded by the gate, which writes the session off once it
            // has waited long enough; a page nobody asks for is simply blank in the file.
            if(!tabs.available) return false;

            if(++this.skipped<FORBIDDEN_RECHECK) return true;

            this.skipped=0;

            // give the probe a clean run at FORBIDDEN_LIMIT rather than judging it on refusals
            // that happened before the whole rest of the run had a chance to cool off
            this.streak=0;

            return false;

        },

        // a refusal that is NOT 403 - a 429 is about pace, and it breaks the 403 streak without
        // saying the block has gone
        ok(){
            this.streak=0;
        },

        // a plain request came back with a page: the cheap path works again
        clear(){

            this.streak=0;
            this.skipped=0;

            if(!this.tripped) return;

            this.tripped=false;

            console.log(LOG,"a plain request came back - using the cheap path again");

        }

    };

    const fetcher=core.makeFetcher(gate,{
        log:LOG,
        // Wellfound answers 403, not 429, when it decides we are asking for company pages too
        // fast, so a 403 has to go round the backoff ladder like any other rate limit.
        onRefused:(status,url)=>{

            if(status===403) forbidden.hit(url);
            else forbidden.ok();

        },

        // Two refusals in a row are answered by a real navigation, not by the rest of the ladder -
        // but only while there is a tab left to open. See core.makeFetcher.
        canEscalate:()=>tabs.available
    });

    // Once the breaker is open every further FETCH is a guaranteed 403 plus a cooldown, so the
    // guard stops sending them. It no longer ends the story though: a run of 403s is exactly the
    // shape of a bot check, and a bot check is answered by a real navigation rather than by
    // waiting. tabFirst takes over from here, and only the tab budget bounds it.
    const cheap=(url,opts)=>fetcher.fetchDoc(url,Object.assign({
        guard:()=>forbidden.blocked(),
        onOk:()=>forbidden.clear()
    },opts||{}));

    const tabs=core.makeTabFallback({
        log:LOG,
        report:text=>report(text),
        lastStatus:fetcher.lastStatus,
        describe:url=>url.replace(/^https?:\/\/[^/]+\/company\//,"")
    });

    const fetchDoc=(url,opts)=>core.tabFirst({fetchDoc:cheap},tabs,url,opts);

    // kept outside the try: collectFrom/push are helpers at the end of the file and cannot see block-scoped declarations
    const unique=[];
    const visited=new Set();

    const stats={
        companyDupes:0,   // company card seen again -> dropped by push()
        jobsSeen:0,       // total job entries read across every list page
        cards:0,          // company cards found on list pages
        cardsNoLink:0,    // cards with no /company/ anchor -> skipped entirely
        cards3Plus:0,     // cards rendering 3+ jobs -> Wellfound is likely capping the card
        skippedNoSize:0   // dropped by the size filter with no size to judge them on
    };

    // one-shot: log the parsed shape of the first list card seen
    let dumpedListCard=false;

    const startedAt=performance.now();

    const report=core.makeReporter("wf-crawler-status",LOG);

    const norm=core.norm;
    const blocks=core.blocks;

    // A tab navigation kills the content script outright - no catch block runs and nothing is
    // written. The checkpoint turns that from "the whole run is gone" into "the next run starts
    // where this one stopped".
    const checkpoint=core.makeCheckpoint("wfCheckpoint",{log:LOG});

    // set the moment the file is handed to the browser, so the crash path can never write a second one
    let fileWritten=false;

    let recoveredPages=0;
    let resumed=0;

    // pages that never came back even after the retry pass
    let lostPages=[];

    try{

        //---------------------------------------------------
        // 0. XLSX must be injected into the tab BEFORE content.js
        //    (popup.js inject ["xlsx.full.min.js","content.js"])
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

        let buckets=[];
        let maxPages=0;
        let concurrency=6;

        try{

            const settings=await chrome.storage.local.get(["sizeFilter","maxPages","concurrency"]);

            buckets=settings.sizeFilter||[];
            maxPages=+settings.maxPages||0;

            if(settings.concurrency) concurrency=Math.min(12,Math.max(1,+settings.concurrency));

        }
        catch(e){
            console.warn(LOG,"could not read settings, exporting everything",e);
        }

        const ranges=buckets.map(parseRange).filter(Boolean);

        console.log(LOG,"size filter:",ranges.length?buckets.join(", "):"(none)");

        gate.limit=concurrency;
        gate.maxLimit=concurrency;

        // Wellfound refuses detail pages far more often than it rate limits them, so on this
        // crawler "every page needs a tab" is the ordinary case rather than the bad day. That
        // makes the tab worker's width the crawl's real width, and it was being left at the
        // worker's own default of 4 however wide the popup was set.
        tabs.setLimit(concurrency);

        // Wake the worker before the first refusal needs it, and say now - rather than after
        // twenty refused pages - if there is no worker to wake.
        if(await tabs.ready()) console.log(LOG,"tab fallback is ready");

        //---------------------------------------------------
        // 1b. pick up an unfinished run on the same search
        //     A crawl that died with the tab left its companies in storage; re-reading those
        //     pages costs requests to collect data we already had.
        //---------------------------------------------------

        const saved=await checkpoint.load();

        if(saved&&Array.isArray(saved.unique)&&saved.unique.length){

            for(const company of saved.unique){

                if(!company||!company.url||visited.has(company.url)) continue;

                visited.add(company.url);
                unique.push(company);
                resumed++;

                // these never go through push(), so their jobs have to be counted here or the
                // summary of a resumed run reads as though half its companies had no positions
                stats.jobsSeen+=(company.jobs||[]).length;

            }

            report(`Resumed ${resumed} compan${resumed===1?"y":"ies"} from an unfinished run on this search.`);

        }

        //---------------------------------------------------
        // 2. collect companies across every page
        //---------------------------------------------------

        const paging=readPagination();

        // must be read while the DOM is still the original list page
        const totals=readTotals();

        console.log(LOG,"platform totals:",totals);

        const lastPage=maxPages?Math.min(paging.last,maxPages):paging.last;

        const pages=[];

        for(let p=1;p<=lastPage;p++) pages.push(p);

        // the open page is always included: it is already in the DOM and costs no request
        if(!pages.includes(paging.current)) pages.unshift(paging.current);

        console.log(LOG,`pagination: current=${paging.current}, last=${paging.last}, crawling ${pages.length} page(s), concurrency=${concurrency}`);

        let pageErrors=0;
        let emptyStreak=0;
        let done=0;
        let stoppedEarly=false;

        // bookkeeping only, never changes what gets crawled: lets the summary name the
        // pages that were never parsed instead of leaving the gap unexplained
        const crawledPages=new Set();

        // No batch barrier. The old slice-then-Promise.all pattern paid the cost of the SLOWEST
        // page in every batch while every other worker sat idle; this keeps `concurrency` pages in
        // flight at all times and still consumes them strictly in page order, so unique[] stays
        // stable between runs.
        const walk=await core.pipelinePages(pages,page=>{

            // the open page: read the already rendered DOM directly, no request needed
            if(page===paging.current) return document;

            return fetchDoc(paging.pageUrl(page));

        },async (page,doc)=>{

            done++;

            if(!doc){

                pageErrors++;

                // A page that ERRORED is not a page that ran out of companies. Counting it towards
                // the empty streak is what used to end a crawl at page 9 of 45 after two unlucky
                // requests and still call it a finished run.
                report(`Page ${page} (${done}/${pages.length}): request failed, will retry at the end`);

                return "";

            }

            const found=collectFrom(doc);

            crawledPages.add(page);

            // cards vs added: "+15" alone cannot tell a short page from a page full of
            // companies already seen earlier, so print both
            report(`Page ${page} (${done}/${pages.length}): ${found.cards} cards, ${found.jobs} jobs,`
                +` +${found.added} new -> ${unique.length} companies`);

            await checkpoint.save({unique});

            // the HTML returned by the server may not include the list (client-side rendering)
            if(page!==paging.current&&found.cards===0) emptyStreak++;
            else emptyStreak=0;

            if(emptyStreak>=2){

                stoppedEarly=true;

                console.warn(LOG,"2 fetched pages in a row had no company cards - server HTML may not include the list. Stopping pagination.");

                return "stop";

            }

            return "";

        },{limit:concurrency,log:LOG});

        //---------------------------------------------------
        // 2b. second pass over the pages that never came back
        //     Whatever refused them has had the whole rest of the list to cool off by now, and
        //     each one is a page of companies that would otherwise be missing from the file with
        //     nothing at all to say they ever existed.
        //---------------------------------------------------

        // the breaker and a written-off gate only close the cheap path; a tab can still get
        // these, and a missed page is a whole page of companies
        if(walk.missed.length&&((!forbidden.tripped&&!gate.dead)||tabs.available)){

            report(`Retrying ${walk.missed.length} page(s) that failed...`);

            for(const page of walk.missed){

                const doc=await fetchDoc(paging.pageUrl(page),{tries:3});

                if(!doc){
                    lostPages.push(page);
                    continue;
                }

                const found=collectFrom(doc);

                crawledPages.add(page);
                recoveredPages++;

                report(`Recovered page ${page}: ${found.cards} cards, +${found.added} new`
                    +` -> ${unique.length} companies`);

            }

            await checkpoint.save({unique},true);

        }
        else{
            lostPages=walk.missed.slice();
        }

        // Tail walk: Wellfound's paginator only renders a window of page numbers
        // ("1 2 3 4 5 ... 22 23 24 ... 45"), so the largest link on the current page is not
        // always the real last page - the list can run one or two pages past it.
        // Walk forward until a page comes back with nothing new. Costs one wasted request,
        // not another pass over pages already read.
        if(!maxPages&&!stoppedEarly){

            for(let page=lastPage+1;page<=lastPage+TAIL_PROBE;page++){

                const doc=await fetchDoc(paging.pageUrl(page));

                if(!doc){
                    pageErrors++;
                    break;
                }

                const found=collectFrom(doc);

                // an out-of-range page number may serve the last page again -> every company
                // is already known, added is 0, and that is the signal to stop
                if(found.cards===0||found.added===0){

                    console.log(LOG,`tail probe: page ${page} added nothing, real last page is ${page-1}`);

                    break;

                }

                pages.push(page);
                crawledPages.add(page);
                done++;

                report(`Tail page ${page}: ${found.cards} cards, ${found.jobs} jobs,`
                    +` +${found.added} new -> ${unique.length} companies`);

            }

        }

        const missingPages=pages.filter(page=>!crawledPages.has(page));

        console.log(LOG,"companies found:",unique.length,unique);

        if(missingPages.length) console.warn(LOG,"pages never parsed:",missingPages);

        if(unique.length===0){

            alert("No companies found. Scroll the list so the cards are rendered, then run again."
                +(totals.results?`\nPlatform reports ${totals.results} results over ${totals.pages} page(s).`:""));

            return;

        }

        //---------------------------------------------------
        // 3. crawl locations, filter by size
        //---------------------------------------------------

        // Size the tab budget to the work that is actually in front of it, now that the list is
        // known. The default is a flat 80, which on a search this size decided the export: once
        // the breaker above stops sending requests, EVERY company needs a tab, and companies 81
        // onwards were getting neither - no request, no tab, and a blank Location and Employees
        // with nothing in the console to say why. Two per company: the profile, and the /jobs tab
        // for cards that printed no jobs.
        tabs.setBudget(unique.length*2);

        // write by index and filter afterwards: work runs in parallel so completion order is
        // scrambled; this keeps the Excel file in the same company order as the page
        const rows=new Array(unique.length).fill(null);

        let failed=0;
        let skipped=0;
        let processed=0;
        let savedFetches=0;

        // Recruitment time only exists on the list page; company pages and the jobs tab
        // usually omit the posting time -> count the sources to see at once which column will be empty
        const sources={list:0,"jobs-tab":0,"company-page":0,none:0};

        await core.mapPool(unique,concurrency,async(company,index)=>{

            company.failedFetch=false;

            // size already read from the card -> reject early and save a request
            if(ranges.length&&company.size&&!matchesRanges(company.size,ranges)){

                if(!company.counted){
                    company.counted=true;
                    processed++;
                    skipped++;
                }
                console.log(LOG,"skip",company.name,"| size:",company.size);
                report(`[${processed}/${unique.length}] skipped ${company.name}`);
                return;

            }

            let location="";
            let size=company.size;

            // "label" | "near" | "" - see core.headcount. Carried into the summary so a run says
            // how much of the Employees column is a published field and how much is inference.
            let sizeSource=company.sizeSource||"";

            // jobs already read from the list page card -> no /jobs request needed
            let jobs=company.jobs||[];
            let pageJobs=[];
            let remoteFriendly=false;

            // The breaker only stops the cheap path; fetchDoc still reopens the page in a tab, so
            // a run of 403s no longer means the detail data is simply lost. A null here therefore
            // means BOTH ways were refused, which is a real failure worth counting - unlike the
            // old ~855 "failures" that were never sent in the first place.
            const doc=await fetchDoc(company.url);

            if(!doc){

                failed++;

                // marked so the retry pass can come back for it: a company refused at the
                // busiest moment of the run is usually readable once the queue has drained,
                // and a blank size cell is indistinguishable from "publishes no headcount"
                company.failedFetch=true;

            }
            else{

                location=extractField(doc,/^locations?$/i,index===0);

                if(!size){

                    // The <dl> field first, then a bounded scan. What is gone is
                    // norm(doc.body).match(SIZE_DOC): a startup pitch reading "we are a team of
                    // 40 employees" matched it and became the headcount, and once in the file
                    // that number is indistinguishable from one Wellfound actually published -
                    // including to the size filter, which then keeps or drops the company on it.
                    size=extractField(doc,/^(company\s+)?size$/i,false);

                    if(size){
                        sizeSource="label";
                    }
                    else{

                        const found=core.headcount(doc,{label:/^(company\s+)?size$/i,value:SIZE_DOC});

                        size=found.text;
                        sizeSource=found.source;

                    }

                }

                if(!location){
                    console.warn(LOG,"no location parsed for",company.url);
                }

                // tag on the company page, used as a fallback when the job does not say
                remoteFriendly=/remote[\s-]friendly|remote\s+only|fully\s+remote/i.test(norm(doc.body));

                // backup only: a company page can also carry suggested jobs from other companies
                pageJobs=collectJobs(doc,index===0);

            }

            // company page unreachable (403 or otherwise): fall back to the place the list
            // card printed next to the job. It is the job's location rather than the head
            // office, but it beats shipping an empty column.
            if(!location) location=jobsLocation(jobs);

            // size only exists on the detail page -> filter before spending another jobs request
            if(ranges.length&&!matchesRanges(size,ranges)){

                // Unknown size is treated as "does not match", so a company whose card had no
                // size AND whose detail page was blocked gets dropped even though it may well
                // be inside the range. Count it: with 403s in play this is the difference
                // between a short export and a wrong one.
                if(!size) stats.skippedNoSize++;

                if(!company.counted){
                    company.counted=true;
                    processed++;
                    skipped++;
                }
                console.log(LOG,"skip",company.name,"| size:",size||"unknown");
                report(`[${processed}/${unique.length}] skipped ${company.name}`);
                return;

            }

            // the list page is the BEST source: it is the only one carrying the posting time
            let source="list";

            if(jobs.length){
                savedFetches++;
            }
            else{

                const jobsDoc=await fetchDoc(company.url+"/jobs");

                if(jobsDoc) jobs=collectJobs(jobsDoc,index===0);
                else failed++;

                source="jobs-tab";

            }

            if(jobs.length===0){
                jobs=pageJobs;
                source="company-page";
            }

            if(jobs.length===0){
                source="none";
                console.warn(LOG,"no positions parsed for",company.name);
            }

            sources[source]++;

            if(source!=="list"&&sources[source]<=3){
                console.warn(LOG,`positions for ${company.name} came from ${source}, not the list page`
                    +" - Recruitment time is usually missing there.");
            }

            const modes=uniqueList(jobs.flatMap(job=>job.modes));

            if(modes.length===0&&remoteFriendly) modes.push("Remote");

            company.employeesSource=sizeSource;

            rows[index]={
                "Company Name":company.name,
                "Location":location,
                "Positions":jobs.map(job=>job.title).filter(Boolean).join(" | "),
                "Recruitment time":newestPosted(jobs),
                "Employees":size,
                "Remote/Onsite":modes.join(", ")
            };

            if(!company.counted){

                company.counted=true;

                processed++;

            }

            report(`[${processed}/${unique.length}] ${company.name}`);

        },{
            log:LOG,
            // A company whose page was refused during the busiest stretch of the run gets one
            // more go once the queue has drained. The breaker being open means nothing was ever
            // sent, so there is nothing to retry in that case.
            // retried while EITHER path can still get it: the breaker no longer means the end
            shouldRetry:company=>company.failedFetch===true&&(!forbidden.tripped||tabs.available),
            onRetryPass:count=>report(`Retrying ${count} company page(s) that failed...`)
        });

        const results=rows.filter(Boolean);

        // the companies that actually made it into the file, in the same order, so the summary
        // can report where their Employees values came from
        const exported=unique.filter((company,i)=>rows[i]);

        console.log(LOG,`skipped ${savedFetches} /jobs requests (positions already on the list page)`);
        console.log(LOG,"positions source:",sources);

        if(results.length===0){

            const msg=`No company matched the size filter (${buckets.join(", ")}).`
                +`\nCompanies: ${unique.length} unique, ${stats.companyDupes} duplicate card(s) skipped, ${skipped} skipped by size.`
                +`\nJobs: ${stats.jobsSeen} read off the list pages.`;
            console.warn(LOG,msg);
            alert(msg);
            return;

        }

        //---------------------------------------------------
        // 4. export to excel + trigger the download
        //---------------------------------------------------

        finish({
            results,
            exported,
            totals,
            pagesPlanned:pages.length,
            crawled:crawledPages.size,
            lastPage:paging.last,
            pageErrors,
            stoppedEarly,
            missingPages,
            skipped,
            failed,
            crashed:null
        });

    }
    catch(e){

        console.error(LOG,"crawl aborted:",e);

        // Everything collected up to the crash is real data. Throwing away an hour of pagination
        // because the last step failed was the single most expensive thing this crawler did.
        salvage(e);

    }
    finally{

        window.__wfCrawlerRunning=false;

    }

    //---------------------------------------------------
    // helper: write the file
    //---------------------------------------------------

    function finish(state){

        // the crash path calls this too, and an exception raised INSIDE it would come back round
        // and download a second copy of the same file
        if(fileWritten) return;

        fileWritten=true;

        // fixed header: companies without jobs must still keep all 6 columns
        const HEADERS=["Company Name","Location","Positions","Recruitment time","Employees","Remote/Onsite"];

        const written=core.exportXlsx(state.results,{
            headers:HEADERS,
            widths:[28,24,60,16,14,18],
            filename:"wellfound_companies.xlsx",
            log:LOG
        });

        const results=state.results;
        const totals=state.totals||{results:0,pages:0};

        const withLocation=results.filter(r=>r.Location).length;
        const withPositions=results.filter(r=>r.Positions).length;
        const withTime=results.filter(r=>r["Recruitment time"]).length;
        const elapsed=Math.round((performance.now()-startedAt)/1000);

        const missing=state.missingPages||lostPages;

        const summary=[
            `Done in ${elapsed}s. Saved as wellfound_companies.xlsx`,
            ``,
            totals.results
                ? `Platform:  ${totals.results} results (= jobs) over ${totals.pages||state.lastPage} page(s)`
                : `Platform:  result count not found on this page`,
            `Pages:     ${state.crawled}/${state.pagesPlanned} parsed`
                +(state.pageErrors?`, ${state.pageErrors} request error(s)`:"")
                +(recoveredPages?`, ${recoveredPages} recovered on the retry pass`:"")
                +(state.stoppedEarly?`, STOPPED EARLY (2 empty pages in a row)`:""),
            missing.length
                ? `Missing:   ${missing.length} page(s) never parsed -> ${missing.slice(0,15).join(", ")}${missing.length>15?", ...":""}`
                : `Missing:   none, every page parsed`,
            `Cards:     ${stats.cards} company cards`
                +(stats.cardsNoLink?`, ${stats.cardsNoLink} without a company link`:"")
                +`, ${stats.cards3Plus} showing 3+ jobs (per-card cap hides the rest)`,
            `Companies: ${unique.length} unique, ${stats.companyDupes} duplicate card(s) skipped`
                +(resumed?`, ${resumed} resumed from an earlier unfinished run`:""),
            `Exported:  ${results.length} row(s), ${state.skipped} skipped by size, ${state.failed} request error(s)`
                +(stats.skippedNoSize?` - WARNING: ${stats.skippedNoSize} of those had no size at all`:""),
            forbidden.total
                ? `Blocked:   ${forbidden.total} request(s) got 403`
                    +(forbidden.everTripped
                        ? " - plain requests were given up on, pages came from tabs or list data"
                            +(forbidden.tripped?"":" until they started working again")
                        : "")
                : `Blocked:   none`,
            `Filled:    ${withLocation} location, ${withPositions} positions, ${withTime} recruitment time`,
            core.describeSizes(state.exported||[]),
            written.clipped?`Truncated: ${written.clipped} cell(s) hit Excel's 32,767 character limit`:"",
            fetcher.describe()?`Requests:  ${fetcher.describe()}`:"",
            tabs.describe()?`${tabs.describe()}`:"",
            state.crashed?`\nThe run stopped early: ${state.crashed}.`
                +`\nEverything collected before that point is in the file above.`:""
        ].filter(line=>line!=="").join("\n");

        console.log(LOG,"\n"+summary);

        // the popup only has a single status line -> send the short version
        report(`Done: ${results.length} companies`
            +`, ${stats.companyDupes} duplicate companies skipped.`);

        // the run reached the file, so there is nothing left to resume
        if(!state.crashed) checkpoint.clear();

        // let the download start before the alert blocks the page
        setTimeout(()=>alert(summary),0);

    }

    // build the file out of whatever survived the crash
    function salvage(error){

        try{

            if(unique.length===0){
                alert("Crawl failed before anything was collected: "+(error&&error.message||error));
                return;
            }

            // the detail pass may never have run, so build the rows straight off the list cards
            const results=unique.map(company=>({
                "Company Name":company.name,
                "Location":jobsLocation(company.jobs||[]),
                "Positions":(company.jobs||[]).map(job=>job.title).filter(Boolean).join(" | "),
                "Recruitment time":newestPosted(company.jobs||[]),
                "Employees":company.size||"",
                "Remote/Onsite":uniqueList((company.jobs||[]).flatMap(job=>job.modes)).join(", ")
            }));

            finish({
                results,
                exported:unique,
                totals:{results:0,pages:0},
                pagesPlanned:0,
                crawled:0,
                lastPage:0,
                pageErrors:0,
                stoppedEarly:false,
                missingPages:lostPages,
                skipped:0,
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
    // helper: collect companies from one list page (live DOM or an already parsed document)
    //---------------------------------------------------

    function collectFrom(root){

        const cards=root.querySelectorAll(COMPANY_CARD);

        let added=0;

        let jobsOnPage=0;

        stats.cards+=cards.length;

        cards.forEach(card=>{

            const a=card.querySelector('a[href^="/company/"]');

            if(!a){
                stats.cardsNoLink++;
                return;
            }

            // Wellfound's list page also lists the jobs under each company ->
            // reading them here saves one request per company
            const block=widestBlock(card,COMPANY_CARD);

            // dump the very first card of the run: without it a location/posted parsing
            // problem is invisible until it shows up as an empty column in the export
            const jobs=collectJobs(block,!dumpedListCard);

            dumpedListCard=true;

            // Wellfound seems to render at most 3 jobs per card; the rest only exist on the
            // company's /jobs tab. Counting them tells us how much of the gap is that cap.
            if(jobs.length>=3) stats.cards3Plus++;

            jobsOnPage+=jobs.length;

            if(push(norm(card.querySelector("h2"))||norm(a),a.getAttribute("href"),findSizeNear(card),jobs)) added++;

        });

        // fallback in case Wellfound changes its markup
        if(cards.length===0){

            console.warn(LOG,'no [data-testid="startup-header"] cards, falling back to raw /company/ links');

            root.querySelectorAll('a[href^="/company/"]').forEach(a=>{

                if(push(norm(a),a.getAttribute("href"),null,[])) added++;

            });

        }

        return {cards:cards.length,added,jobs:jobsOnPage};

    }

    function push(name,href,size,jobs){

        // Strip query, fragment and any sub-tab. "/company/acme" and "/company/acme/jobs" are
        // the same company, and this doubles as the URL we fetch, so it has to be the profile
        // rather than one of its tabs. The raw-anchor fallback below picks up both forms.
        const path=href.split(/[?#]/)[0]
            .replace(/\/(?:jobs|about|culture|people)\/?$/i,"")
            .replace(/\/+$/,"");

        const url="https://wellfound.com"+path;
        const list=jobs||[];

        // Count jobs BEFORE dropping duplicate companies: Wellfound counts "results" as jobs,
        // so the jobs on a repeated card are part of that number too.
        stats.jobsSeen+=list.length;

        if(visited.has(url)){
            stats.companyDupes++;
            return false;
        }

        visited.add(url);

        unique.push({
            name,
            url,
            size:size&&size.text||"",
            sizeSource:size&&size.source||"",
            jobs:list
        });

        return true;

    }

    //---------------------------------------------------
    // helper: read the number Wellfound prints at the bottom of the list page
    // <h4>Page 1 of 45</h4> <h4>1829 results total</h4>
    // "results" here is the JOB count, not the company count.
    //---------------------------------------------------

    function readTotals(){

        const out={results:0,pages:0};

        // Do NOT scan the text of the whole body: the two <h4> tags sit right next to each
        // other with no whitespace between them -> textContent joins into "...of 451829 results
        // total" and the regex would read 451829. Read leaf nodes one by one instead.
        for(const el of document.querySelectorAll("h1,h2,h3,h4,h5,p,span,div,li")){

            if(el.querySelector("h1,h2,h3,h4,h5,p,span,div,li")) continue;

            const text=blocks(el).join(" ");

            if(!text) continue;

            if(!out.results){

                const m=text.match(/([\d,]+)\s+results?\s+total/i);

                if(m) out.results=+m[1].replace(/,/g,"");

            }

            if(!out.pages){

                const m=text.match(/page\s+[\d,]+\s+of\s+([\d,]+)/i);

                if(m) out.pages=+m[1].replace(/,/g,"");

            }

            if(out.results&&out.pages) break;

        }

        return out;

    }

    //---------------------------------------------------
    // helper: read the pagination
    // <a aria-label="Go to page 200" href="/remote?page=200">200</a>
    // <a aria-current="true" aria-label="Page 1, current page" href="/remote">1</a>
    //---------------------------------------------------

    function readPagination(){

        const here=new URL(location.href);

        let current=+here.searchParams.get("page")||1;
        let last=current;
        let template=null;

        const nav=document.querySelector('nav[aria-label="Pagination Navigation"]');

        if(nav){

            nav.querySelectorAll("a[href][aria-label]").forEach(a=>{

                // "Next page" has no number, so it drops out on its own
                const m=a.getAttribute("aria-label").match(/page\s+(\d+)/i);

                if(!m) return;

                const page=+m[1];

                if(page>last) last=page;

                if(a.getAttribute("aria-current")==="true") current=page;

                // numbered links always carry ?page=N -> use one as the template and keep the URL filters
                if(!template&&/^go to page/i.test(a.getAttribute("aria-label"))){
                    template=new URL(a.getAttribute("href"),location.href);
                }

            });

        }
        else{
            console.warn(LOG,"no pagination nav found, crawling the current page only");
        }

        if(!template) template=here;

        return {
            current,
            last,
            pageUrl(page){

                const url=new URL(template);

                url.searchParams.set("page",page);

                return url.toString();

            }
        };

    }

    //---------------------------------------------------
    // helper: read one field out of a <dl>
    // Wellfound has it backwards: <dd> is the label and <dt> is the value.
    // Walking dt/dd in document order works in both directions.
    //---------------------------------------------------

    function extractField(doc,labelRe,dumpPairs){

        for(const dl of doc.querySelectorAll("dl")){

            const items=[...dl.querySelectorAll("dt, dd")];

            if(dumpPairs){

                console.log(LOG,"dl pairs:",items.map(el=>el.tagName+": "+readValue(el)));

            }

            for(let i=0;i<items.length;i++){

                if(labelRe.test(norm(items[i]))){

                    const value=items[i+1];

                    if(value) return readValue(value);

                }

            }

        }

        return "";

    }

    // the location value is <ul><li><a>...  several entries run together because there is no
    // whitespace between the <li> -> take only the first item and drop the "Show N more" button
    function readValue(el){

        const isNoise=t=>!t||/^show\s+(\d+\s+)?more$/i.test(t)||/^\+\d+$/.test(t);

        const items=el.querySelectorAll('li, a[href*="/location/"]');

        for(const item of items){

            const text=norm(item);

            if(!isNoise(text)) return text;

        }

        return norm(el).replace(/\s*show\s+(\d+\s+)?more$/i,"").trim();

    }

    //---------------------------------------------------
    // helper: collect jobs from a company page or its /jobs tab
    // Wellfound's markup changes constantly, so anchor on the job link and walk up to
    // find the card instead of hardcoding a class/testid.
    //---------------------------------------------------

    function collectJobs(doc,dumpCards){

        // no dedupe at the job level: only companies are deduped (see push()).
        // Every valid job anchor is kept, even when several point at the same position.
        const jobs=[];

        for(const link of doc.querySelectorAll(JOB_LINK)){

            const title=blocks(link).join(" ");

            // image links, the "See all jobs" button, count badges -> drop them
            if(!title||JOB_NOISE.test(title)) continue;

            const card=jobCard(link);

            // drop the title's own words: "Remote Support Engineer" is not a remote job
            const titleParts=new Set(blocks(link));
            const meta=blocks(card).filter(part=>!titleParts.has(part));

            const text=meta.join(" ");

            const loose=text.match(POSTED);

            // href is only used to COUNT duplicate jobs, never to filter them out
            const job={
                title,
                href:(link.getAttribute("href")||"").split(/[?#]/)[0],
                posted:readPosted(card,titleParts)||(loose?cleanPosted(loose[0]):""),
                location:readJobLocation(card,titleParts),
                modes:readModes(text)
            };

            // meta, not text: the raw parts show how the markup was actually split and which
            // separator glyph the card used - that is what location parsing turns on
            if(dumpCards&&jobs.length<3) console.log(LOG,"job card:",job,"| meta:",meta);

            jobs.push(job);

        }

        return jobs;

    }

    // Wellfound's markup has no whitespace between tags, so textContent runs together
    // ("Role A"+"Remote" -> "Role ARemote") and \bremote\b would miss. core.blocks splits per
    // text node so each fragment is its own chunk.

    // walk up to the largest node that still wraps exactly one item (one job, or one company)
    function widestBlock(node,selector,stopAt){

        let cursor=node;
        let block=node;

        for(let up=0;up<6&&cursor.parentElement;up++){

            cursor=cursor.parentElement;

            if(cursor.querySelectorAll(selector).length>1) break;

            // a second boundary: climbing past it would pull in a neighbouring section
            if(stopAt&&cursor.querySelector(stopAt)) break;

            block=cursor;

        }

        return block;

    }

    // Stop at the company header. The job-link count alone does not bound the climb for a
    // company listing a SINGLE job: nothing up the tree ever holds two job links, so the
    // walk ran to its 6-level limit and swallowed the company block. The description then
    // landed in that job's meta, and "A remote-first company with employees across the
    // globe" made readModes tag an onsite job as Remote.
    // On the /jobs tab there is no header, so this changes nothing there.
    function jobCard(link){
        return widestBlock(link,JOB_LINK,COMPANY_CARD);
    }

    // The posting time sits in its own element and is repeated twice (mobile md:hidden +
    // desktop md:flex):
    //   <span class="text-xs lowercase text-dark-a md:hidden">2 weeks ago</span>
    // Scanning by element is safer than a regex over the card's joined text: it does not
    // depend on guessing the card boundary correctly, and it never picks up "4 years of exp"
    // or "Responds within two weeks" from the halo block.
    function readPosted(card,skip){

        let best="";

        for(const el of card.querySelectorAll("span,div,p,li,time")){

            // leaf nodes only, otherwise the parent's own text gets matched again
            if(el.querySelector("span,div,p,li,time")) continue;

            const text=blocks(el).join(" ");

            if(!text||skip.has(text)) continue;

            const m=text.match(POSTED);

            if(!m) continue;

            // a node whose entire content is exactly the posting time -> the safest match
            if(m[0].length===text.length) return cleanPosted(m[0]);

            if(!best) best=cleanPosted(m[0]);

        }

        return best;

    }

    function cleanPosted(text){
        return text.replace(/^posted\s+/i,"").trim();
    }

    // The list card prints the place right next to the job: "Remote • United States",
    // "Onsite or remote • San Francisco", "In office • Atlanta". That is the only location
    // left once the company page answers 403, so read it off the card.
    //
    // Scan by ELEMENT, not over the flattened text parts. React splits text with comment
    // nodes ("0<!-- --> <!-- -->years<!-- --> of exp"), so the location can arrive as three
    // separate parts - "Remote", "•", "United States" - and no single part then holds both
    // the mode and the place. blocks(el).join(" ") puts the element back together first.
    function readJobLocation(card,skip){

        for(const el of card.querySelectorAll("span,div,p,li")){

            const text=blocks(el).join(" ");

            if(!text||skip.has(text)) continue;

            const pieces=text.split(LOC_SEP);

            if(pieces.length<2) continue;

            // The text BEFORE the separator has to be the work mode on its own. Testing the
            // whole string with an unanchored mode is not enough: querySelectorAll walks in
            // document order, so an ancestor wrapping the entire row is inspected before the
            // location span, and for a job titled "Remote Software Engineer" that ancestor
            // also starts with "Remote" and also contains separators (the salary dash).
            // That yielded "$148k Remote, United States 5 days ago" instead of the place.
            if(!WORK_MODE.test(pieces[0].trim())) continue;

            const place=pieces.slice(1).join(", ").replace(LOC_BADGE,"").trim();

            if(place) return place;

        }

        return "";

    }

    // first place any of this company's jobs names, used when the company page is unreachable
    function jobsLocation(jobs){

        for(const job of jobs){

            if(job.location) return job.location;

        }

        return "";

    }

    function readModes(text){

        const modes=[];

        if(/\bremote\b/i.test(text)) modes.push("Remote");
        if(/\bhybrid\b/i.test(text)) modes.push("Hybrid");
        if(/\bon-?\s?site\b|\bin[- ]office\b|\bin[- ]person\b/i.test(text)) modes.push("Onsite");

        return modes;

    }

    function uniqueList(values){
        return [...new Set(values.filter(Boolean))];
    }

    // "3 days ago" is newer than "2 weeks ago" -> convert to minutes and take the smallest
    function newestPosted(jobs){

        let best="";
        let bestAge=Infinity;

        for(const job of jobs){

            if(!job.posted) continue;

            const age=postedAge(job.posted);

            if(age<bestAge){
                bestAge=age;
                best=job.posted;
            }

        }

        return best;

    }

    function postedAge(text){

        const m=text.match(/(\d+)\s*\+?\s*(minute|min|hour|hr|day|week|month|year)s?/i);

        // "Recently posted" is vague (Wellfound uses it for anything within about a week)
        // -> rank it after concrete values like "3 days ago" and before "1 month ago"
        if(!m){

            if(/just now|today/i.test(text)) return 0;
            if(/yesterday/i.test(text)) return 1440;
            if(/recently/i.test(text)) return 10080;

            return Infinity;

        }

        const unit={minute:1,min:1,hour:60,hr:60,day:1440,week:10080,month:43200,year:525600};

        return +m[1]*unit[m[2].toLowerCase()];

    }

    //---------------------------------------------------
    // helper: company size on a list page card
    // <span class="text-xs italic text-neutral-500">501-1000<!-- --> Employees</span>
    //---------------------------------------------------

    // Returns {text,source}. SIZE_EXACT is an element whose ENTIRE text is the value, which is as
    // good as a labelled field; SIZE_LOOSE only found the string somewhere inside the card, so it
    // is recorded as the weaker reading rather than passed off as the same thing.
    function findSizeNear(card){

        let node=card;

        // the size span sits outside startup-header, so walk up the tree and
        // stop once the node wraps several cards, to avoid picking up another company's
        for(let up=0;up<5&&node;up++){

            if(node.querySelectorAll('[data-testid="startup-header"]').length>1) break;

            for(const el of node.querySelectorAll("span,div,p,li")){

                const text=norm(el);

                if(SIZE_EXACT.test(text)) return {text,source:"label"};

            }

            const loose=norm(node).match(SIZE_LOOSE);

            if(loose) return {text:loose[0],source:"near"};

            node=node.parentElement;

        }

        return {text:"",source:""};

    }

    //---------------------------------------------------
    // helper: match sizes by numeric range overlap, not by string comparison.
    // Wellfound may be coarser than the popup buckets ("51-200" vs 51-100 / 101-200),
    // so comparing strings would miss everything.
    //---------------------------------------------------

    function parseRange(text){

        const t=(text||"").replace(/,/g,"");

        let m=t.match(/(\d+)\s*[-–—]\s*(\d+)/);

        if(m) return [+m[1],+m[2]];

        m=t.match(/(\d+)\s*\+/);

        if(m) return [+m[1],Infinity];

        m=t.match(/(\d+)/);

        if(m) return [+m[1],+m[1]];

        return null;

    }

    function matchesRanges(sizeText,ranges){

        if(!ranges.length) return true;

        const size=parseRange(sizeText);

        // size could not be read while a filter is active -> reject
        if(!size) return false;

        return ranges.some(([low,high])=>size[0]<=high&&low<=size[1]);

    }

})();
