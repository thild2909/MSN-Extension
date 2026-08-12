(async()=>{

    const LOG="[reed-crawler]";
    const ORIGIN=location.origin;

    //---------------------------------------------------
    // guard against double runs when the button is clicked repeatedly
    //---------------------------------------------------

    if(window.__reedCrawlerRunning){
        alert("Crawler is already running on this tab. Wait for it to finish.");
        return;
    }

    window.__reedCrawlerRunning=true;

    const core=window.CrawlerCore;

    if(!core){

        alert("core.js is not loaded in this tab. popup.js must inject core.js before content.js.");

        window.__reedCrawlerRunning=false;

        return;

    }

    //---------------------------------------------------
    // selectors
    //
    // Reed is a Next.js app whose class names are hashed per build
    // (index-module_jobCard__DaYuk, search-results_mainBlock__Rp2r_), so nothing here may depend
    // on a class. Every selector below is a data-qa attribute, which is Reed's own test hook and
    // is stable across builds - the one exception is the paginator, which is plain Bootstrap
    // markup and is matched by its href instead (see NEXT_LINKS).
    //---------------------------------------------------

    const CARD='article[data-qa="job-card"]';
    const CARD_WRAP="div[data-card-id]";
    const TITLE='a[data-qa="job-card-title"]';

    // "5 days ago by ITOL Recruit" / "21 July by Allan Webb" - the date AND the recruiter, in one
    // block, with the recruiter's profile link inside it
    const POSTED_BY='[data-qa="job-posted-by"]';

    const META='[data-qa="job-metadata"] li';
    const META_SALARY="job-metadata-salary";
    const META_LOCATION="job-metadata-location";

    // The company is written in up to three places and any one of them can be absent: the logo
    // link, the "Posted by" line under the title, and the plain-text variant of it when the
    // recruiter has no logo. Tried in that order because the first two carry the profile URL,
    // which is what the Employees lookup needs.
    const COMPANY_LINKS=[
        'a[data-qa="company-name-link"]',
        'a[data-qa="company-logo-link"]',
        '[data-qa="job-posted-by"] a[href]'
    ];

    // /jobs/itol-recruit/p57826 -> 57826. The profile id is the grouping key: the same recruiter
    // posts under "Matchtech " and "Matchtech" on different ads and must stay one row.
    const PROFILE_ID=/\/p(\d+)(?:[/?#]|$)/;

    // "1 - 25 of 3,494 jobs"
    const TOTAL_HEADING='[data-qa="pagination_heading"]';

    // <h1 data-qa="searchHeading">3,494 Software Developer Jobs</h1>
    const TOTAL_H1='[data-qa="searchHeading"]';

    // Reed puts 25 ads on a page; only used to stop counting past the end of the list
    const PAGE_SIZE=25;

    const HARD_PAGE_CAP=200;

    // <div data-qa="badges-container"><span data-qa="badge-0-promoted">Promoted</span></div>
    //
    // A promoted slot is an ad the recruiter paid to have shown, and Reed shows THE SAME ONES on
    // every page - they sit outside the 25 organic results and are not in the result count. They
    // are already in the file under their ordinary listing, so all they do is arrive again on
    // every page and look like something going wrong: a 27 page run read 721 cards for 667 ads,
    // and 54 of the 80 duplicates - two per page, every page - were these.
    const PROMOTED='[data-qa*="promoted" i]';

    // how many times the second pass may sweep the list looking for the ads the walk was never
    // served. Declared up here with the other constants on purpose: `const` is in the temporal
    // dead zone until its own line runs, and recoverGap is called from the main flow above.
    const RECOVERY_ROUNDS=2;

    // The paginator is Bootstrap markup with no data-qa on it at all:
    //   <a href="...&pageno=2" class="page-link next" aria-label="Next page">
    // Matching on ?pageno= is what makes this safe rather than the class name, which is one build
    // away from being renamed - and every candidate is checked against the CURRENT page number
    // before it is used (see nextUrl), so a loose selector cannot send the walk backwards.
    const NEXT_LINKS=[
        'a[rel~="next"]',
        'a[aria-label="Next page"]',
        'a[aria-label*="next" i][href*="pageno="]',
        'a[href*="pageno="].next'
    ];

    // Reed's own page parameter. NOT "page": ?page=2 is ignored by the site and serves page 1
    // again, which reads exactly like the end of the list.
    const PAGE_PARAM="pageno";

    // A metadata row that is not the salary and not the location is either the contract type
    // ("Permanent, full-time") or the work-from-home flag ("Work from home"), and only the second
    // one is a work model.
    const WFH=/work from home|remote|hybrid|home.?working/i;
    const HYBRID=/hybrid|part(?:ly|ially)\s*remote/i;

    // Read the Location field the same way: does it mention remote, and once every remote word
    // plus the country/region names are stripped, is any town left over.
    //   "Remote"                    -> Remote  (nothing left)
    //   "London" + "Work from home" -> Hybrid  (a town plus the flag)
    //   "Leeds, West Yorkshire"     -> Onsite
    const REMOTE_HINT=/remote|work from home|home.?working|wfh/i;
    const REMOTE_STRIP=/remote|work from home|home.?working|wfh|100\s*%/gi;
    const PLACE_NOISE=/\b(?:united kingdom|uk|england|scotland|wales|northern ireland|nationwide|anywhere|only|based|work|from|and|or)\b/gi;

    // "5 days ago" / "1 week ago" / "3 hours ago"
    const AGO=/(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago/i;

    const UNIT={
        minute:60000,
        hour:3600000,
        day:86400000,
        week:604800000,
        month:2592000000,
        year:31536000000
    };

    // "21 July" / "3 August 2024"
    const ON_DATE=/^(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?$/;

    // "5 days ago by ITOL Recruit" -> drop everything from " by " on
    const BY=/\s+by\s+[\s\S]*$/i;

    //---------------------------------------------------
    // the headcount
    //
    // Reed publishes no company size on the search card, and most of its ads are posted by
    // recruitment agencies rather than the employer, so there is only one place it can come from:
    // the recruiter's own profile page (/jobs/<slug>/p<id>), where some employers fill in a
    // "Company size" field and most do not.
    //
    // Whether that is worth a request per company is not something to guess at - so it is
    // measured: PROBE profiles are read, and if fewer than WORTH_IT of them produced a number the
    // rest are skipped and the summary says so out loud. A run that quietly skipped 800 lookups
    // reads exactly like one where 800 companies publish no headcount, and those are not the same
    // fact.
    //---------------------------------------------------

    const SIZE_LABEL=/^(?:company size|size|employees|no\.? of employees|number of employees|headcount|team size)$/i;

    const SIZE_VALUE=/(?:\d[\d,.]*\s*(?:\+|-|–|to)\s*\d[\d,.]*|\d[\d,.]*\s*\+?)\s*(?:employees|staff|people)\b/i;

    // cheap substring test on the raw body: a profile that never says "employee" anywhere cannot
    // hold a headcount, and ruling it out costs microseconds instead of a full DOMParser run
    const SIZE_HINT=/employee|company size|headcount/i;

    const PROBE=24;
    const WORTH_IT=0.1;

    // The pace floor is zero: nothing is paid until Reed actually pushes back, and the gate
    // widens the gap the moment anything is refused.
    const gate=core.makeGate({minGap:0,limit:4,log:LOG});

    const fetcher=core.makeFetcher(gate,{
        log:LOG,
        // Two refusals in a row are answered by a real navigation rather than by the rest of the
        // ladder - but only while there is a tab left to open.
        canEscalate:()=>tabs.available
    });

    const jobs=[];

    // job id -> the results page it was found on. A plain Set would dedupe, but not tell the two
    // reasons a page can bring nothing new apart: a page re-read on purpose (the rewind, a resumed
    // run) versus Reed answering a page number past the end by re-serving an earlier page. The
    // first must not stop the walk; the second must.
    const visited=new Map();

    const startedAt=performance.now();

    const report=core.makeReporter("reed-crawler-status",LOG);

    // A 403 from Reed's edge is as often "that did not look like a browser" as "too fast", and
    // backing off answers only one of the two - plain curl against a search URL is refused
    // outright while the same URL opens fine in a tab. Reopening it as a real navigation carries
    // the cookies, the TLS fingerprint and the JavaScript the check is looking for.
    const tabs=core.makeTabFallback({
        log:LOG,
        report,
        lastStatus:fetcher.lastStatus,
        describe:describeUrl,
        // Name the part of the page that is actually read. A Reed results page is mostly the
        // app's own JSON payload and its adverts; the cards, the paginator and the counts are a
        // fraction of it, and that fraction is what crosses tab -> worker -> content script and
        // then goes through DOMParser. A profile page matches none of these, so it comes back
        // whole - which is exactly what the headcount lookup needs.
        extract:[CARD_WRAP,"nav[aria-label=\"pagination\"]",TOTAL_HEADING,TOTAL_H1]
    });

    // Enough of a URL to recognise it in a status line: a results page by its number, a profile
    // page by its id, anything else by its path.
    function describeUrl(url){

        const page=core.paramOf(url,PAGE_PARAM,ORIGIN);

        if(page) return "page "+page;

        const profile=PROFILE_ID.exec(url);

        if(profile) return "profile "+profile[1];

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

    // A tab navigation kills the content script outright - no catch block runs and nothing is
    // written. The checkpoint turns that from "the whole run is gone" into "the next run starts
    // where this one stopped".
    const checkpoint=core.makeCheckpoint("reedCheckpoint",{log:LOG});

    // set the moment the file is handed to the browser, so the crash path can never write a second one
    let fileWritten=false;

    let resumed=0;
    let rewound=0;

    // Where the difference between Reed's own job count and the file actually goes. A bare
    // "22 NOT READ" is not a finding, it is a question - these four are the answer to it.
    // seenCards = every card scanned; of those, sameAdTwice were an ad already read on another
    // page (Reed's list shifts as new ads are posted, so ads slide from one page onto the next),
    // reReads were a page deliberately read twice (the rewind, a resumed run), and noOwnId had no
    // id attribute of their own.
    let seenCards=0;
    let sameAdTwice=0;
    let reReads=0;
    let noOwnId=0;

    // promoted slots arriving again on a later page, and duplicates seen during the second pass.
    // Both are expected and neither costs anything, so they are kept out of sameAdTwice - that
    // number is the one worth acting on and it must not be buried under the other two.
    let promotedRepeats=0;
    let recoveryRepeats=0;

    // pages the crawler counted its way to because no "Next" link was found on the page before.
    // Counted separately from the `counted` Set, which also holds the URLs guessed past a page
    // that never arrived - reporting the Set made a run that stepped over two dead pages claim
    // Reed's paginator had gone missing on two more pages than it had.
    let countedForward=0;

    // profile lookups abandoned once the sample said they were not paying for themselves
    let droppedLookups=0;
    let probed=0;
    let probeHits=0;

    // companies whose profile phase is done, counted here rather than inside the pool worker: the
    // retry pass runs the same company a second time and counting it twice made the progress line
    // climb past the total it was counting towards
    let processed=0;

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

        let maxPages=0;
        let concurrency=4;
        let wantProfiles=true;

        try{

            const settings=await chrome.storage.local.get(["maxPages","concurrency","profiles"]);

            maxPages=Math.max(0,+settings.maxPages||0);

            if(settings.concurrency) concurrency=Math.min(12,Math.max(1,+settings.concurrency));

            if(settings.profiles===false) wantProfiles=false;

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

        // Ask now, while nothing is on fire: a worker that turns out to be unreachable at page 40
        // has already cost the run everything it took to get there.
        if(await tabs.ready()) console.log(LOG,"tab fallback is ready");

        const paging=await crawlAllPages(maxPages,total);

        console.log(LOG,`${paging.pages} page(s) read -> ${jobs.length} jobs`
            +(paging.stoppedEarly?" (stopped early)":""));

        if(jobs.length===0){

            alert("No job cards found. Open a www.reed.co.uk/jobs search results page and run again.");
            return;

        }

        // The walk read every page in order and still came up short, because the list moved while
        // it was reading. Asking again is the only thing that gets those ads.
        const recovery=await recoverGap(total,paging,concurrency);

        if(recovery.found){
            console.log(LOG,`second pass recovered ${recovery.found} ad(s) over ${recovery.pages} page(s)`);
        }

        //---------------------------------------------------
        // 3. group by company
        //---------------------------------------------------

        const companies=buildCompanies(jobs);

        console.log(LOG,`${jobs.length} jobs -> ${companies.length} companies`);

        //---------------------------------------------------
        // 4. Employees is on none of the cards -> read the recruiter's profile page.
        //    One page per company, not per ad: the column is per company anyway, and opening
        //    every listing would multiply the request count by the ads-per-company ratio to
        //    learn nothing new.
        //---------------------------------------------------

        const targets=!wantProfiles?[]:companies.filter(company=>company.profileUrl);

        let failed=0;

        if(targets.length){

            report(`Reading ${targets.length} company profile(s) for Employees...`);

            await core.mapPool(targets,concurrency,async company=>{

                // Rather than assume Reed profiles carry a size, ask a sample and let the answer
                // decide whether the rest are worth the requests.
                if(probed>=PROBE&&probeHits<probed*WORTH_IT){

                    droppedLookups++;

                    tick(company,targets.length);

                    return;

                }

                const got=await readSize(company);

                // a page that never arrived says nothing about the yield either way; it comes back
                // round on the retry pass below, where it is counted once and only once
                if(got!==null){

                    probed++;

                    if(got) probeHits++;

                }

                tick(company,targets.length);

            },{
                log:LOG,
                // A profile refused at the busiest moment of the run gets one more go once the
                // queue has drained: a blank Employees cell is indistinguishable from "this
                // company publishes no headcount".
                shouldRetry:company=>company.failed===true,
                onRetryPass:count=>report(`Retrying ${count} profile page(s) that failed...`)
            });

            if(droppedLookups){

                report(`Skipped ${droppedLookups} profile lookup(s): the first ${probed} produced `
                    +`${probeHits} employee count(s).`);

            }

            failed=companies.filter(company=>company.failed).length;

        }

        const withSize=companies.filter(company=>company.employees).length;

        //---------------------------------------------------
        // 5. export to excel + trigger the download
        //---------------------------------------------------

        finish({companies,total,paging,recovery,targets:targets.length,wantProfiles,withSize,failed,crashed:null});

    }
    catch(e){

        console.error(LOG,"crawl aborted:",e);

        // Everything collected up to the crash is real data. Throwing it away because the last
        // step failed is the single most expensive thing a crawler can do.
        salvage(e);

    }
    finally{

        window.__reedCrawlerRunning=false;

    }

    //---------------------------------------------------
    // helper: the progress line of the profile phase
    //---------------------------------------------------

    function tick(company,total){

        // guarded: the retry pass runs the same company again, and counting it twice made the
        // progress line climb past the total it was counting towards
        if(!company.counted){
            company.counted=true;
            processed++;
        }

        report(`[${processed}/${total}] ${company.name}`);

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

        const written=core.exportXlsx(results,{
            headers:HEADERS,
            widths:[34,30,60,18,20,16],
            filename:"reed_companies.xlsx",
            log:LOG
        });

        const withTime=results.filter(r=>r["Recruitment time"]).length;
        const elapsed=Math.round((performance.now()-startedAt)/1000);

        const paging=state.paging||{pages:0,failed:0,recovered:0,counted:0,reason:"end"};

        // Reed's own count against what is in the file, and what stands between them. Every ad
        // Reed counts is either in the file, or it is one of these - and a run that cannot say
        // which is a run nobody can act on. The last line is the honest remainder: a search whose
        // ads are being posted while it is read has more of them at the end than at the start,
        // and no amount of paging catches up with that.
        const missing=state.total?Math.max(0,state.total-jobs.length):0;

        const unread=paging.failed*PAGE_SIZE;

        const unaccounted=Math.max(0,missing-sameAdTwice-unread);

        const rescue=state.recovery||{pages:0,found:0,rounds:0};

        const ledger=!missing&&seenCards<=jobs.length?"":[
            // the crash path has no total to reconcile against - it still has cards to account for
            state.total
                ? `Reed counts ${state.total} ad(s) and the file holds ${jobs.length}. Of the `
                    +`${seenCards} card(s) read over ${paging.pages} page(s)`
                    +(rescue.pages?` plus ${rescue.pages} re-read on the second pass`:"")+":"
                : `${jobs.length} ad(s) in the file, from ${seenCards} card(s) read over `
                    +`${paging.pages} page(s):`,
            // First, and named for what it is, because it is nearly always the biggest number here
            // and it is the one that means nothing at all.
            promotedRepeats?`  - ${promotedRepeats} card(s) were Promoted slots. Reed shows the `
                +"same paid ads on every page and does not count them in the total, so they arrive "
                +"again with each page. Every one of them is already in the file under its "
                +"ordinary listing - nothing is missing because of these.":"",
            sameAdTwice?`  - ${sameAdTwice} card(s) repeated an ad already read on an earlier page. `
                +"This is the one that costs coverage: Reed's list does not hold still between "
                +"requests, so when it moves the top of a page repeats the bottom of the last one "
                +"and whatever was pushed off the top is served to nobody."
                +(rescue.found?` The second pass went back for those and found ${rescue.found}.`
                    :rescue.pages?" The second pass went back for those and found none.":""):"",
            reReads?`  - ${reReads} card(s) came off a page that was deliberately read twice (the `
                +"rewind to page 1, or a resumed run). Nothing is lost to those.":"",
            recoveryRepeats?`  - ${recoveryRepeats} card(s) were seen again on the second pass, `
                +"which is what a second pass mostly reads. Nothing is lost to those either.":"",
            noOwnId?`  - ${noOwnId} card(s) carried no job id of their own and were identified by `
                +"what the card says. Those ARE in the file - but if that number is large, Reed "
                +"has renamed the id attribute and the grouping is weaker than it looks.":"",
            unread?`  - up to ${unread} more sat on the ${paging.failed} page(s) that never `
                +"arrived. Those really are missing.":"",
            unaccounted?`  - ${unaccounted} are still missing after all of that. Reed's count is `
                +"live: ads posted while the run was going are counted in the total and sit at the "
                +"top of page 1, so a search this size never quite closes.":""
        ].filter(Boolean).join("\n");

        // "Done" on its own reads as "that was all of it", which is exactly wrong when the walk
        // was cut short - the file then looks complete while half the list is missing.
        const problems=[
            rewound?`Rewound to page 1: the tab was on page ${rewound+1}, so pages 1-${rewound} `
                +"would otherwise have been skipped entirely.":"",
            paging.recovered?`${paging.recovered} page(s) were recovered on the second pass.`:"",
            paging.counted?"Reed's \"Next\" link could not be found on "+paging.counted+" page(s), so "
                +"the crawler counted ?pageno= forward instead. That is the intended fallback and "
                +"nothing is missing because of it - but if the count above is short, this is the "
                +"first thing to check.":"",
            paging.failed?`${paging.failed} page(s) could not be read at all - those jobs are missing.`:"",
            paging.reason==="blocked"
                ? "Reed stopped serving results part way through - that is a refusal, not the end "
                    +"of the list. Wait a few minutes and run again, or lower 'parallel'."
                :"",
            paging.reason==="limit"?"Stopped at the max pages limit - there are more results.":"",
            droppedLookups?`${droppedLookups} profile lookup(s) skipped - the first ${probed} produced `
                +`${probeHits} employee count(s), so the rest were not worth the requests`:"",
            !state.wantProfiles?"Employees is blank because \"Company profiles\" is unticked in the popup.":"",
            state.wantProfiles&&state.targets===0&&state.companies.length
                ? "No company on this search links to a Reed profile page, so Employees has no "
                    +"source at all and stays blank."
                :"",
            written.clipped?`${written.clipped} cell(s) truncated to fit Excel's 32,767 character limit.`:""
        ].filter(Boolean);

        const summary=`Done in ${elapsed}s: ${results.length} companies from ${jobs.length} jobs`
            +(state.total?` of the ${state.total} Reed reports`
                +(jobs.length<state.total?` - ${state.total-jobs.length} NOT READ`:" - complete"):"")
            +` over ${paging.pages} page(s), ${withTime} with recruitment time`
            +(state.wantProfiles?`, ${state.targets} profile page(s) read, ${state.withSize} with employee count`
                :", company profiles off")
            +`, ${state.failed} request errors.`
            +(resumed?`\nResumed ${resumed} job(s) from an earlier unfinished run.`:"")
            +(core.describeSizes(state.companies)?`\n${core.describeSizes(state.companies)}`:"")
            +(ledger?"\n\n"+ledger:"")
            +(problems.length?"\n\n"+problems.join("\n"):"")
            +(fetcher.describe()?`\nRequests: ${fetcher.describe()}`:"")
            +(tabs.describe()?`\n${tabs.describe()}`:"")
            +(state.crashed?`\n\nThe run stopped early: ${state.crashed}.`
                +"\nEverything collected before that point is in the file above.":"");

        report(summary);

        // the run reached the file, so there is nothing left to resume
        if(!state.crashed) checkpoint.clear();

        // let the download start before the alert blocks the page
        setTimeout(()=>alert(summary+"\nSaved as reed_companies.xlsx"),0);

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
                wantProfiles:false,
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
    //
    // Reed renders its results server side, so a page can be fetched rather than clicked - and it
    // has to be: "Next" is a real <a> whose click reloads the page and kills the content script.
    //
    // Stops when: a page comes back with no cards, a page reached by counting repeats ads already
    // read, pagination points back at a page already read, or the max pages limit is reached.
    // Note what is NOT on that list - "the Next link could not be found". That is a fact about one
    // CSS selector, not about the list, and treating it as the end of the results is what
    // truncates a 3,494 job search to the 25 ads on screen.
    //---------------------------------------------------

    async function crawlAllPages(maxPages,total){

        const limit=maxPages?Math.min(maxPages,HARD_PAGE_CAP):HARD_PAGE_CAP;

        const here=core.paramOf(location.href,PAGE_PARAM,ORIGIN)||1;

        // the open page is already rendered and costs no request, so read it whatever happens
        const first=collectFrom(document,here);

        report(`Open page: +${first.added} job(s), ${jobs.length} total`);

        // the last page that can hold anything, so counting forward stops at the end of the list
        // instead of walking to the cap. 0 when the total could not be read.
        const lastPage=total?Math.ceil(total/PAGE_SIZE):0;

        // URLs the crawler counted its way to rather than read off a link. Kept apart because a
        // counted page that brings nothing new is Reed re-serving an earlier page, which is how it
        // answers a page number past the end - and that has to end the walk.
        const counted=new Set();

        let lastPageHadCards=first.cards>0;

        // The same search one page further on. Deliberately NOT core.bumpParam: that reads a
        // missing ?pageno= as 0, so it would step from page 1 (which carries no pageno at all) to
        // "pageno=1" - the same page again, which the loop guard then reads as pagination going in
        // a circle.
        function stepPage(url){

            try{

                const next=new URL(url,ORIGIN);

                next.searchParams.set(PAGE_PARAM,String((core.paramOf(url,PAGE_PARAM,ORIGIN)||1)+1));

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
        // silently drops every earlier page - a tab left on page 5 loses 100 jobs. Rewind to page
        // 1 instead; the ads already in `visited` are deduped on arrival, so the only cost is the
        // requests, not the data.
        //
        // The ceiling is asked here too, and for the same reason it is asked in nextOf: a search
        // that fits on ONE page still renders a "Next" link, and following it off the only page
        // there is turns a complete run into one that reports a 404 it had no business asking for.
        const start=here>1?pageUrl(1)
            :moreAfter(here)?(nextUrl(document,location.href)||stepPage(location.href)):"";

        rewound=here>1?here-1:0;

        if(rewound) report(`Tab was on page ${here} - rewinding to page 1 so pages 1-${rewound} are not lost...`);

        const walk=await core.walkPages({

            first:start,

            fetchDoc:(url,opts)=>fetchDoc(url,opts),

            onDoc:async (doc,url)=>{

                const page=core.paramOf(url,PAGE_PARAM,ORIGIN)||1;

                const found=collectFrom(doc,page);

                lastPageHadCards=found.cards>0;

                report(`Page ${page}: +${found.added} job(s), ${jobs.length} total`);

                await checkpoint.save({jobs});

                if(found.cards===0){
                    console.warn(LOG,"a page had no job cards - end of the list or a bot check");
                    return "stop";
                }

                // A counted page that brought nothing new AND is made of ads belonging to other
                // pages is Reed answering a page number past the end by re-serving an earlier
                // page. "Nothing new" on its own is not enough: the rewind re-reads the tab's own
                // page on purpose, and so does a resumed run - both add nothing and both must
                // carry on.
                if(found.added===0&&found.elsewhere>0&&counted.has(url)){
                    console.warn(LOG,`page ${page} was reached by counting and came back holding`
                        +" ads from a page already read - that is the end of the list");
                    return "stop";
                }

                return "";

            },

            // The Next link is the better source - it is what the site itself says comes next. But
            // it is a handful of selectors against markup nobody promised to keep, and when they
            // miss, "there is no next page" and "we could not find the next page" are the same
            // answer. Counting forward is the floor under that: Reed's pagination is a plain
            // ?pageno= counter and the first page with no cards ends the walk.
            nextOf:(doc,url)=>{

                const page=core.paramOf(url,PAGE_PARAM,ORIGIN)||1;

                // The result count is asked FIRST, before the paginator is even looked at, and
                // that order is the whole point. Reed renders "Next" on the last page too - a
                // real <a href="...&pageno=28"> on the last page of 27 - and following it asks
                // for a page that does not exist. Reed answers 404, the walk counts forward to
                // 29 and 30 for two more, calls three failures in a row a refusal and stops. The
                // run then reports two pages lost and results refused, having in fact read every
                // page there was. Where the list ends is a fact about the count, not about what
                // the paginator chose to draw.
                if(!moreAfter(page)) return "";

                const found=nextUrl(doc,url);

                if(found) return found;

                console.warn(LOG,`no "Next" link on page ${page} - counting forward instead`);

                countedForward++;

                return stepPage(url);

            },

            // The next URL normally comes out of the page we just failed to read, so without this
            // one bad moment at page 27 of 140 throws away four fifths of the list.
            guessNext:url=>{

                const page=core.paramOf(url,PAGE_PARAM,ORIGIN)||1;

                // ...but a page at or past the end of the list did not fail, it does not exist,
                // and stepping further forward only collects more 404s to mistake for a block.
                if(lastPage&&page>=lastPage) return "end";

                return stepPage(url);

            },

            maxPages:limit,
            report,
            log:LOG

        });

        await checkpoint.save({jobs},true);

        return {
            // walkPages starts its counter at 1 for the page already on screen, so it is already
            // the total number of pages read
            pages:walk.pages,
            failed:walk.skipped,
            recovered:walk.recovered,
            counted:countedForward,
            reason:walk.reason,
            stoppedEarly:walk.reason!=="end"
        };

    }

    //---------------------------------------------------
    // helper: go back for the ads the walk was never served
    //
    // A Reed search is one list read 25 rows at a time over half a minute, and the list does not
    // hold still while that happens. When it moves down between two requests, the top of the next
    // page repeats the bottom of the last one - and the ads that were pushed off the top of a page
    // already read are never served to anybody. That is not a bug in the walk and no amount of
    // care during it helps: the pages were all read, in order, exactly once.
    //
    // 26 of 667 went that way on a 13 second run. The only thing that gets them is asking again,
    // because the second read lands the page boundaries somewhere else - so this re-reads the
    // pages once the walk is done and keeps whatever is new. Unlike the walk, every URL is known
    // up front, so it runs at the crawl's full width instead of one page at a time.
    //
    // Strictly bounded: it only runs when the walk finished on its own AND Reed's own count says
    // ads are missing, it stops the moment the count is met, and it gives up after a round that
    // finds nothing rather than chasing a total that is itself still moving.
    //---------------------------------------------------

    async function recoverGap(total,paging,concurrency){

        const done={pages:0,found:0,rounds:0};

        // no total to chase, nothing missing, or the walk was cut short - in the last case the
        // gap is the pages that never arrived, and re-reading the ones that did will not fill it
        if(!total||jobs.length>=total||paging.reason!=="end") return done;

        const lastPage=Math.min(Math.ceil(total/PAGE_SIZE),HARD_PAGE_CAP);

        if(!lastPage) return done;

        const pages=[];

        for(let page=1;page<=lastPage;page++) pages.push(page);

        for(let round=1;round<=RECOVERY_ROUNDS;round++){

            const before=jobs.length;

            report(`${total-jobs.length} ad(s) Reed counts were never served to the walk - `
                +`re-reading ${lastPage} page(s) to pick them up...`);

            await core.mapPool(pages,concurrency,async page=>{

                // the count can be met half way through the sweep, and the rest of it is then
                // pages nobody needs
                if(jobs.length>=total) return;

                const doc=await fetchDoc(pageUrl(page));

                done.pages++;

                if(!doc) return;

                const got=collectFrom(doc,page,true);

                if(got.added) report(`Second pass, page ${page}: +${got.added} ad(s) the walk `
                    +`never saw, ${jobs.length} total`);

            },{log:LOG});

            done.rounds=round;
            done.found+=jobs.length-before;

            await checkpoint.save({jobs},true);

            // met the count, or a whole sweep turned up nothing new: either way there is no
            // reason to pay for another one
            if(jobs.length>=total||jobs.length===before) break;

        }

        return done;

    }

    // the same search, on a given page number
    function pageUrl(page){

        const url=new URL(location.href);

        url.searchParams.set(PAGE_PARAM,String(page));

        return cleanUrl(url.toString());

    }

    //---------------------------------------------------
    // helper: collect the jobs of one page
    //---------------------------------------------------

    // `page` and `rank` are the ad's position in Reed's results, and they are the only record of
    // it: the crawler does NOT read the pages in site order (it reads the open page first, then
    // rewinds to page 1), so the order of `jobs` is the order it fetched them. buildCompanies
    // sorts on these to put the sheet back into the order the site shows.
    function collectFrom(doc,page,recovery){

        const cards=doc.querySelectorAll(CARD);

        let added=0;
        let dropped=0;
        let elsewhere=0;
        let again=0;
        let rank=0;

        cards.forEach(card=>{

            const job=readCard(card,page,rank++);

            if(!job.hasOwnId) dropped++;

            if(visited.has(job.id)){

                // Which KIND of duplicate this is, because they mean four different things and
                // lumping them together is what made a working run look broken. A promoted slot
                // repeated on every page says nothing at all; an ordinary ad arriving from a
                // different page says the list moved under the walk, and THAT is the one that
                // costs coverage.
                const from=visited.get(job.id);

                if(job.promoted) promotedRepeats++;
                else if(recovery) recoveryRepeats++;
                // This ad was read as part of a DIFFERENT page, so this page is a copy of one
                // already seen rather than a page being re-read on purpose. An unknown page (an
                // old checkpoint) counts as the same page: erring towards carrying on costs one
                // wasted request, erring the other way costs the rest of the list.
                else if(from&&from!==page) elsewhere++;
                else again++;

                return;

            }

            visited.set(job.id,page);

            jobs.push(job);

            added++;

        });

        // Every card that came off a page, counted where the counting can be reconciled against
        // Reed's own total afterwards. Without this the run could say 22 ads were missing but not
        // one word about WHERE they went, and "Reed served the same ad on two pages" and "22 ads
        // were never fetched at all" are not remotely the same fact.
        seenCards+=cards.length;
        sameAdTwice+=elsewhere;
        reReads+=again;
        noOwnId+=dropped;

        // a card with no identity used to be skipped outright, so the ad was lost over a missing
        // attribute. It is kept now and keyed by its place in the list - but a build that renamed
        // the attribute is still worth a line, because that key is weaker than a real one.
        if(dropped){
            console.warn(LOG,`${dropped} of ${cards.length} card(s) on page ${page} had neither an`
                +" id nor a link - they were kept and identified by their place in the list");
        }

        return {cards:cards.length,added,dropped,elsewhere};

    }

    // getAttribute("href") is null on an element that is not a link, and new URL(null,ORIGIN)
    // resolves to ".../null" - a profile URL that looks real and 404s on every fetch.
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

    // The company, and the profile page that may carry its size. Reed writes the recruiter in up
    // to three places and any one of them can be absent - a card with no logo has only the
    // "Posted by" line, and one with neither has nothing at all.
    function readCompany(card){

        for(const selector of COMPANY_LINKS){

            const link=card.querySelector(selector);

            if(!link) continue;

            const name=norm(link)||link.getAttribute("data-company")||"";
            const url=linkHref(link);

            // a link that is not a profile link (the "hide all Training Course jobs" one) has no
            // /p<id> in it and is no use as either a name or a URL
            if(!PROFILE_ID.test(url)) continue;

            if(name) return {name,url};

        }

        // No profile link at all. The "Posted by" line still names the recruiter in plain text -
        // but only if it HAS a " by ", and a card that says just "Yesterday" does not: writing the
        // date into the Company Name column is worse than leaving the row unnamed, because
        // grouping then splits one recruiter across every date it posted on.
        const line=pick(card,POSTED_BY);

        const by=/\s+by\s+([\s\S]+)$/i.exec(line);

        return {name:by?by[1].trim():"",url:""};

    }

    function readCard(card,page,rank){

        const title=card.querySelector(TITLE);
        const company=readCompany(card);
        const meta=readMeta(card);
        const posted=readPosted(card);

        const jobUrl=linkHref(title);

        const name=(title&&title.getAttribute("title"))||norm(title)
            ||norm(card.querySelector('[data-qa="job-title-btn-wrapper"]'));

        // data-id="job57204881" on the article. Reed renames class names per build but not this;
        // still, the ad's own URL is unique per ad too and that is all `visited` needs.
        //
        // What used to happen when BOTH were missing is that the caller threw the whole card away
        // in silence - an ad was lost over its id attribute, and the summary said only that N jobs
        // were "NOT READ".
        //
        // The last resort is made of what the card SAYS, never of where it sits. Pages here are
        // re-read on purpose - the rewind to page 1, a resumed run, and every page again on the
        // second pass - so a key built from the page or the row number would hand one ad a fresh
        // identity on each reading and write it into the file twice.
        const own=(card.getAttribute("data-id")||"").replace(/^job/,"")||jobUrl;

        return {
            id:own||"card:"+[name,company.name,meta.location,meta.salary,posted.text].join("|"),
            hasOwnId:!!own,
            promoted:!!card.querySelector(PROMOTED),
            page,
            rank,
            title:name,
            company:company.name,
            profileUrl:company.url,
            profileId:profileId(company.url),
            location:meta.location,
            salary:meta.salary,
            jobType:meta.jobType,
            workFromHome:meta.workFromHome,
            postedText:posted.text,
            postedAt:posted.at,
            jobUrl
        };

    }

    // /jobs/itol-recruit/p57826 -> "57826". The most reliable grouping key there is: the same
    // agency written as "Matchtech " on one ad and "Matchtech" on the next still lands on one row.
    function profileId(url){

        const match=PROFILE_ID.exec(url||"");

        return match?match[1]:"";

    }

    //---------------------------------------------------
    // helper: the metadata row
    // <ul data-qa="job-metadata">
    //   <li data-qa="job-metadata-salary">£35,000 - £45,000 per annum</li>
    //   <li data-qa="job-metadata-location">London</li>
    //   <li>Permanent, full-time</li>          <- contract type, no data-qa
    //   <li>Work from home</li>                <- the work-from-home flag, no data-qa either
    // The last two are told apart by what they say, because Reed gives neither a hook.
    //---------------------------------------------------

    function readMeta(card){

        const out={salary:"",location:"",jobType:"",workFromHome:""};

        card.querySelectorAll(META).forEach(item=>{

            const qa=item.getAttribute("data-qa")||"";
            const text=norm(item);

            if(qa===META_SALARY){
                out.salary=text;
            }
            else if(qa===META_LOCATION){
                out.location=text;
            }
            else if(WFH.test(text)){
                out.workFromHome=text;
            }
            else if(text&&!out.jobType){
                out.jobType=text;
            }

        });

        return out;

    }

    //---------------------------------------------------
    // helper: the posting date
    // <div data-qa="job-posted-by">5 days ago by <a>ITOL Recruit</a></div>
    // -> the text is what goes in the file, and an epoch is derived from it so the newest ad of a
    //    company can be picked without comparing "21 July" to "5 days ago" as strings
    //---------------------------------------------------

    function readPosted(card){

        // norm() over the whole block gives "5 days ago by ITOL Recruit"; the recruiter is
        // already read separately, so everything from " by " on is dropped
        const text=pick(card,POSTED_BY).replace(BY,"").trim();

        return {text,at:postedAt(text)};

    }

    // "Yesterday" / "5 days ago" / "21 July" -> epoch ms, 0 when it cannot be read.
    // Approximate on purpose: this is only ever used to order one company's ads against each
    // other, and the string itself is what lands in the file.
    function postedAt(text){

        const value=(text||"").trim();

        if(!value) return 0;

        const now=Date.now();

        if(/^(?:just now|today|new)$/i.test(value)) return now;

        if(/^yesterday$/i.test(value)) return now-UNIT.day;

        const ago=AGO.exec(value);

        if(ago) return now-(+ago[1])*UNIT[ago[2].toLowerCase()];

        const on=ON_DATE.exec(value);

        if(on){

            const year=on[3]?+on[3]:new Date(now).getFullYear();

            const stamp=Date.parse(`${on[1]} ${on[2]} ${year} 12:00:00`);

            if(!isNaN(stamp)){

                // no year in the text and the date lands in the future -> Reed means last year
                return (!on[3]&&stamp>now+UNIT.day)?stamp-UNIT.year:stamp;

            }

        }

        return 0;

    }

    //---------------------------------------------------
    // helper: group jobs by company
    //---------------------------------------------------

    function buildCompanies(list){

        const map=new Map();

        // Site order, not the order the crawler happened to fetch in. Those are not the same: when
        // the tab sits on page 5 the open page is read FIRST and the walk then rewinds to page 1,
        // so page 5's companies came out at the top of the sheet. (page,rank) is where the ad
        // actually sits in the results, so sorting on it puts both the rows and the cells back
        // into the order Reed shows.
        const ordered=[...list].sort((a,b)=>(a.page||0)-(b.page||0)||(a.rank||0)-(b.rank||0));

        // Group by profile id; without one, fall back to the folded name rather than the raw one,
        // so "Best4Business Group" and "Best4Business Group Ltd" do not become two rows each
        // holding a slice of the positions.
        //
        // core.companyKeys is what makes the two agree. The profile id comes off a link, and Reed
        // writes the recruiter in up to three places with any one of them absent - a card with no
        // logo and no company-name link has only the plain-text "Posted by" line and no /p<id> at
        // all. So the same agency arrived as "id:57826" on one ad and "name:matchtech" on the next:
        // two rows, which is the duplicate the folded name exists to prevent.
        const keyOf=core.companyKeys(ordered,job=>job.profileId,job=>job.company||"(unknown)");

        for(const job of ordered){

            const name=job.company||"(unknown)";

            const key=keyOf(job);

            job.key=key;

            let company=map.get(key);

            if(!company){

                company={
                    key,
                    name,
                    profileId:job.profileId,
                    profileUrl:job.profileUrl,
                    // rank of this company's FIRST ad in the results - the sheet's row order
                    seq:map.size,
                    jobs:0,
                    locations:[],
                    positions:[],
                    modes:[],
                    posted:"",
                    postedAt:0,
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

            // the newest ad, and its URL
            if(job.postedAt>company.postedAt){
                company.postedAt=job.postedAt;
                company.posted=job.postedText;
                if(job.jobUrl) company.jobUrl=job.jobUrl;
            }

            // an ad with no date at all still has to leave SOMETHING in the column when it is the
            // only one this company posted
            if(!company.posted&&job.postedText) company.posted=job.postedText;

            // the row may have been opened by an ad that carried no profile link, so take the id
            // from whichever of this recruiter's ads did have one
            if(!company.profileId&&job.profileId) company.profileId=job.profileId;

            if(!company.profileUrl&&job.profileUrl) company.profileUrl=job.profileUrl;

        }

        // First appearance in the search results, so row 1 of the sheet is the first hit on page 1
        // and the file can be read straight against the site. Ranking by ad count instead puts a
        // company from page 40 above the first hit on page 1, which makes the file impossible to
        // check and hides the fact that whole pages are missing.
        return [...map.values()].sort((a,b)=>a.seq-b.seq);

    }

    function push(list,value){
        if(value&&!list.includes(value)) list.push(value);
    }

    // Positions is one entry per AD, not per distinct title.
    //
    // push() was used here too, and it drops a value the list already holds - so an agency running
    // four separate "Software Developer" ads reached the file as one position and read as though it
    // were hiring for one. Location and Remote/Onsite keep using push(), because those describe the
    // company and really are a set: "London, London, London" is noise, three identical job titles
    // are three jobs - and on Reed, where most ads are posted by agencies, repeated titles under one
    // recruiter are the normal case rather than an oddity.
    //
    // An ad whose title could not be read is still an ad, so it is marked rather than dropped - the
    // number of entries in the cell always equals the number of ads behind the row.
    function keep(list,value){
        list.push(value||"(untitled)");
    }

    //---------------------------------------------------
    // helper: the work model
    //
    // The Location field is where the truth is, and the "Work from home" flag only says the job
    // allows it - not that there is no office. So:
    //   "Remote"              -> Remote  (nothing left once the remote words are stripped)
    //   "London" + the flag   -> Hybrid  (a town AND working from home)
    //   "Leeds, West Yorkshire" -> Onsite
    // The job title is deliberately NOT read: "... (remote friendly)" is marketing, not a field.
    //---------------------------------------------------

    function locationMode(location){

        const text=String(location||"");

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

        if(!badge) return "Onsite";

        if(HYBRID.test(badge)) return "Hybrid";

        // "Work from home" next to a real town is a job with an office and the option to work from
        // it or not; with no location at all there is nothing to be hybrid with.
        return String(location||"").trim()?"Hybrid":"Remote";

    }

    //---------------------------------------------------
    // helper: the headcount on a recruiter's profile page
    //
    // Bounded, never a scan of the whole body: a profile page's own advertising copy says things
    // like "we place over 500 people a year", which a body-wide regex reads as a headcount and
    // writes into the file looking exactly like a real one. An empty cell is recoverable; a
    // plausible wrong number is not.
    //
    // Returns true (found), false (read, nothing there) or null (never arrived) - the caller
    // counts the first two towards the probe and leaves the third to the retry pass.
    //---------------------------------------------------

    async function readSize(company){

        const doc=await fetchDoc(company.profileUrl,{needs:SIZE_HINT});

        if(!doc){

            // marked, not counted: the retry pass decides whether this is a real failure
            company.failed=true;

            return null;

        }

        company.failed=false;

        const size=core.headcount(doc,{label:SIZE_LABEL,value:SIZE_VALUE});

        if(size.text){

            company.employees=size.text;
            company.employeesSource=size.source;

            return true;

        }

        return false;

    }

    //---------------------------------------------------
    // helper: URL of the next page
    //---------------------------------------------------

    // `from` is the URL this document was fetched from. A "next" link has to actually move
    // FORWARD, and checking that is what makes the deliberately loose selector list safe: a
    // numbered page link, a rel="next" on something that is not pagination, or the "Previous"
    // link all fail the same test and are ignored rather than sending the walk backwards.
    function nextUrl(doc,from){

        const here=core.paramOf(from||location.href,PAGE_PARAM,ORIGIN)||1;

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

                if((core.paramOf(candidate,PAGE_PARAM,ORIGIN)||1)>here) return candidate;

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
    // "1 - 25 of 3,494 jobs" in the paginator header, or the "3,494 ... Jobs" heading
    //---------------------------------------------------

    function readTotal(doc){

        const heading=pick(doc,TOTAL_HEADING).replace(/,/g,"");

        const of=/\bof\s+(\d+)/i.exec(heading);

        if(of) return +of[1];

        const h1=pick(doc,TOTAL_H1).replace(/,/g,"");

        const first=/(\d+)/.exec(h1);

        return first?+first[1]:0;

    }

})();
