(async()=>{

    const LOG="[ctgj-crawler]";

    //---------------------------------------------------
    // guard against double runs when the button is clicked repeatedly
    //---------------------------------------------------

    if(window.__ctgjCrawlerRunning){
        alert("Crawler is already running on this tab. Wait for it to finish.");
        return;
    }

    window.__ctgjCrawlerRunning=true;

    const core=window.CrawlerCore;

    if(!core){

        alert("core.js is not loaded in this tab. popup.js must inject core.js before content.js.");

        window.__ctgjCrawlerRunning=false;

        return;

    }

    // Upper bound on the settle wait after a page turn, not a flat sleep any more.
    const DELAY=800;

    // These waits run hundreds of times, so the polling interval is itself part of the
    // runtime: every poll costs half its interval on average. 50ms is free and turns ~60ms
    // of dead time per wait into ~25ms.
    const POLL=50;

    // How long to wait for the app to render a page after the paginator is clicked.
    // Declared up here with the other constants on purpose: gotoNextPage runs while the try
    // block below is still executing, so a const sitting next to that function at the end of
    // the file is still in its temporal dead zone and throws on first use.
    const PAGE_TIMEOUT=15000;

    // How long to wait for the results panel to swap to the listing that was just clicked.
    // Kept tight: this is paid once per company, so a generous timeout on a panel that is
    // never going to load costs minutes across a full run.
    const PANEL_TIMEOUT=4000;

    // where the time actually goes, printed in the summary
    const timing={panelLoads:0,panelMs:0,panelTimeouts:0};

    // "6d ago" / "20h ago" / "Posted on 2h ago"
    const POSTED=/(\d+)\s*(mo|[mhdwy])\s*ago/i;

    const UNIT={m:1,h:60,d:1440,w:10080,mo:43200,y:525600};

    // how many times a page turn that did not take is worth trying again before the walk stops.
    // Giving up on the first one ended the crawl at whatever page it happened to be on and threw
    // away every page behind it - on a 37 page search that is most of the result set.
    const PAGE_TRIES=3;

    const startedAt=performance.now();

    // kept outside the try: collectFrom/push are helpers at the end of the file and cannot see block-scoped declarations
    const jobs=[];
    const visited=new Set();

    // company key -> "Remote" | "Hybrid" | "Onsite", filled in while paginating.
    // An empty string means "already tried, panel gave nothing" so it is not retried.
    const modelByCompany=new Map();

    const sleep=core.sleep;
    const norm=core.norm;
    const pick=core.pick;

    const report=core.makeReporter("ctgj-crawler-status",LOG);

    //---------------------------------------------------
    // what to do when the paginator stops turning
    //
    // This crawler drives the live tab and never makes an HTTP request, which is why it shipped
    // without a background worker. It still meets the same wall every other crawler here does: a
    // long walk gets some way in - page 28 of 40 in the run this was written for - and then the
    // app's own page request starts coming back 405. Nothing on screen changes, so clickPager
    // waits out its 15 seconds, the retries turn the same refusal into ?page=30, and the walk used
    // to stop there and write a file missing a third of the search.
    //
    // A 405 on the app's client-side page request is answered by the same thing a 403 is: opening
    // the URL as a REAL top-level navigation, which carries the cookies, the TLS fingerprint and
    // the JavaScript the edge is looking for. tabs.js opens that tab in the background, waits for
    // the app to render, lifts the finished DOM out, and closes the tab again - so the rest of the
    // pages are read without the user losing their window.
    //
    // A fetch() could never stand in for this: jobs.ctgoodjobs.hk renders its list client side, so
    // ?page=29 over HTTP is an empty shell with no .job-card in it. A tab is a real browser and
    // renders it for real, which is the whole reason this path is worth the seconds it costs.
    //---------------------------------------------------

    const tabs=core.makeTabFallback({
        log:LOG,
        report,
        describe:url=>"page "+(core.paramOf(url,"page",location.origin)||1)
    });

    // The tab navigating away kills the content script outright - no catch block runs and nothing
    // is written. The checkpoint turns that from "the whole run is gone" into "the next run starts
    // where this one stopped", which matters here more than anywhere else: this crawler drives the
    // live tab, so a stray click by the user can end a 37 page walk.
    const checkpoint=core.makeCheckpoint("ctgjCheckpoint",{log:LOG});

    // set the moment the file is handed to the browser, so the crash path can never write a second one
    let fileWritten=false;

    let resumed=0;
    let pageRetries=0;

    // pages the live tab would not turn to and that were reopened in a background tab instead.
    // Out here with the others: finish() sits outside the try block and cannot see anything
    // declared inside it.
    let tabPages=0;

    // read from the popup below, but declared out here: finish() sits outside the try block and
    // cannot see anything declared inside it
    let readModelEnabled=true;

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

        try{

            const settings=await chrome.storage.local.get(["maxPages","readModel"]);

            maxPages=+settings.maxPages||0;

            // default on: leaving it off silently ships an empty Remote/Onsite column
            readModelEnabled=settings.readModel!==false;

        }
        catch(e){
            console.warn(LOG,"could not read settings, exporting everything",e);
        }

        //---------------------------------------------------
        // 1b. pick up an unfinished run on the same search
        //---------------------------------------------------

        const saved=await checkpoint.load();

        if(saved&&Array.isArray(saved.jobs)&&saved.jobs.length){

            for(const job of saved.jobs){

                const id=job&&job["Job ID"];

                if(!id||visited.has(id)) continue;

                visited.add(id);
                jobs.push(job);
                resumed++;

            }

            // the work models cost a panel load each, which is the slowest part of the run
            for(const [key,model] of saved.models||[]) modelByCompany.set(key,model);

            report(`Resumed ${resumed} job(s) from an unfinished run on this search.`);

        }

        //---------------------------------------------------
        // 2. collect jobs across every page
        //---------------------------------------------------

        let paging=readPagination();

        // Rewind before counting anything: starting the run wherever the tab was left drops
        // every earlier page without a word.
        if(paging.current>1){

            report(`Tab is on page ${paging.current} - returning to page 1 first...`);

            if(await gotoFirstPage()) paging=readPagination();
            else console.warn(LOG,`could not return to page 1 - pages 1-${paging.current-1} will be missing`);

        }

        const startPage=paging.current;

        const lastPage=maxPages?Math.min(paging.last,paging.current+maxPages-1):paging.last;

        console.log(LOG,`pagination: current=${paging.current}, last=${paging.last} `
            +`(${paging.totalJobs} jobs), crawling up to page ${lastPage}`);

        // Ask now, while nothing is on fire. The fallback is only needed deep into a walk, and a
        // worker that turns out to be unreachable at page 29 has already cost the run the twenty
        // minutes it took to get there.
        if(await tabs.ready()) console.log(LOG,"tab fallback is ready");

        let pageErrors=0;
        let emptyStreak=0;

        // Once a page has had to be read in a background tab, the LIVE tab is still parked on the
        // page before it and its "next" link no longer points where the walk is. Every page from
        // there on is read the same way rather than clicking a paginator that is out of step.
        let viaTab=false;

        // Pages are turned in the LIVE TAB, not fetched.
        //
        // jobs.ctgoodjobs.hk is a Next.js app that renders the list client side: requesting
        // ?page=2 over HTTP returns 200 with an empty shell, no .job-card in it at all. The
        // old fetch loop therefore saw zero cards on pages 2 and 3, hit the emptyStreak guard
        // and stopped - which is exactly why a search of 1,089 jobs came back with the 30 that
        // happened to be rendered on page 1. Clicking the paginator lets the app render each
        // page for real, and collectFrom then reads the same DOM the user sees.
        //
        // The one exception is readPageInTab, and it is not a fetch: it opens the URL in a real
        // background tab, where the app boots and renders exactly as it does here. That is the
        // only thing that gets past a page the paginator refuses to turn.
        window.addEventListener("beforeunload",()=>{
            console.error(LOG,"the tab is navigating away - the crawl cannot survive a full page load."
                +" Collected so far: "+jobs.length+" job(s).");
        });

        for(let page=paging.current;page<=lastPage;page++){

            if(page>paging.current&&!viaTab){

                // A page turn that did not take is usually the app still rendering, not the end
                // of the list. Giving up on the first attempt cost every page behind it, so try
                // again - each attempt waits longer, and the paginator is re-read each time in
                // case the button moved.
                let turned=false;

                for(let attempt=1;attempt<=PAGE_TRIES&&!turned;attempt++){

                    if(attempt>1){

                        pageRetries++;

                        report(`Page ${page} did not render - retry ${attempt-1}/${PAGE_TRIES-1}...`);

                        await sleep(1000*attempt);

                    }

                    turned=await gotoNextPage(page);

                }

                // The paginator is not coming back. Past this point the app answers its own page
                // request with 405 and simply leaves the previous list on screen, which is a
                // refusal rather than the end of the results - so hand the rest of the walk to the
                // tab fallback instead of stopping here with most of the search unread.
                if(!turned){

                    pageErrors++;

                    console.warn(LOG,`could not reach page ${page} after ${PAGE_TRIES} tries `
                        +"- reopening it, and everything after it, in a background tab");

                    viaTab=true;

                }

            }

            const found=viaTab?await readPageInTab(paging.pageUrl(page)):collectFrom(document);

            // the tab could not be opened or read either: this really is as far as the run goes
            if(!found){

                pageErrors++;

                console.warn(LOG,`page ${page} could not be read in a tab either, `
                    +`stopping with ${jobs.length} job(s)`);

                report(`Page ${page} could not be reached in this tab or a new one - stopping with `
                    +`${jobs.length} job(s).`);

                break;

            }

            if(viaTab) tabPages++;

            // Must happen while this page is still on screen - the cards are gone once the
            // paginator moves on. A page read in a background tab has no results panel to click:
            // the tab is opened, read and closed again, so those pages contribute no work model.
            const models=(readModelEnabled&&!viaTab)?await readModelsOnPage():0;

            report(`Page ${page}/${lastPage}: ${found.cards} cards, +${found.added} -> ${jobs.length} jobs`
                +(readModelEnabled&&!viaTab?`, +${models} work models`:"")
                +(viaTab?" (read in a background tab)":""));

            // written after every page: the walk drives the live tab, so anything that navigates
            // it kills the script outright and no catch block ever runs
            await checkpoint.save({jobs,models:[...modelByCompany]});

            if(found.cards===0){

                emptyStreak++;

                if(emptyStreak>=2){
                    console.warn(LOG,"2 pages in a row rendered no job cards - stopping pagination.");
                    break;
                }

            }
            else{
                emptyStreak=0;
            }

        }

        await checkpoint.save({jobs,models:[...modelByCompany]},true);

        console.log(LOG,"jobs found:",jobs.length);

        if(jobs.length===0){

            alert("No jobs found. Open a jobs.ctgoodjobs.hk search results page and run again.");
            return;

        }

        //---------------------------------------------------
        // 3. filter
        //---------------------------------------------------

        const matched=jobs;

        const companies=buildCompanies(matched);

        console.log(LOG,`${matched.length} job(s) from ${companies.length} company(ies)`);

        //---------------------------------------------------
        // 4. Attach the work model gathered while paginating.
        //
        // This used to fetch /job/... and /company-jobs/... over HTTP. That can never work
        // here: the server answers those routes with 405 Method Not Allowed for a plain GET,
        // and even when it does answer, the page is a client-rendered shell with none of the
        // fields in it. Roughly a thousand requests, a thousand errors, nothing gained.
        //
        // The work model is instead read from the results panel during pagination - see
        // readModelsOnPage. Employees has no source at all on this site: it is on neither the
        // card, the results panel, nor anything reachable, so the column stays blank.
        //---------------------------------------------------


        let withModel=0;

        companies.forEach(company=>{

            const model=modelByCompany.get(companyKey({Company:company.name}));

            if(model){
                push(company.modes,model);
                withModel++;
            }

        });

        //---------------------------------------------------
        // 5. export to excel + trigger the download
        //---------------------------------------------------

        finish({companies,matched,withModel,paging,startPage,pageErrors,crashed:null});

    }
    catch(e){

        console.error(LOG,"crawl aborted:",e);

        // Everything collected up to the crash is real data. Throwing it away because the last
        // step failed is the single most expensive thing this crawler used to do.
        salvage(e);

    }
    finally{

        window.__ctgjCrawlerRunning=false;

    }

    //---------------------------------------------------
    // helper: write the file
    //---------------------------------------------------

    function finish(state){

        // the crash path calls this too, and an exception raised INSIDE it would come back round
        // and download a second copy of the same file
        if(fileWritten) return;

        fileWritten=true;

        const companies=state.companies;
        const matched=state.matched;
        const withModel=state.withModel;
        const paging=state.paging||{totalJobs:0,last:0};
        const startPage=state.startPage||1;
        const pageErrors=state.pageErrors||0;

        // fixed header: companies with missing data must still keep all 6 columns
        const HEADERS=["Company Name","Location","Positions","Recruitment time","Employees","Remote/Onsite"];

        const results=companies.map(company=>({
            "Company Name":company.name,
            "Location":company.locations.join(", "),
            "Positions":company.positions.join(" | "),
            "Recruitment time":company.posted,
            "Employees":company.employees,
            "Remote/Onsite":company.modes.join(", ")
        }));

        const written=core.exportXlsx(results,{
            headers:HEADERS,
            widths:[34,26,60,16,20,18],
            filename:"ctgoodjobs_companies.xlsx",
            log:LOG
        });

        const withTime=results.filter(r=>r["Recruitment time"]).length;
        const elapsed=Math.round((performance.now()-startedAt)/1000);

        // The site renders everything client side, so a fetched company/job page is a shell:
        // the request succeeds and the field is simply absent. Zero found with zero errors is
        // that case, and saying so beats leaving two empty columns unexplained.
        // Employees has no source on CTgoodjobs: not on the card, not in the results panel,
        // and the company page answers a plain GET with 405. Say so instead of leaving a
        // blank column looking like a bug.
        const notes=["\nEmployees is always blank: CTgoodjobs does not publish headcount anywhere reachable."];

        if(!readModelEnabled) notes.push("Remote/Onsite is blank because \"Read Remote/Onsite\" is unticked in the popup.");
        else if(withModel===0&&companies.length>0) notes.push("Remote/Onsite came back empty - the results panel never rendered a work model.");

        // Where the time went. Panel loads dominate the run, so make the cost per load and
        // the share lost to timeouts visible instead of leaving "it is slow" to guesswork.
        if(timing.panelLoads){

            notes.push(`Panel: ${timing.panelLoads} loads, ${Math.round(timing.panelMs/timing.panelLoads)}ms avg,`
                +` ${Math.round(timing.panelMs/1000)}s total`
                +(timing.panelTimeouts?`, ${timing.panelTimeouts} timed out (${Math.round(timing.panelTimeouts*PANEL_TIMEOUT/1000)}s wasted)`:""));

        }

        // Say the gap out loud. "1029 jobs" reads like a complete run until it is put next to
        // the 1,089 the site advertises.
        const gap=paging.totalJobs?paging.totalJobs-matched.length:0;

        const coverage=paging.totalJobs
            ? ` of ${paging.totalJobs} on the platform`+(gap>0?` - ${gap} MISSING`:gap<0?` (+${-gap} extra)`:" - complete")
            : "";

        const started=startPage>1
            ? `\nWARNING: the crawl started on page ${startPage}, so pages 1-${startPage-1} were never read.`
            : "";

        if(pageRetries) notes.push(`${pageRetries} page turn(s) had to be retried before the app rendered them.`);

        // Say it plainly: those pages are in the file, but their companies carry no work model,
        // and a blank column that has a reason is not the same as one that is a bug.
        if(tabPages){

            notes.push(`${tabPages} page(s) would not turn in this tab and were reopened in a `
                +"background tab instead - their companies have no Remote/Onsite, because that is "
                +"only readable from the results panel in the live tab.");

        }

        if(tabs.describe()) notes.push(tabs.describe());

        if(resumed) notes.push(`Resumed ${resumed} job(s) from an earlier unfinished run.`);

        if(written.clipped) notes.push(`${written.clipped} cell(s) truncated to fit Excel's 32,767 character limit.`);

        if(state.crashed){
            notes.push(`\nThe run stopped early: ${state.crashed}.`
                +"\nEverything collected before that point is in the file above.");
        }

        const summary=`Done in ${elapsed}s: ${results.length} companies from ${matched.length} jobs${coverage}`
            +` (pages ${startPage}-${paging.last}), ${withModel}/${companies.length} with work model, `
            +`${withTime} with recruitment time, ${pageErrors} page errors.`
            +started+notes.join("\n");

        report(summary);

        // the run reached the file, so there is nothing left to resume
        if(!state.crashed) checkpoint.clear();

        // let the download start before the alert blocks the page
        setTimeout(()=>alert(summary+"\nSaved as ctgoodjobs_companies.xlsx"),0);

    }

    // build the file out of whatever survived the crash
    function salvage(error){

        try{

            if(jobs.length===0){
                alert("Crawl failed before anything was collected: "+(error&&error.message||error));
                return;
            }

            const companies=buildCompanies(jobs);

            let withModel=0;

            companies.forEach(company=>{

                const model=modelByCompany.get(companyKey({Company:company.name}));

                if(model){
                    push(company.modes,model);
                    withModel++;
                }

            });

            finish({
                companies,
                matched:jobs,
                withModel,
                paging:null,
                startPage:1,
                pageErrors:0,
                crashed:(error&&error.message||String(error))
            });

        }
        catch(e){

            console.error(LOG,"could not salvage the run either:",e);

            alert("Crawl failed: "+(error&&error.message||error)+"\nOpen DevTools console for details.");

        }

    }

    //---------------------------------------------------
    // helper: collect jobs from one page (live DOM or an already parsed document)
    //---------------------------------------------------

    function collectFrom(root){

        const cards=root.querySelectorAll(".job-card[data-job-id]");

        let added=0;

        cards.forEach(card=>{

            const id=card.getAttribute("data-job-id");

            // Promoted listings can repeat inside the normal list -> dedupe by id
            if(!id||visited.has(id)) return;

            visited.add(id);

            jobs.push(readCard(card,id));

            added++;

        });

        if(cards.length===0){
            console.warn(LOG,"no .job-card on this page");
        }

        return {cards:cards.length,added};

    }

    //---------------------------------------------------
    // helper: read one card
    // <div class="row jc-info"><div class="col-12">location</div></div>
    // <div class="row jc-info"><div class="col-6">exp</div><div class="col-6">salary</div></div>
    //---------------------------------------------------

    function readCard(card,id){

        const cols=card.querySelectorAll(".jc-info .col-6");

        const experience=norm(cols[0]);
        const salary=readSalary(norm(cols[1]));

        // a.jc-position comes after a.ic_whatsapp_container with the same href -> select by class
        const title=card.querySelector("a.jc-position");
        const company=card.querySelector("a.jc-company");

        const highlights=[...card.querySelectorAll(".jc-highlight li")].map(norm).filter(Boolean);

        const companyHref=company?company.getAttribute("href")||"":"";

        // "6d ago" / "20h ago"
        const posted=pick(card,".jc-other div:not(.btn)");
        const age=posted.match(POSTED);

        return {
            postedText:posted,
            postedAge:age?+age[1]*UNIT[age[2].toLowerCase()]:Infinity,

            "Job ID":id,
            "Job Title":pick(card,"a.jc-position h2")||norm(title),
            "Company":norm(company),
            // /company-jobs/00013807/michael-page
            "Company ID":(companyHref.match(/\/company-jobs\/(\d+)\//)||[])[1]||"",
            "Location":pick(card,".jc-info .col-12"),
            "Experience":experience,
            "Exp Min (yrs)":readExperience(experience),
            "Salary Min":salary.min,
            "Salary Max":salary.max,
            "Posted":pick(card,".jc-other div:not(.btn)"),
            "Listing Type":pick(card,".jc-other .btn")||"Normal",
            "Highlights":highlights.join(" | "),
            "Job URL":title?title.getAttribute("href"):"",
            "Company URL":companyHref
        };

    }

    //---------------------------------------------------
    // helper: deduplicated company list
    // One company posts many listings, so a repeated Company column in the Jobs sheet is expected;
    // this sheet groups by normalized company name and counts the listings.
    //---------------------------------------------------

    // "ACME Ltd", "ACME Ltd." and "ACME  Limited" are one employer and used to become three rows,
    // each holding a slice of the positions. core.nameKey folds case, punctuation, whitespace and
    // a closed list of legal-form suffixes - and nothing else, so distinct employers stay apart.
    function nameKey(name){
        return core.nameKey(name);
    }

    function companyKey(row){
        return nameKey(row["Company"]);
    }

    // The panel's Apply button carries the id of the listing it is currently showing
    function panelJobId(){

        const apply=document.querySelector('.jd__action-btns a[href*="job_id="]');
        const m=apply?(apply.getAttribute("href")||"").match(/job_id=(\d+)/):null;

        return m?m[1]:"";

    }

    async function waitFor(test,timeout){

        const deadline=performance.now()+timeout;

        for(;;){

            if(test()) return true;

            if(performance.now()>deadline) return false;

            await sleep(POLL);

        }

    }

    async function waitForPanel(id){

        const started=performance.now();

        const ok=await waitFor(()=>panelJobId()===id,PANEL_TIMEOUT);

        timing.panelLoads++;
        timing.panelMs+=performance.now()-started;

        if(!ok){
            timing.panelTimeouts++;
            console.warn(LOG,"results panel did not load job",id);
        }

        return ok;

    }

    // The old code slept a flat 800ms after every page turn - 30 seconds across 37 pages,
    // nearly all of it spent waiting for cards that had already arrived. Watch the count
    // instead and carry on the moment it stops growing.
    async function waitForStableCards(){

        let last=-1;

        const deadline=performance.now()+DELAY;

        for(;;){

            const count=document.querySelectorAll(".job-card[data-job-id]").length;

            if(count>0&&count===last) return;

            last=count;

            if(performance.now()>deadline) return;

            await sleep(POLL);

        }

    }

    // Read the work model straight out of the results panel.
    // Clicking a card makes the app render that listing on the right, "More Information"
    // table included, so no request is involved - which matters, because every /job/ URL
    // answers a plain GET with 405.
    // One listing per company: the column is per company anyway, and clicking all 1,089
    // listings would cost several times the crawl itself.
    async function readModelsOnPage(){

        let read=0;

        for(const card of document.querySelectorAll(".job-card[data-job-id]")){

            const key=nameKey(norm(card.querySelector("a.jc-company")));

            if(!key||modelByCompany.has(key)) continue;

            // claim it before the await: a company whose panel never loads must not be
            // retried on every remaining page
            modelByCompany.set(key,"");

            const id=card.getAttribute("data-job-id");

            // The first card of a page is already open in the panel, so clicking it costs a
            // full reload for something that is on screen. One free read per page.
            if(panelJobId()!==id){

                card.click();

                if(!await waitForPanel(id)) continue;

            }

            const model=readMode(pick(document,"td.info__work-model"));

            if(model){
                modelByCompany.set(key,model);
                read++;
            }

        }

        return read;

    }

    // Reopen one search page as a real top-level navigation and read the cards out of it.
    //
    // The URL is passed in rather than derived here: `paging` is block-scoped inside the try above
    // and this function, like every helper at the end of the file, cannot see it.
    //
    // Returns null when the tab could not be opened, was refused as well, or the worker is not
    // there - the caller stops on that. A tab that renders but has no cards is NOT null: that is a
    // real answer ("this page is empty"), and the emptyStreak guard in the walk already knows what
    // to do with two of them in a row.
    async function readPageInTab(url){

        const doc=await tabs.fetchDoc(url);

        if(!doc){
            console.warn(LOG,"the background tab returned nothing for",url);
            return null;
        }

        return collectFrom(doc);

    }

    function buildCompanies(rows){

        const map=new Map();

        rows.forEach(row=>{

            const key=companyKey(row);

            if(!key) return;

            let company=map.get(key);

            if(!company){

                company={
                    name:row["Company"],
                    jobs:0,
                    locations:[],
                    positions:[],
                    modes:[],
                    posted:"",
                    postedAge:Infinity,
                    companyUrl:row["Company URL"],
                    jobUrl:row["Job URL"],
                    employees:""
                };

                map.set(key,company);

            }

            company.jobs++;

            push(company.positions,row["Job Title"]);

            // CTgoodjobs writes "-" when a listing declares no location
            if(row["Location"]!=="-") push(company.locations,row["Location"]);

            // the newest listing, and its URL as the one to read the Work Model from
            if(row.postedAge<company.postedAge){
                company.postedAge=row.postedAge;
                company.posted=row.postedText;
                company.jobUrl=row["Job URL"];
            }

        });

        // most listings first, then alphabetically on a tie
        return [...map.values()].sort((a,b)=>b.jobs-a.jobs||a.name.localeCompare(b.name));

    }

    function push(list,value){
        if(value&&!list.includes(value)) list.push(value);
    }

    //---------------------------------------------------
    // helper: the Work Model of a job page
    // <td class="info__work-model"><ul><li>On-site / At the workplace</li></ul></td>
    //---------------------------------------------------

    function readMode(text){

        if(/hybrid/i.test(text)) return "Hybrid";
        if(/remote|work\s*from\s*home|wfh/i.test(text)) return "Remote";
        if(/on-?\s?site|at the workplace|in office/i.test(text)) return "Onsite";

        return "";

    }

    // "25k – 35k" -> 25000 / 35000 ; "18k – 38k" -> 18000 / 38000
    function readSalary(text){

        const amounts=[];

        const re=/(\d+(?:\.\d+)?)\s*(k?)/gi;

        let m;

        while((m=re.exec((text||"").replace(/,/g,"")))!==null){
            amounts.push(Math.round(+m[1]*(m[2]?1000:1)));
        }

        if(amounts.length===0) return {min:"",max:""};

        return {
            min:Math.min(...amounts),
            max:Math.max(...amounts)
        };

    }

    // "3 - 5 yr(s)" -> 3 ; "0 yr(s)" -> 0 ; "-" -> ""
    function readExperience(text){

        const m=(text||"").match(/\d+/);

        return m?+m[0]:"";

    }

    //---------------------------------------------------
    // helper: read the pagination
    // <ul class="page-control">
    //   <a aria-current="page" aria-label="Go to page 1">1</a>
    //   <a aria-label="Go to page 2" href="...?page=2">2</a>
    //   <a aria-label="Go to last page (27)" href="...?page=27">
    // The last-page link is available, so there is no need to derive it from the total job count.
    //---------------------------------------------------

    function firstCardId(){

        const card=document.querySelector(".job-card[data-job-id]");

        return card?card.getAttribute("data-job-id"):"";

    }

    function pagerLink(label){

        const nav=document.querySelector("ul.page-control");

        if(!nav){
            console.warn(LOG,"no ul.page-control, cannot turn the page");
            return null;
        }

        const link=nav.querySelector(`a[aria-label^="${label}"]`);

        if(!link||link.classList.contains("disabled")||link.getAttribute("aria-disabled")==="true") return null;

        return link;

    }

    async function clickPager(link,expected){

        const before=firstCardId();

        link.click();

        // Both checks matter: the paginator highlights the new page slightly before the list
        // is replaced, so waiting on the number alone re-reads the old cards.
        const ok=await waitFor(()=>{

            const active=document.querySelector('ul.page-control a[aria-current="page"]');
            const id=firstCardId();

            return (active?+norm(active):0)===expected&&id&&id!==before;

        },PAGE_TIMEOUT);

        if(!ok){
            console.warn(LOG,`page ${expected} did not render within ${PAGE_TIMEOUT}ms`);
            return false;
        }

        // let the rest of the cards land behind the first one
        await waitForStableCards();

        return true;

    }

    // Click "next" and wait for the app to swap the list in.
    // The numbered links only cover a window of 5 pages, so walking forward one page at a
    // time is the only way to reach page 37.
    async function gotoNextPage(expected){

        const next=pagerLink("Go to next page");

        if(!next){
            console.log(LOG,"next page link is disabled - end of results");
            return false;
        }

        return clickPager(next,expected);

    }

    // The crawl loop only ever walks FORWARD, so whatever page the tab happens to sit on
    // becomes page one of the run and everything before it is silently dropped. That is not
    // hypothetical: a run that dies mid-pagination leaves the tab parked on the page it had
    // reached, and the next run then starts from there. Two aborted runs cost pages 1-2,
    // which is 60 of 1,089 jobs.
    async function gotoFirstPage(){

        const first=pagerLink("Go to first page");

        // the link is disabled on page 1, which is exactly where we want to be
        if(!first) return true;

        return clickPager(first,1);

    }

    function readPagination(){

        const here=new URL(location.href);

        let current=+here.searchParams.get("page")||1;
        let last=current;
        let template=here;

        const totalJobs=+norm(document.querySelector(".no-of-jobs")).replace(/[^\d]/g,"")||0;

        const nav=document.querySelector("ul.page-control");

        if(nav){

            const active=nav.querySelector('a[aria-current="page"]');

            if(active) current=+norm(active)||current;

            // numbered links always carry ?page= -> use one as the template and keep the URL filters
            nav.querySelectorAll("a[href][aria-label]").forEach(a=>{

                const href=a.getAttribute("href")||"";

                if(!/[?&]page=\d+/.test(href)) return;

                const page=+new URL(href,location.href).searchParams.get("page")||0;

                if(page>last) last=page;

                if(!template.searchParams.has("page")||template===here){
                    template=new URL(href,location.href);
                }

            });

            // "Go to last page (27)" states the last page number outright
            const lastLabel=nav.querySelector('a[aria-label^="Go to last page"]');

            if(lastLabel){

                const m=(lastLabel.getAttribute("aria-label")||"").match(/\((\d+)\)/);

                if(m&&+m[1]>last) last=+m[1];

            }

        }
        else{
            console.warn(LOG,"no pagination found, crawling the current page only");
        }

        return {
            current,
            last:Math.max(last,current),
            totalJobs,
            pageUrl(page){

                const url=new URL(template);

                url.searchParams.set("page",page);

                return url.toString();

            }
        };

    }

})();
