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
    const NEXT='nav[aria-label="pagination"] a[aria-label="Next"]';
    const NEXT_FALLBACK='nav[aria-label="pagination"] a[aria-label*="next" i]';

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

    const fetcher=core.makeFetcher(gate,{log:LOG});

    const fetchDoc=fetcher.fetchDoc;

    const jobs=[];
    const visited=new Set();

    const startedAt=performance.now();

    const report=core.makeReporter("stepstone-crawler-status",LOG);

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
        let wantDetails=true;
        let everyJob=false;

        try{

            const settings=await chrome.storage.local.get(["maxPages","concurrency","details","everyJob"]);

            maxPages=Math.max(0,+settings.maxPages||0);

            if(settings.concurrency) concurrency=Math.min(12,Math.max(1,+settings.concurrency));

            if(settings.details===false) wantDetails=false;
            if(settings.everyJob===true) everyJob=true;

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

                visited.add(job.id);
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

        const paging=await crawlAllPages(maxPages);

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
        //    By default one page per company (the newest listing); with "every job" on,
        //    every listing is opened: slower, but it collects each listing's location.
        //---------------------------------------------------

        const byKey=new Map(companies.map(company=>[company.key,company]));

        const targets=!wantDetails?[]
            :everyJob?jobs.filter(job=>job.jobUrl).map(job=>({url:job.jobUrl,key:job.key}))
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
            widths:[34,30,60,16,18,16],
            filename:"stepstone_companies.xlsx",
            log:LOG
        });

        const withTime=results.filter(r=>r["Recruitment time"]).length;
        const elapsed=Math.round((performance.now()-startedAt)/1000);

        const paging=state.paging||{pages:0,failed:0,recovered:0,reason:"end"};

        // "Done" on its own reads as "that was all of it", which is exactly wrong when StepStone
        // cut the walk short - the file then looks complete while half the list is missing.
        const problems=[
            rewound?`Rewound to page 1: the tab was on page ${rewound+1}, so pages 1-${rewound} `
                +"would otherwise have been skipped entirely.":"",
            paging.recovered?`${paging.recovered} page(s) were recovered on the second pass.`:"",
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
            +(problems.length?"\n\n"+problems.join("\n"):"")
            +(fetcher.describe()?`\nRequests: ${fetcher.describe()}`:"")
            +(state.crashed?`\n\nThe run stopped early: ${state.crashed}.`
                +"\nEverything collected before that point is in the file above.":"");

        report(summary);

        // the run reached the file, so there is nothing left to resume
        if(!state.crashed) checkpoint.clear();

        // let the download start before the alert blocks the page
        setTimeout(()=>alert(summary+"\nSaved as stepstone_companies.xlsx"),0);

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
    // Stops when: there is no Next left, the next page has no cards, Next points back to a
    // page already read, or the max pages limit is reached.
    //---------------------------------------------------

    async function crawlAllPages(maxPages){

        const limit=maxPages?Math.min(maxPages,HARD_PAGE_CAP):HARD_PAGE_CAP;

        // the open page is already rendered and costs no request, so read it whatever happens
        const first=collectFrom(document);

        report(`Open page: +${first.added} job(s), ${jobs.length} total`);

        const here=core.paramOf(location.href,"page",ORIGIN)||1;

        // The Next chain only ever goes FORWARD, so starting wherever the tab happens to sit
        // silently drops every earlier page - a tab left on page 5 lost 100 jobs and the summary
        // said nothing about them. Rewind to page 1 instead; the pages already in `visited` are
        // deduped on arrival, so the only cost is the requests, not the data.
        const start=here>1?pageUrl(1):nextUrl(document);

        rewound=here>1?here-1:0;

        if(rewound) report(`Tab was on page ${here} - rewinding to page 1 so pages 1-${rewound} are not lost...`);

        const walk=await core.walkPages({

            first:start,

            fetchDoc:(url,opts)=>fetchDoc(url,opts),

            onDoc:async (doc,url,page)=>{

                const found=collectFrom(doc);

                report(`Page ${page}: +${found.added} job(s), ${jobs.length} total`);

                await checkpoint.save({jobs});

                if(doc.querySelectorAll(CARD).length===0){
                    console.warn(LOG,"a page had no job cards - end of the list or a bot check");
                    return "stop";
                }

                return "";

            },

            nextOf:doc=>nextUrl(doc),

            // The next URL normally comes out of the page we just failed to read, so without this
            // one bad moment at page 27 of 60 threw away two thirds of the list. StepStone's
            // pagination is a plain ?page= counter, so the page after a missing one is knowable
            // without it.
            guessNext:url=>cleanUrl(core.bumpParam(url,"page",1,ORIGIN)),

            maxPages:limit,
            report,
            log:LOG

        });

        await checkpoint.save({jobs},true);

        return {
            pages:walk.pages+1,
            failed:walk.skipped,
            recovered:walk.recovered,
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

    function collectFrom(doc){

        const cards=doc.querySelectorAll(CARD);

        let added=0;

        cards.forEach(card=>{

            // id="job-item-13961958"
            const id=(card.getAttribute("id")||"").replace(/^job-item-/,"");

            if(!id||visited.has(id)) return;

            visited.add(id);

            jobs.push(readCard(card,id));

            added++;

        });

        return {cards:cards.length,added};

    }

    function readCard(card,id){

        const logo=card.querySelector(LOGO_LINK);
        const title=card.querySelector(TITLE);
        const posted=readPosted(card);

        const companyUrl=logo?cleanUrl(new URL(logo.getAttribute("href"),ORIGIN).toString()):"";

        return {
            id,
            title:norm(title),
            company:pick(card,COMPANY),
            location:pick(card,LOCATION),
            workFromHome:pick(card,WFH),
            postedText:posted.text,
            postedAt:posted.at,
            companyUrl,
            employerId:employerId(companyUrl),
            jobUrl:title?cleanUrl(new URL(title.getAttribute("href"),ORIGIN).toString()):""
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

        for(const job of list){

            const name=job.company||"(unknown)";

            // group by company id; without an id, fall back to the normalized name
            const key=job.employerId?"id:"+job.employerId:"name:"+name.toLowerCase();

            job.key=key;

            let company=map.get(key);

            if(!company){

                company={
                    key,
                    name,
                    employerId:job.employerId,
                    jobs:0,
                    locations:[],
                    positions:[],
                    modes:[],
                    posted:"",
                    postedAt:0,
                    companyUrl:job.companyUrl,
                    jobUrl:job.jobUrl,
                    employees:""
                };

                map.set(key,company);

            }

            company.jobs++;

            push(company.positions,job.title);
            push(company.locations,job.location);
            push(company.modes,readMode(job.workFromHome,job.location));

            // the newest listing, and its URL as the detail page to open
            if(job.postedAt>company.postedAt){
                company.postedAt=job.postedAt;
                company.posted=job.postedText;
                if(job.jobUrl) company.jobUrl=job.jobUrl;
            }

            if(!company.companyUrl&&job.companyUrl) company.companyUrl=job.companyUrl;
            if(!company.jobUrl&&job.jobUrl) company.jobUrl=job.jobUrl;

        }

        // most listings first, then alphabetically on a tie
        return [...map.values()].sort((a,b)=>b.jobs-a.jobs||a.name.localeCompare(b.name));

    }

    function push(list,value){
        if(value&&!list.includes(value)) list.push(value);
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

        return {
            company:pick(doc,DETAIL_COMPANY),
            location:pick(doc,DETAIL_LOCATION),
            workType:pick(doc,DETAIL_WORK_TYPE),
            posted:pick(doc,DETAIL_DATE).replace(PUBLISHED,""),
            employees:readSize(doc),
            companyUrl,
            employerId:employerId(companyUrl)
        };

    }

    // merge the detail page data into the company without overwriting what is already there
    function applyDetail(company,detail){

        if(!company.employees&&detail.employees) company.employees=detail.employees;

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

            if(match) return match[0].trim();

        }

        // blocks with an explicit label: "Mitarbeiter" + "1.001-5.000"
        for(const el of doc.querySelectorAll("[data-at],[data-testid],li,dd,dt")){

            const parts=blocks(el);

            for(let i=0;i+1<parts.length;i++){

                if(SIZE_LABEL.test(parts[i])&&parts[i+1]) return parts[i+1];

            }

        }

        const text=norm(doc.body);

        const found=text.match(SIZE_RANGE)||text.match(SIZE_OPEN)||text.match(SIZE_TEXT);

        return found?found[0].trim():"";

    }

    //---------------------------------------------------
    // helper: URL of the next page
    //---------------------------------------------------

    function nextUrl(doc){

        const link=doc.querySelector(NEXT)||doc.querySelector(NEXT_FALLBACK);

        const href=link&&link.getAttribute("href");

        return href?cleanUrl(new URL(href,ORIGIN).toString()):"";

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
