(async()=>{

    const LOG="[mcf-crawler]";
    const ORIGIN="https://www.mycareersfuture.gov.sg";

    //---------------------------------------------------
    // guard against double runs when the button is clicked repeatedly
    //---------------------------------------------------

    if(window.__mcfCrawlerRunning){
        alert("Crawler is already running on this tab. Wait for it to finish.");
        return;
    }

    window.__mcfCrawlerRunning=true;

    const core=window.CrawlerCore;

    if(!core){

        alert("core.js is not loaded in this tab. popup.js must inject core.js before content.js.");

        window.__mcfCrawlerRunning=false;

        return;

    }

    // The pace floor is zero. The old crawler slept a flat 800ms after every page and 150ms after
    // every detail request, whether or not MCF minded: on a 48 page search that alone was 38
    // seconds of doing nothing, before a single company had been looked at. The gate widens the
    // moment anything is actually refused, which is the only time the wait buys anything.
    const gate=core.makeGate({minGap:0,limit:6,log:LOG});

    const fetcher=core.makeFetcher(gate,{
        log:LOG,
        // Two refusals in a row are answered by a real navigation, not by the rest of the
        // ladder - but only while there is a tab left to open. See core.makeFetcher.
        canEscalate:()=>tabs.available
    });

    // MCF does not expose pageSize in the DOM; the site default is 20
    const DEFAULT_PAGE_SIZE=20;

    // How long a page turn in the live tab gets, and how often it is looked at. The poll interval
    // is itself part of the runtime - every check costs half its interval on average - so it is
    // small enough to be free. The ceiling is unchanged: 6 seconds was 24 steps of 250ms.
    const PAGE_TIMEOUT=6000;
    const PAGE_POLL=40;

    // "Posted 4 days ago" / "Posted today" / "Posted 04 Aug 2026"
    const UNIT={minute:1,hour:60,day:1440,week:10080,month:43200,year:525600};

    // company profile: "50 - 100 employees" or "Company size: 50-100"
    //
    // Either the "Company size" prefix or the "employees" suffix is REQUIRED. A bare number is
    // never a headcount, and this regex used to be run over the whole page body, where "50" from
    // a salary, a postcode or a benefits list matched just as happily.
    const RANGE="[\\d,]+\\s*(?:[-–—]|to)\\s*[\\d,]+|[\\d,]+\\s*\\+|[\\d,]+";

    const SIZE_VALUE=new RegExp(`company\\s+size\\s*[:\\-]?\\s*(?:${RANGE})|(?:${RANGE})\\s*employees`,"i");

    // anchored: the whole text block is the label, and the value sits in the next one
    const SIZE_LABEL=/^company\s+size$/i;

    const startedAt=performance.now();

    // kept outside the try: collectFrom/loadPage are helpers at the end of the file and cannot see block-scoped declarations
    const jobs=[];
    const visited=new Set();
    let paging=null;

    const report=core.makeReporter("mcf-crawler-status",LOG);

    // A 429/403/5xx is often "that did not look like a browser" rather than "too fast", and no
    // amount of backing off answers it. Reopening the URL as a real navigation does, and if the
    // check needs a person the tab is put in front of them - once, for the whole site.
    const tabs=core.makeTabFallback({
        log:LOG,
        report,
        lastStatus:fetcher.lastStatus,
        describe:url=>"page "+((core.paramOf(url,"page",ORIGIN)||0)+1)
    });

    const fetchDoc=(url,opts)=>core.tabFirst(fetcher,tabs,url,opts);

    const norm=core.norm;
    const blocks=core.blocks;

    // A tab navigation kills the content script outright - no catch block runs and nothing is
    // written. The checkpoint turns that from "the whole run is gone" into "the next run starts
    // where this one stopped".
    const checkpoint=core.makeCheckpoint("mcfCheckpoint",{log:LOG});

    // set the moment the file is handed to the browser, so the crash path can never write a second one
    let fileWritten=false;

    let pageErrors=0;
    let recoveredPages=0;
    let resumed=0;

    // pages that never came back even after the retry pass
    let lostPages=[];

    // pages the crawl could never reach at all, because the SPA fallback only walks forward
    let unreachablePages=0;

    // the card truncates fields with several values: "Permanent ..." -> "Permanent"
    function pick(root,selector){
        return norm(root.querySelector(selector)).replace(/\s*\.\.\.$/,"");
    }

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

        let employmentTypes=[];
        let maxPages=0;
        let concurrency=6;

        try{

            const settings=await chrome.storage.local.get(["employmentTypes","maxPages","concurrency"]);

            employmentTypes=settings.employmentTypes||[];
            maxPages=+settings.maxPages||0;

            if(settings.concurrency) concurrency=Math.min(12,Math.max(1,+settings.concurrency));

        }
        catch(e){
            console.warn(LOG,"could not read settings, exporting everything",e);
        }

        console.log(LOG,"employment type filter:",employmentTypes.length?employmentTypes.join(", "):"(none)");

        gate.limit=concurrency;
        gate.maxLimit=concurrency;

        //---------------------------------------------------
        // 1b. pick up an unfinished run on the same search
        //---------------------------------------------------

        const saved=await checkpoint.load();

        if(saved&&Array.isArray(saved.jobs)&&saved.jobs.length){

            for(const job of saved.jobs){

                // `key` is what collectFrom keys `visited` on; "Job ID" is the fallback for a
                // checkpoint written before that field existed
                const id=job&&(job.key||job["Job ID"]);

                if(!id||visited.has(id)) continue;

                visited.add(id);
                jobs.push(job);
                resumed++;

            }

            report(`Resumed ${resumed} job(s) from an unfinished run on this search.`);

        }

        //---------------------------------------------------
        // 2. collect jobs across every page
        //---------------------------------------------------

        paging=readPagination();

        console.log(LOG,`pagination: current=${paging.current}, ~${paging.last} page(s) `
            +`(${paging.totalJobs} jobs, ~${paging.pageSize} per page), page param offset=${paging.offset}`);

        // the open page is already rendered: read it before anything is requested
        const first=collectFrom(document);

        report(`Page ${paging.current} (open tab): +${first.added} -> ${jobs.length} jobs`);

        // paging.last is only an estimate (pageSize is derived from the open page, which may be a
        // partly filled last page), so a couple of spare pages are walked and the empty ones stop it
        const estimated=maxPages?Math.min(paging.last,maxPages):paging.last+2;

        const wanted=[];

        // EVERY page from 1, not from wherever the tab happened to be left. Starting at the open
        // page silently dropped pages 1..current-1 - a tab parked on page 3 lost 40 jobs and the
        // summary said nothing at all about them.
        for(let page=1;page<=estimated;page++){

            if(page!==paging.current) wanted.push(page);

        }

        // MCF is a React app, so the server may answer ?page=N with a shell that has no cards in
        // it. One probe decides which mode the whole run uses, instead of finding out per page.
        const probe=wanted.length?await probeFetch(wanted[0]):null;

        if(probe&&probe.cards>0){

            const rest=wanted.slice(1);

            // No barrier: `concurrency` pages stay in flight while the main loop consumes them in
            // page order, so the file comes out the same way every run.
            const walk=await core.pipelinePages(rest,page=>fetchDoc(paging.pageUrl(page)),
                async (page,doc)=>{

                    if(!doc){

                        pageErrors++;

                        report(`Page ${page}: request failed, will retry at the end`);

                        return "";

                    }

                    const found=collectFrom(doc);

                    report(`Page ${page} (~${paging.last}): +${found.added} -> ${jobs.length} jobs`);

                    await checkpoint.save({jobs});

                    // a real empty page is the end of the results; a failed request is not, and
                    // conflating the two is what used to end a run two bad requests in
                    return found.cards===0?"stop":"";

                },{limit:concurrency,log:LOG});

            //---------------------------------------------------
            // second pass over the pages that never came back
            //---------------------------------------------------

            if(walk.missed.length&&!gate.dead){

                report(`Retrying ${walk.missed.length} page(s) that failed...`);

                for(const page of walk.missed){

                    const doc=await fetchDoc(paging.pageUrl(page),{tries:3});

                    if(!doc){
                        lostPages.push(page);
                        continue;
                    }

                    const found=collectFrom(doc);

                    recoveredPages++;

                    report(`Recovered page ${page}: +${found.added} -> ${jobs.length} jobs`);

                }

                await checkpoint.save({jobs},true);

            }
            else{
                lostPages=walk.missed.slice();
            }

        }
        else{

            // The list only exists once React has rendered it, so the pages have to be turned in
            // the live tab. That walk can only go FORWARD from where the tab is, so anything
            // before the open page is out of reach - say so rather than shipping a short file.
            unreachablePages=paging.current-1;

            if(unreachablePages>0){
                console.warn(LOG,`the server HTML has no job cards, so pages 1-${unreachablePages} `
                    +"cannot be reached from here - open the search on page 1 and run again for full coverage");
            }

            await clickThrough(estimated);

        }

        console.log(LOG,"jobs found:",jobs.length);

        if(jobs.length===0){

            alert("No jobs found. Open a mycareersfuture.gov.sg search results page and run again.");
            return;

        }

        //---------------------------------------------------
        // 3. filter
        //---------------------------------------------------

        let skipped=0;

        const kept=jobs.filter(job=>{

            const ok=matches(job["Employment Type"],employmentTypes);

            if(!ok){
                skipped++;
                console.log(LOG,"skip",job["Job Title"],"|",job["Employment Type"]);
            }

            return ok;

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
        // 5. Employees is on NEITHER the results page nor the job page.
        //    The company profile link only appears on the job page
        //    (<a data-testid="company-info-more-jobs" href="/companies/...">)
        //    -> one job page request + one company profile request per company.
        //---------------------------------------------------

        let failed=0;
        let processed=0;
        let dateFixed=0;

        await core.mapPool(companies,concurrency,async(company,index)=>{

            company.failed=false;

            // No listing of this company had a readable link, so there is no job page to open and
            // therefore no route to the company profile. Left blank rather than fetched: "" resolves
            // to the search page itself, which answers 200, carries no profile link, and costs a
            // request plus a retry pass to arrive at the same empty cell.
            if(!company.jobUrl){

                if(!company.counted){
                    company.counted=true;
                    processed++;
                }

                return;

            }

            const doc=await fetchDoc(company.jobUrl);

            if(!doc){

                failed++;

                // marked so the retry pass can come back for it once the queue has drained: a
                // blank Employees cell is indistinguishable from "this company publishes none"
                company.failed=true;

            }
            else{

                // the card only says "Viewed today" when you have already opened the listing ->
                // that is not the posting date. The job page carries the real one: "Posted 04 Aug 2026".
                if(!company.posted){

                    const detail=readPosted(pick(doc,'[data-testid="job-details-info-last-posted-date"]'));

                    if(detail.text){
                        company.posted=detail.text;
                        dateFixed++;
                    }

                }

                const profile=doc.querySelector('[data-testid="company-info-more-jobs"]');

                if(profile){

                    const page=await fetchDoc(ORIGIN+profile.getAttribute("href"));

                    if(page){

                        // bounded to a labelled field or a small element that IS the value -
                        // joining the whole body and running the regex over it turned any number
                        // followed by "employees" anywhere on the page into a headcount
                        const size=core.headcount(page,{label:SIZE_LABEL,value:SIZE_VALUE});

                        if(size.text){
                            company.employees=size.text;
                            company.employeesSource=size.source;
                        }
                        else if(index<3) console.warn(LOG,"no employee count on the company page of",company.name);

                    }
                    else{
                        failed++;
                        company.failed=true;
                    }

                }
                else if(index<3){
                    console.warn(LOG,"no company profile link on",company.jobUrl);
                }

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
        // 6. export to excel + trigger the download
        //---------------------------------------------------

        // counted off the data at the end rather than inside the worker, which the retry pass
        // runs a second time for every company that failed the first
        const withSize=companies.filter(company=>company.employees).length;

        finish({companies,kept,skipped,withSize,dateFixed,failed,crashed:null});

    }
    catch(e){

        console.error(LOG,"crawl aborted:",e);

        // Everything collected up to the crash is real data. Throwing it away because the last
        // step failed is the single most expensive thing this crawler used to do.
        salvage(e);

    }
    finally{

        window.__mcfCrawlerRunning=false;

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
            widths:[36,22,60,16,20,18],
            filename:"mycareersfuture_companies.xlsx",
            log:LOG
        });

        const withTime=results.filter(r=>r["Recruitment time"]).length;
        const elapsed=Math.round((performance.now()-startedAt)/1000);

        const total=paging&&paging.totalJobs||0;

        // Say the coverage gap out loud. "820 jobs" reads like a complete run right up until it is
        // put next to the 955 the search advertises.
        const coverage=total
            ? `\nCoverage: ${jobs.length} of the ${total} jobs the search reports`
                +(jobs.length<total?` - ${total-jobs.length} NOT READ`:" - complete")
            : "";

        const problems=[
            unreachablePages>0
                ? `Pages 1-${unreachablePages} were never read: the tab was open on page ${paging.current} `
                    +"and this search only renders its list in the browser, so the crawl could not go "
                    +"backwards. Open the search on page 1 and run again for full coverage."
                : "",
            pageErrors?`${pageErrors} page request error(s)`:"",
            recoveredPages?`${recoveredPages} page(s) recovered on the retry pass`:"",
            lostPages.length?`${lostPages.length} page(s) could not be read at all -> ${lostPages.slice(0,12).join(", ")}`:"",
            written.clipped?`${written.clipped} cell(s) truncated to fit Excel's 32,767 character limit`:""
        ].filter(Boolean);

        const summary=`Done in ${elapsed}s: ${results.length} companies from ${state.kept.length} jobs, `
            +`${state.skipped} jobs skipped by filter, ${state.withSize} with employee count, `
            +`${withTime} with recruitment time (${state.dateFixed} read off the job page), `
            +`${state.failed} request errors.`
            +(resumed?`\nResumed ${resumed} job(s) from an earlier unfinished run.`:"")
            +coverage
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
        setTimeout(()=>alert(summary+"\nSaved as mycareersfuture_companies.xlsx"),0);

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
                withSize:companies.filter(c=>c.employees).length,
                dateFixed:0,
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
    // helper: one probe that decides how the whole run reads its pages
    //
    // Fetching is far cheaper than driving the tab, but MCF is a React app and the server may
    // answer ?page=N with a shell holding no cards at all. Finding that out once, up front, beats
    // discovering it per page - and a request that merely FAILED must not be read as "this site
    // is client rendered", or one unlucky moment downgrades the entire run to clicking.
    //---------------------------------------------------

    async function probeFetch(page){

        const doc=await fetchDoc(paging.pageUrl(page),{tries:4});

        if(!doc){

            pageErrors++;

            console.warn(LOG,"the probe request failed - falling back to in-page pagination");

            return null;

        }

        const found=collectFrom(doc);

        report(`Page ${page}: +${found.added} -> ${jobs.length} jobs`);

        if(found.cards===0){
            console.warn(LOG,"server HTML has no job cards, switching to in-page pagination (clicking Next)");
        }

        return found;

    }

    //---------------------------------------------------
    // helper: turn the pages in the live tab
    // MCF's pagination controls are <button> elements with no href, so clicking is the only
    // option once the server HTML turns out not to carry the list.
    //---------------------------------------------------

    async function clickThrough(lastPage){

        let emptyStreak=0;

        for(let page=paging.current+1;page<=lastPage;page++){

            if(!await clickNext()){

                pageErrors++;

                console.warn(LOG,`could not reach page ${page} - stopping with ${jobs.length} job(s)`);

                break;

            }

            const found=collectFrom(document);

            report(`Page ${page} (~${paging.last}): +${found.added} -> ${jobs.length} jobs`);

            await checkpoint.save({jobs});

            if(found.cards===0){

                emptyStreak++;

                if(emptyStreak>=2){
                    console.warn(LOG,"2 pages in a row had no job cards - end of results.");
                    break;
                }

            }
            else{
                emptyStreak=0;
            }

        }

        await checkpoint.save({jobs},true);

    }

    // MCF's pagination controls are <button> elements with no href, so clicking is the only option
    async function clickNext(){

        const button=document.querySelector('[data-testid="pagination"] button[aria-label="Next"]');

        if(!button||button.disabled){
            console.warn(LOG,"no usable Next button");
            return false;
        }

        const before=firstJobHref();

        button.click();

        // React re-renders the list -> wait for the first card to change.
        //
        // The check comes BEFORE the sleep, and the sleep is short. It used to be the other way
        // round with a 250ms step, so a re-render that finished in 20ms was still charged the full
        // quarter second - on a 48 page search that is twelve seconds of watching a list that had
        // already changed. Waiting is only ever worth what it takes to notice.
        const deadline=performance.now()+PAGE_TIMEOUT;

        for(;;){

            const now=firstJobHref();

            if(now&&now!==before) return true;

            if(performance.now()>deadline) break;

            await core.sleep(PAGE_POLL);

        }

        console.warn(LOG,"the list did not change after clicking Next");

        return false;

    }

    function firstJobHref(){

        const a=document.querySelector('[data-testid="job-card-link"]');

        return a?a.getAttribute("href"):"";

    }

    //---------------------------------------------------
    // helper: collect jobs from one page (live DOM or an already parsed document)
    //---------------------------------------------------

    function collectFrom(root){

        const cards=root.querySelectorAll('[data-testid="job-card"]');

        let added=0;
        let search=0;
        let noOwnId=0;

        cards.forEach(card=>{

            const link=card.querySelector('[data-testid="job-card-link"]');

            const href=link&&link.getAttribute("href")||"";

            // count real result cards separately (excluding "Recommended") to know when everything is in
            if(href&&!/event=SuggestedJob/.test(href)) search++;

            // a 32 hex character uuid at the end of the path
            const path=href.split("?")[0];
            const uuid=(path.match(/([0-9a-f]{32})$/)||[])[1]||"";

            // The uuid, then the link's own path, and only then what the card says.
            //
            // A card with no link, or a link MCF has changed the shape of, used to be dropped here -
            // the JOB was lost over the id. The path is just as unique per listing as the uuid, and
            // the fingerprint is what is left when there is no link at all. It is made of the card's
            // text rather than its position on purpose: pages are fetched in parallel and re-read on
            // a resumed run, so an index-based key would give one listing a new identity each time
            // and duplicate it instead of deduplicating it.
            const own=uuid||path;

            if(!own) noOwnId++;

            const id=own||("card:"+[
                pick(card,'[data-testid="job-card__job-title"]'),
                pick(card,'[data-testid="company-hire-info"]'),
                pick(card,'[data-testid="job-card__location"]')
            ].join("|"));

            // "Recommended" jobs repeat inside the normal results -> dedupe by uuid
            if(visited.has(id)) return;

            visited.add(id);

            jobs.push(readCard(card,uuid,href,id));

            added++;

        });

        if(cards.length===0){
            console.warn(LOG,'no [data-testid="job-card"] on this page');
        }

        if(noOwnId){
            console.warn(LOG,`${noOwnId} of ${cards.length} card(s) had no job link - they were kept `
                +"and identified by what the card says, but they have no Job URL to read details from");
        }

        return {cards:cards.length,added,search};

    }

    //---------------------------------------------------
    // helper: read one card
    //---------------------------------------------------

    function readCard(card,id,href,key){

        const salary=readSalary(card);

        // "Posted 4 days ago" -> the posting date; "Viewed today" -> only when you last opened it
        const posted=readPosted(pick(card,'[data-cy="job-card-date-info"]'));

        return {
            postedText:posted.text,
            postedAge:posted.age,

            // What `visited` was keyed on, kept so a resumed run keys on the same thing. "Job ID" is
            // MCF's uuid and is empty for a card that had no link, so resuming on that dropped
            // exactly the jobs this fallback exists to save.
            key:key||id,

            // MCF's FWA field: "Flexi-Hours" / "Work-From-Home" / "Hybrid"
            fwa:pick(card,'[data-testid="job-card__fwa"]'),

            "Job ID":id,
            "Job Title":pick(card,'[data-testid="job-card__job-title"]'),
            "Company":pick(card,'[data-testid="company-hire-info"]'),
            "Location":pick(card,'[data-testid="job-card__location"]'),
            "Employment Type":pick(card,'[data-testid="job-card__employment-type"]'),
            "Seniority":pick(card,'[data-testid="job-card__seniority"]'),
            "Category":pick(card,'[data-testid="job-card__category"]'),
            "Min Experience":pick(card,'[data-testid="job-card__min-experience"]'),
            "Salary Min":salary.min,
            "Salary Max":salary.max,
            "Salary Type":pick(card,'[data-testid="salary-type"]'),
            "Applications":pick(card,'[data-testid="job-card__num-of-applications"]'),
            "Posted":pick(card,'[data-cy="job-card-date-info"]'),
            "Source":/event=SuggestedJob/.test(href)?"Recommended":"Search",
            // "" rather than ORIGIN when the card had no link at all: the detail phase fetches this
            // URL, and ORIGIN is the search page itself - a request that succeeds, carries no
            // company profile link, and quietly costs the company its Employees cell
            "Job URL":href?ORIGIN+href.split("?")[0]:""
        };

    }

    // <span data-testid="salary-range"><span>$5.000</span><span><span>to</span>$7.000</span></span>
    // textContent runs together into "$5.000to$7.000"; SG uses a dot as the thousands separator
    function readSalary(card){

        const text=norm(card.querySelector('[data-testid="salary-range"]'));

        const amounts=(text.match(/\$\s?[\d.,]+/g)||[])
            .map(s=>parseInt(s.replace(/[^\d]/g,""),10))
            .filter(n=>!isNaN(n));

        if(amounts.length===0) return {min:"",max:""};

        return {
            min:Math.min(...amounts),
            max:Math.max(...amounts)
        };

    }

    //---------------------------------------------------
    // helper: read the pagination
    // <div data-testid="pagination">
    //   <button aria-current="page" data-testid="pagination-button--0" disabled>1</button>
    //   <button data-testid="pagination-button--1">2</button>
    //   <button aria-label="Next" data-testid="pagination-button--❯">❯</button>
    // The buttons have no href and only the first few pages are shown -> the total page count
    // comes from "955 jobs found", and the ?page= offset against the button index is probed.
    //---------------------------------------------------

    function readPagination(){

        const here=new URL(location.href);

        const label=norm(document.querySelector('[data-testid="search-results-page-label"]'));

        const totalJobs=+(label.match(/([\d,]+)\s*jobs?\s*found/i)||[])[1]?.replace(/,/g,"")||0;

        let buttonIndex=0;
        let current=1;

        const pagination=document.querySelector('[data-testid="pagination"]');

        if(pagination){

            const active=pagination.querySelector('button[aria-current="page"]');

            if(active){

                buttonIndex=+(active.getAttribute("data-testid").match(/--(\d+)$/)||[])[1]||0;
                current=+norm(active)||buttonIndex+1;

            }

        }
        else{
            console.warn(LOG,"no pagination found, crawling the current page only");
        }

        // MCF's ?page= is zero-based, but probe it to be sure instead of guessing
        const urlPage=here.searchParams.get("page");
        const offset=urlPage===null?0:(+urlPage-buttonIndex);

        // pageSize is not readable from the DOM -> count this page's normal cards (excluding "Recommended")
        const onThisPage=[...document.querySelectorAll('[data-testid="job-card-link"]')]
            .filter(a=>!/event=SuggestedJob/.test(a.getAttribute("href")||"")).length;

        const pageSize=onThisPage||DEFAULT_PAGE_SIZE;

        const last=totalJobs?Math.max(Math.ceil(totalJobs/pageSize),current):current;

        return {
            current,
            last,
            pageSize,
            totalJobs,
            offset,
            pageUrl(page){

                const url=new URL(here);

                url.searchParams.set("page",page-1+offset);

                return url.toString();

            }
        };

    }

    //---------------------------------------------------
    // helper: the posting date
    //   card:     "Posted today" | "Posted yesterday" | "Posted 4 days ago" | "Viewed today"
    //   job page: "Posted 04 Aug 2026"
    // "Viewed ..." is when you opened the listing, NOT the posting date -> treat it as missing.
    //---------------------------------------------------

    function readPosted(text){

        if(!text||/^viewed\b/i.test(text)) return {text:"",age:Infinity};

        const clean=text.replace(/^posted\s+/i,"").trim();

        if(/^today$/i.test(clean)) return {text:clean,age:0};
        if(/^yesterday$/i.test(clean)) return {text:clean,age:1440};

        const relative=clean.match(/^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/i);

        if(relative) return {text:clean,age:+relative[1]*UNIT[relative[2].toLowerCase()]};

        // "04 Aug 2026"
        const stamp=Date.parse(clean);

        if(!isNaN(stamp)) return {text:clean,age:Math.max(0,(Date.now()-stamp)/60000)};

        return {text:clean,age:Infinity};

    }

    //---------------------------------------------------
    // helper: group jobs by company
    //---------------------------------------------------

    function groupByCompany(list){

        const byName=new Map();

        for(const job of list){

            const name=job["Company"]||"(unknown)";

            // Grouping on the lowercased name split "ACME PTE. LTD." and "ACME PTE LTD" into two
            // rows, each holding a slice of the positions - and on a Singapore board almost every
            // employer carries that suffix. core.nameKey folds case, punctuation and a closed list
            // of legal forms and nothing else, so distinct employers still stay apart.
            const key=core.nameKey(name);

            let company=byName.get(key);

            if(!company){

                company={
                    name,
                    locations:[],
                    positions:[],
                    modes:[],
                    posted:"",
                    postedAge:Infinity,
                    jobUrl:job["Job URL"],
                    employees:"",
                    // "label" | "near" | "" - see core.headcount
                    employeesSource:""
                };

                byName.set(key,company);

            }

            keep(company.positions,job["Job Title"]);
            push(company.locations,job["Location"]);
            push(company.modes,readMode(job.fwa));

            // the newest listing, and its URL as the one to read the details from
            if(job.postedAge<company.postedAge){
                company.postedAge=job.postedAge;
                company.posted=job.postedText;
                if(job["Job URL"]) company.jobUrl=job["Job URL"];
            }

            // ...and the row still needs A url even when its newest listing had none
            if(!company.jobUrl&&job["Job URL"]) company.jobUrl=job["Job URL"];

        }

        return [...byName.values()];

    }

    function push(list,value){
        if(value&&!list.includes(value)) list.push(value);
    }

    // Positions is one entry per LISTING, not per distinct title.
    //
    // push() was used here too, and it drops a value the list already holds - so a company running
    // four separate "Software Engineer" listings reached the file as one position and read as though
    // it were hiring for one. Location and Remote/Onsite keep using push(), because those describe
    // the company and really are a set: "Central, Central, Central" is noise, three identical job
    // titles are three jobs.
    //
    // A listing whose title could not be read is still a listing, so it is marked rather than
    // dropped - the number of entries in the cell always equals the number of listings behind the row.
    function keep(list,value){
        list.push(value||"(untitled)");
    }

    // MCF never writes Onsite; there is only FWA, and "Flexi-Hours" is about working hours
    // rather than the work location -> leave it blank instead of guessing.
    function readMode(text){

        if(/hybrid/i.test(text)) return "Hybrid";
        if(/work[\s-]*from[\s-]*home|telecommut|remote/i.test(text)) return "Remote";

        return "";

    }

    //---------------------------------------------------
    // helper: filter matching
    //---------------------------------------------------

    function matches(value,allowed){

        if(!allowed.length) return true;

        const key=t=>(t||"").toLowerCase().replace(/[\s-]+/g,"");

        // the value could not be read while a filter is active -> reject
        if(!value) return false;

        return allowed.some(option=>key(option)===key(value));

    }

})();
