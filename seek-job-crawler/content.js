(async()=>{

    const LOG="[seek-crawler]";

    //---------------------------------------------------
    // guard against double runs when the button is clicked repeatedly
    //---------------------------------------------------

    if(window.__seekCrawlerRunning){
        alert("Crawler is already running on this tab. Wait for it to finish.");
        return;
    }

    window.__seekCrawlerRunning=true;

    const core=window.CrawlerCore;

    if(!core){

        alert("core.js is not loaded in this tab. popup.js must inject core.js before content.js.");

        window.__seekCrawlerRunning=false;

        return;

    }

    const {norm,pick,blocks,nameKey}=core;

    // Shared across au.seek.com / my.jobstreet.com / sg.jobstreet.com / hk.jobsdb.com
    // (same SEEK platform, same DOM), so every URL is derived from the open tab.
    const ORIGIN=location.origin;

    // "hk.jobsdb.com" -> "hk_jobsdb", used in the file name so crawls of different sites do not overwrite each other
    const SITE=location.hostname.replace(/^www\./,"").split(".").slice(0,2).join("_").toLowerCase()||"seek";

    const FILENAME=SITE+"_companies.xlsx";

    // "5d ago", "3h ago", "30d+ ago" inside <div data-automation="jobListingDate">
    const LISTED_SHORT=/(\d+)\s*\+?\s*(mo|min|[mhdwy])\b/i;

    // the screen reader version: "Listed fourteen hours ago", "Listed one day ago"
    const LISTED_LONG=/listed\s+(.+?)\s+(minute|hour|day|week|month|year)s?\s+ago/i;

    const UNIT={min:1,m:1,minute:1,h:60,hour:60,d:1440,day:1440,w:10080,week:10080,mo:43200,month:43200,y:525600,year:525600};

    const WORDS={
        a:1,an:1,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
        eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,
        eighteen:18,nineteen:19,twenty:20,thirty:30
    };

    // "1,001-5,000 employees" on the company profile
    const SIZE_DOC=/([\d,]+\s*(?:[-–—]|to)\s*[\d,]+|[\d,]+\s*\+|[\d,]+)\s*employees/i;

    const jobs=[];

    // dedupe by job id: one listing can appear twice (sponsored + organic)
    const seenJobs=new Map();

    const startedAt=performance.now();

    const report=core.makeReporter("seek-crawler-status",LOG);

    // The pace floor is zero: SEEK does not push back on a normal search, and a fixed toll per
    // request cost about a minute across a 60 page run for nothing. The gate widens the moment
    // anything is actually refused.
    const gate=core.makeGate({minGap:0,limit:6,log:LOG});

    const fetcher=core.makeFetcher(gate,{log:LOG});

    const fetchDoc=fetcher.fetchDoc;

    // A tab navigation kills the content script outright - no catch block runs and nothing is
    // written. The checkpoint is what turns that from "the whole run is gone" into "the next run
    // starts where this one stopped".
    const checkpoint=core.makeCheckpoint("seekCheckpoint",{log:LOG});

    // pages whose fetch never came back, retried once the queue has drained
    let missedPages=[];
    let recoveredPages=0;

    let pageErrors=0;
    let resumed=0;

    // set the moment the file is handed to the browser, so the crash path can never write a second one
    let fileWritten=false;

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

        let workArrangements=[];
        let maxPages=0;
        let concurrency=6;

        try{

            const settings=await chrome.storage.local.get(["workArrangements","maxPages","concurrency"]);

            workArrangements=settings.workArrangements||[];
            maxPages=+settings.maxPages||0;

            if(settings.concurrency) concurrency=Math.min(12,Math.max(1,+settings.concurrency));

        }
        catch(e){
            console.warn(LOG,"could not read settings, exporting everything",e);
        }

        gate.limit=concurrency;
        gate.maxLimit=concurrency;

        console.log(LOG,"arrangement filter:",workArrangements.length?workArrangements.join(", "):"(none)");

        //---------------------------------------------------
        // 1b. pick up an unfinished run on the same search
        //     A crawl that died with the tab left its jobs in storage; re-reading those pages costs
        //     requests to collect data we already had.
        //---------------------------------------------------

        const saved=await checkpoint.load();

        if(saved&&Array.isArray(saved.jobs)&&saved.jobs.length){

            for(const job of saved.jobs){

                if(!job||!job.id||seenJobs.has(job.id)) continue;

                seenJobs.set(job.id,job);
                jobs.push(job);
                resumed++;

            }

            report(`Resumed ${resumed} job(s) from an unfinished run on this search.`);

        }

        //---------------------------------------------------
        // 2. collect jobs across every page
        //---------------------------------------------------

        const paging=readPagination();

        const lastPage=maxPages?Math.min(paging.last,maxPages):paging.last;

        const pages=[];

        for(let p=1;p<=lastPage;p++) pages.push(p);

        // the open page is always included: it is already in the DOM and costs no request
        if(!pages.includes(paging.current)) pages.unshift(paging.current);

        console.log(LOG,`pagination: current=${paging.current}, last=${paging.last} `
            +`(${paging.totalJobs} jobs / ${paging.pageSize} per page), crawling ${pages.length} page(s), concurrency=${concurrency}`);

        let emptyStreak=0;
        let done=0;

        // No batch barrier: the pool keeps `concurrency` pages in flight at all times while the
        // main loop consumes them strictly in page order. The old slice-then-Promise.all pattern
        // paid the cost of the SLOWEST page in every batch and left every other worker idle.
        const walk=await core.pipelinePages(pages,async page=>{

            // the open page: read the already rendered DOM directly, no request needed
            if(page===paging.current) return document;

            return fetchDoc(paging.pageUrl(page));

        },async (page,doc)=>{

            done++;

            if(!doc){

                pageErrors++;

                // A page that ERRORED is not a page that ran out of results. Counting it towards
                // the empty streak is what used to end a crawl at page 12 of 80 after two
                // unlucky requests, and report it as a clean finish.
                report(`Page ${page} (${done}/${pages.length}): request failed, will retry at the end`);

                return "";

            }

            const found=collectFrom(doc);

            report(`Page ${page} (${done}/${pages.length}): +${found.added} -> ${jobs.length} jobs`);

            await checkpoint.save({jobs});

            // out of results, or the HTML returned by the server does not include the list
            if(page!==paging.current&&found.cards===0) emptyStreak++;
            else emptyStreak=0;

            if(emptyStreak>=2){

                console.warn(LOG,"2 fetched pages in a row had no job cards - end of results, "
                    +"or the server HTML does not include the list. Stopping pagination.");

                return "stop";

            }

            return "";

        },{limit:concurrency,log:LOG});

        //---------------------------------------------------
        // 2b. second pass over the pages that never came back
        //     Whatever refused them has had the whole rest of the list to cool off, so most of
        //     them arrive now - and each one is a page of jobs that would otherwise be missing
        //     from the file with nothing to say it ever existed.
        //---------------------------------------------------

        missedPages=walk.missed.slice();

        if(missedPages.length&&!gate.dead){

            report(`Retrying ${missedPages.length} page(s) that failed...`);

            const stillMissing=[];

            for(const page of missedPages){

                const doc=await fetchDoc(paging.pageUrl(page),{tries:3});

                if(!doc){
                    stillMissing.push(page);
                    continue;
                }

                const found=collectFrom(doc);

                recoveredPages++;

                report(`Recovered page ${page}: +${found.added} -> ${jobs.length} jobs`);

            }

            missedPages=stillMissing;

            await checkpoint.save({jobs},true);

        }

        console.log(LOG,"jobs found:",jobs.length);

        if(jobs.length===0){

            alert("No jobs found on "+location.hostname+". Open a search results page and run again.");
            return;

        }

        //---------------------------------------------------
        // 3. filter by work arrangement
        //---------------------------------------------------

        let skipped=0;

        const kept=jobs.filter(job=>{

            if(!matches(job.arrangement,workArrangements)){

                skipped++;
                return false;

            }

            return true;

        });

        if(kept.length===0){

            const msg=`No job matched the filter. ${skipped} skipped.`;
            console.warn(LOG,msg);
            alert(msg);
            return;

        }

        //---------------------------------------------------
        // 4. group jobs by company
        //---------------------------------------------------

        const companies=groupByCompany(kept);

        console.log(LOG,`${kept.length} jobs -> ${companies.length} companies`);

        //---------------------------------------------------
        // 5. Employees is NOT on the results page, only on the company profile
        //    -> one extra request per company
        //---------------------------------------------------

        let processed=0;
        let withProfile=0;

        await core.mapPool(companies,concurrency,async(company,index)=>{

            // prefer the /companies/<slug> page: it reliably carries the company size.
            // for companies with no SEEK profile, fall back to reading the job page.
            const url=company.profileUrl||company.jobUrl;

            const doc=await fetchDoc(url);

            if(!doc){

                // marked, not counted: the retry pass below decides whether this is a real failure
                company.failed=true;

            }
            else{

                company.failed=false;

                const found=blocks(doc.body).join(" ").match(SIZE_DOC);

                if(found){
                    company.employees=found[0].replace(/\s+/g," ").trim();
                    withProfile++;
                }
                else if(index<3){
                    console.warn(LOG,"no employee count on",url);
                }

            }

            processed++;

            report(`[${processed}/${companies.length}] ${company.name}`);

        },{
            log:LOG,
            // A company refused at the busiest moment of the run is almost always readable once
            // the queue has drained. Without this its size cell is blank, and a blank cell is
            // indistinguishable from "this company publishes no headcount".
            shouldRetry:company=>company.failed===true,
            onRetryPass:count=>report(`Retrying ${count} company page(s) that failed...`)
        });

        const failed=companies.filter(company=>company.failed).length;

        finish({companies,kept,skipped,withProfile,failed,paging,crashed:null});

    }
    catch(e){

        console.error(LOG,"crawl aborted:",e);

        // Everything collected up to the crash is real data. Throwing it away because the last
        // step failed is the single most expensive thing this crawler used to do.
        salvage(e);

    }
    finally{

        window.__seekCrawlerRunning=false;

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
            "Recruitment time":newestListed(company.jobs),
            "Employees":company.employees,
            "Remote/Onsite":company.modes.join(", ")
        }));

        const written=core.exportXlsx(results,{
            headers:HEADERS,
            widths:[32,26,60,16,20,18],
            filename:FILENAME,
            log:LOG
        });

        const withTime=results.filter(r=>r["Recruitment time"]).length;
        const elapsed=Math.round((performance.now()-startedAt)/1000);

        const total=state.paging&&state.paging.totalJobs||0;

        // Say the coverage gap out loud. "2,140 jobs" reads like a complete run right up until it
        // is put next to the 2,735 the platform advertises.
        const coverage=total
            ? `\nCoverage: ${jobs.length} of the ${total} jobs SEEK reports`
                +(jobs.length<total?` - ${total-jobs.length} NOT READ`:" - complete")
            : "";

        const problems=[
            pageErrors?`${pageErrors} page request error(s)`:"",
            recoveredPages?`${recoveredPages} page(s) recovered on the retry pass`:"",
            missedPages.length?`${missedPages.length} page(s) could not be read at all -> ${missedPages.slice(0,12).join(", ")}`:"",
            state.failed?`${state.failed} company page(s) unreadable after retries`:"",
            written.clipped?`${written.clipped} cell(s) truncated to fit Excel's 32,767 character limit`:""
        ].filter(Boolean);

        const summary=`Done in ${elapsed}s: ${results.length} companies from ${state.kept.length} jobs, `
            +`${state.skipped} jobs skipped by filter, ${state.withProfile} with employee count, `
            +`${withTime} with recruitment time.`
            +(resumed?`\nResumed ${resumed} job(s) from an earlier unfinished run.`:"")
            +coverage
            +(problems.length?"\n\n"+problems.join("\n"):"")
            +(fetcher.describe()?`\nRequests: ${fetcher.describe()}`:"")
            +(state.crashed?`\n\nThe run stopped early: ${state.crashed}.`
                +"\nEverything collected before that point is in the file above.":"");

        report(summary);

        // the run reached the file, so there is nothing left to resume
        if(!state.crashed) checkpoint.clear();

        // let the download start before the alert blocks the page
        setTimeout(()=>alert(summary+"\nSaved as "+FILENAME),0);

    }

    // build the file out of whatever survived the crash
    function salvage(error){

        try{

            if(jobs.length===0){
                alert("Crawl failed before anything was collected: "+(error&&error.message||error));
                return;
            }

            const companies=groupByCompany(jobs);

            finish({
                companies,
                kept:jobs,
                skipped:0,
                withProfile:companies.filter(c=>c.employees).length,
                failed:0,
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
    // helper: collect jobs from one results page (live DOM or an already parsed document)
    //---------------------------------------------------

    function collectFrom(root){

        const cards=root.querySelectorAll('article[data-testid="job-card"]');

        let added=0;

        cards.forEach(card=>{

            const id=card.getAttribute("data-job-id");

            if(!id) return;

            const job=readCard(card,id);

            const old=seenJobs.get(id);

            if(old){

                // Sponsored listings show "Featured" instead of the posting date, but they
                // usually reappear in the organic results with the real date -> patch the old entry.
                if(!old.listed&&job.listed){
                    old.listed=job.listed;
                    old.listedAge=job.listedAge;
                }

                // and a sponsored card carries no company profile link
                if(!old.profileUrl&&job.profileUrl) old.profileUrl=job.profileUrl;

                return;

            }

            seenJobs.set(id,job);
            jobs.push(job);

            added++;

        });

        if(cards.length===0){
            console.warn(LOG,'no article[data-testid="job-card"] on this page');
        }

        return {cards:cards.length,added};

    }

    //---------------------------------------------------
    // helper: read one card
    //---------------------------------------------------

    function readCard(card,id){

        // "(Remote)" -> strip the parentheses
        const arrangement=pick(card,'[data-testid="work-arrangement"]').replace(/^\(|\)$/g,"");

        const listed=readListed(card);

        // the company logo is the only link pointing at the company profile; for companies
        // without a profile this element does not exist
        const profile=card.querySelector('a[data-testid="job-card-company-logo-link"]');

        return {
            id,
            title:pick(card,'[data-automation="jobTitle"]'),
            company:pick(card,'[data-automation="jobCompany"]'),
            location:pick(card,'[data-automation="jobLocation"]'),
            arrangement,
            listed:listed.text,
            listedAge:listed.age,
            profileUrl:profile?absolute(profile.getAttribute("href")):"",
            jobUrl:ORIGIN+"/job/"+id
        };

    }

    function absolute(href){
        return href?new URL(href,ORIGIN).toString():"";
    }

    //---------------------------------------------------
    // helper: the posting date
    //   displayed: <div data-automation="jobListingDate"><span>5d ago</span></div>
    //   sponsored: the same spot says "Featured" -> no date
    //   fallback:  <div class="...">Listed five days ago</div> (screen readers only)
    //---------------------------------------------------

    function readListed(card){

        const box=card.querySelector('[data-automation="jobListingDate"]');

        // "8d ago • Expiring" -> the first span holds the date
        const short=box?(norm(box.querySelector("span"))||norm(box)):"";

        const m=short.match(LISTED_SHORT);

        if(m) return {text:short,age:+m[1]*UNIT[m[2].toLowerCase()]};

        const long=blocks(card).join(" ").match(LISTED_LONG);

        if(long){

            const count=wordNumber(long[1]);

            if(count!=null){

                const unit=long[2].toLowerCase();

                return {text:`${count} ${unit}${count>1?"s":""} ago`,age:count*UNIT[unit]};

            }

        }

        // No date is the OLDEST thing we can say about a listing, not the newest. Returning 0 here
        // made an undated sponsored card win every "which listing is newest" comparison and put a
        // blank Recruitment time on companies that had a perfectly good date on another listing.
        return {text:"",age:Infinity};

    }

    // "fourteen" -> 14, "twenty one" -> 21
    function wordNumber(text){

        const clean=text.toLowerCase().replace(/-/g," ").trim();

        if(/^\d+$/.test(clean)) return +clean;

        let total=0;

        for(const part of clean.split(/\s+/)){

            if(WORDS[part]==null) return null;

            total+=WORDS[part];

        }

        return total;

    }

    // the company's newest listing
    function newestListed(list){

        let best="";
        let bestAge=Infinity;

        for(const job of list){

            if(!job.listed) continue;

            if(job.listedAge<bestAge){
                bestAge=job.listedAge;
                best=job.listed;
            }

        }

        return best;

    }

    //---------------------------------------------------
    // helper: group jobs by company
    //
    // Grouping on the raw name split "ACME Pte Ltd" and "ACME Pte. Ltd." into two rows, each
    // holding a slice of the positions. nameKey folds the legal-form suffix and the punctuation
    // and nothing else, so distinct employers still stay apart.
    //---------------------------------------------------

    function groupByCompany(list){

        const byName=new Map();

        for(const job of list){

            const name=job.company||"(unknown)";
            const key=nameKey(name);

            let company=byName.get(key);

            if(!company){

                company={
                    name,
                    jobs:[],
                    locations:[],
                    positions:[],
                    modes:[],
                    profileUrl:"",
                    jobUrl:job.jobUrl,
                    employees:"",
                    failed:false
                };

                byName.set(key,company);

            }

            company.jobs.push(job);

            // only companies with a profile expose a headcount
            if(!company.profileUrl&&job.profileUrl) company.profileUrl=job.profileUrl;

            push(company.positions,job.title);
            push(company.locations,job.location);
            push(company.modes,readMode(job.arrangement));

        }

        return [...byName.values()];

    }

    function push(list,value){
        if(value&&!list.includes(value)) list.push(value);
    }

    // SEEK writes "Remote" / "Hybrid" / "On-site" -> normalize to Remote/Hybrid/Onsite
    function readMode(text){

        if(/hybrid/i.test(text)) return "Hybrid";
        if(/remote/i.test(text)) return "Remote";
        if(/on-?\s?site|in office/i.test(text)) return "Onsite";

        return "";

    }

    //---------------------------------------------------
    // helper: read the pagination
    // The nav only shows the first few pages, so the total page count cannot be derived from it.
    // The real numbers live in the data-sol-meta of #searchResultSummary:
    //   {"pageSize":32,"pageNumber":1,"totalJobCount":2735,...}
    //---------------------------------------------------

    function readPagination(){

        const here=new URL(location.href);

        let current=+here.searchParams.get("page")||1;
        let pageSize=0;
        let totalJobs=0;
        let template=null;

        const summary=document.querySelector('[data-automation="searchResultSummary"]');

        if(summary){

            try{

                const meta=JSON.parse(summary.getAttribute("data-sol-meta")||"{}");

                pageSize=+meta.pageSize||0;
                totalJobs=+meta.totalJobCount||0;

                if(meta.pageNumber) current=+meta.pageNumber;

            }
            catch(e){
                console.warn(LOG,"could not parse data-sol-meta",e);
            }

        }

        const nav=document.querySelector('nav[aria-label="Pagination of results"]');

        if(nav){

            nav.querySelectorAll("a[href][aria-label]").forEach(a=>{

                // "Prev" / "Next" have no number, so they drop out on their own
                if(!/^go to page \d+$/i.test(a.getAttribute("aria-label"))) return;

                // numbered links carry ?page=N -> use one as the template and keep the URL filters
                if(!template&&/[?&]page=\d+/.test(a.getAttribute("href"))){
                    template=new URL(a.getAttribute("href"),location.href);
                }

            });

        }
        else{
            console.warn(LOG,"no pagination nav found");
        }

        if(!template) template=here;

        // the nav only lists 1-2-3, so this has to be computed from the total job count
        const last=pageSize&&totalJobs?Math.ceil(totalJobs/pageSize):current;

        return {
            current,
            last:Math.max(last,current),
            pageSize,
            totalJobs,
            pageUrl(page){

                const url=new URL(template);

                url.searchParams.set("page",page);

                return url.toString();

            }
        };

    }

    //---------------------------------------------------
    // helper: filter matching
    // "On-site" and "On site" count as the same value
    //---------------------------------------------------

    function matches(value,allowed){

        if(!allowed.length) return true;

        const key=t=>(t||"").toLowerCase().replace(/[\s-]+/g,"");

        // the value could not be read while a filter is active -> reject
        if(!value) return false;

        return allowed.some(option=>key(option)===key(value));

    }

})();
