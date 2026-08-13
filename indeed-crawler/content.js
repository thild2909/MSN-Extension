(async()=>{

    const LOG="[indeed-crawler]";
    const ORIGIN=location.origin;

    // sg / au / hk / uk / my .indeed.com - same markup, only the domain and language differ
    const COUNTRY=(location.hostname.split(".")[0]||"").toLowerCase();
    const FILE="indeed_"+(/^[a-z]{2}$/.test(COUNTRY)?COUNTRY+"_":"")+"companies.csv";

    //---------------------------------------------------
    // guard against double runs when the button is clicked repeatedly
    //---------------------------------------------------

    if(window.__indeedCrawlerRunning){
        alert("Crawler is already running on this tab. Wait for it to finish.");
        return;
    }

    window.__indeedCrawlerRunning=true;

    const core=window.CrawlerCore;

    if(!core){

        alert("core.js is not loaded in this tab. popup.js must inject core.js before content.js.");

        window.__indeedCrawlerRunning=false;

        return;

    }

    // Indeed paginates through &start=, but the step is NOT fixed: it follows &limit= (10 on the
    // old build, 15 on the current one), so the pagination links are the only reliable source for
    // it. Computing start ourselves with a hardcoded step re-reads jobs we already have and runs
    // out of pages long before the result list ends.
    const HARD_PAGE_CAP=100;

    // sponsored cards legitimately repeat across pages; several all-duplicate pages in a row means
    // the pagination is looping and there is nothing new left to read
    const MAX_REPEAT_PAGES=3;

    // how many pages in a row may be stepped over before the list is treated as unreadable.
    // One miss is a busy moment; three in a row is Indeed refusing to serve the rest.
    const MAX_MISSES=3;

    // the second pass has already watched this page fail six times; a page that is still refusing
    // after three more is not coming back, and waiting out another full ladder for it costs more
    // than the page is worth
    const RECOVERY_TRIES=3;

    // a dropped connection is worth a few goes, but not the full block ladder: if the network is
    // actually down, six tries per page turns a stalled run into a very long stalled run
    const MAX_TRANSPORT_TRIES=3;
    const TRANSPORT_PAUSE=700;

    // card: <div class="cardOutline ... result job_<jk>">, containing .job_seen_beacon
    const CARD="div.cardOutline";
    const CARD_FALLBACK="div.job_seen_beacon";

    // Indeed rate limits per IP, so pacing one worker at a time is useless: the gate has to
    // sit in front of EVERY request. It does three things at once -
    //   1. at most `limit` requests in flight, and the limit shrinks while we are being blocked
    //   2. never two request STARTS closer together than `gap` (+ jitter, so the workers
    //      that were blocked together do not come back in lockstep)
    //   3. a 429/403/503 parks every worker until `pausedUntil`, not just the one that got it
    //
    // There is deliberately NO fixed per-request toll on top of this. A flat delay is paid on
    // every request whether or not Indeed minds, and at 900ms across 62 pages that was a minute
    // of waiting for nothing. The gap is the real control and it widens the moment anything is
    // refused - so run at full speed and let being rate limited, not the fear of it, slow us down.
    //
    // The floor the gap returns to once nothing is being refused - i.e. how fast a clean run goes.
    //
    // Zero, like every other crawler in this family, because the paragraph above was not true of
    // this file: 120ms WAS a fixed per-request toll, and it did not merely slow requests down, it
    // silently capped how many could be in flight. The gate spaces request STARTS by the gap, so
    // the most that can overlap is one page's load time divided by it - measured on 40 company
    // pages of 400ms each, "parallel 8" ran three at a time and finished in 8.5s, exactly as
    // "parallel 3" did. Everything above 3 in the popup was decoration.
    //
    // Nothing is given up by removing it. The first refusal still jumps the gap straight to
    // max(250, gap) * 1.7, the pool still narrows, and there is now a tab fallback behind both.
    // Being rate limited is what slows this crawler down, not the fear of it.
    const MIN_GAP=0;
    const MAX_GAP=8000;
    const MAX_COOLDOWN=30000;
    const MAX_ATTEMPTS=6;

    // Once we have sat out this much quiet time without a single page coming back, Indeed is not
    // rate limiting us any more - it has blocked the session, and every further request is wasted.
    const BLOCK_BUDGET=90000;

    // ...but while paginating, giving up costs the whole rest of the list rather than one column,
    // so the crawler sits out a lot more rate limiting before calling the session lost
    const PAGING_BUDGET=240000;

    // how many pages may be abandoned to blocks in a row before we stop asking for company size
    const BLOCK_LIMIT=3;

    //---------------------------------------------------
    // the sign-in wall
    //
    // Indeed serves page 1 of a search to anyone and answers every later page with a redirect to
    // secure.indeed.com carrying "branding=page-two-signin" - or, when the request looks like a
    // fetch rather than a click, with Cloudflare's 403 in front of it. Measured on sg, au, hk, uk
    // and de: page 1 is 200 and page 2 is the wall, from home and from ten datacentre exit IPs
    // alike. It is an account requirement, not a rate limit, so pacing, cooling off and changing
    // where the request comes from are all answers to a question nobody asked - the only thing
    // that clears it is being signed in to Indeed in this browser.
    //---------------------------------------------------

    const SIGNIN_HOST=/(^|\.)secure\.indeed\.com$/i;
    const SIGNIN_PATH=/page-two-signin|\/auth\b|\/account\/login/i;

    // `cleared` latches as soon as any paginated page comes back: from then on the crawler knows
    // for a fact that this session may read past page 1, so a later refusal is something else.
    const wall={hit:false,cleared:false,reason:""};

    function pagedUrl(url){
        return core.paramOf(url,"start",ORIGIN)>0;
    }

    function isSignIn(url){

        if(!url) return false;

        try{

            const parsed=new URL(url,ORIGIN);

            return SIGNIN_HOST.test(parsed.hostname)||SIGNIN_PATH.test(parsed.pathname+parsed.search);

        }
        catch(e){
            return false;
        }

    }

    // fetch follows the redirect, so the answer carries the address it ended up at
    function signInWall(response){
        return !!response&&isSignIn(response.url);
    }

    function hitWall(url,reason){

        if(wall.hit) return;

        wall.hit=true;
        wall.reason=reason;

        console.warn(LOG,"sign-in wall:",reason,url);

        report("Indeed only serves page 1 without an account - stopping pagination");

    }

    // Posting date, per root domain language:
    //   sg/au/uk/my "Posted 3 days ago", "Employer Active 30+ days ago", "Just posted"
    //   hk          "3 天前", "剛剛", "今天"
    //   de          "Vor 3 Tagen", "Gerade geschaltet", "Heute"  (the number comes AFTER "vor")
    const POSTED_EN="just posted|today|yesterday|\\d+\\s*\\+?\\s*(?:minute|min|hour|hr|day|week|month|year)s?\\s+ago";
    const POSTED_ZH="\\d+\\s*\\+?\\s*(?:分鐘|分钟|小時|小时|天|週|周|個月|个月|年)\\s*(?:之)?前|剛剛|刚刚|今天|昨天";
    const POSTED_DE="vor\\s+\\d+\\s*\\+?\\s*(?:Minuten|Minute|Stunden|Stunde|Tagen|Tage|Tag|Wochen|Woche|Monaten|Monate|Monat|Jahren|Jahre|Jahr)"
        +"|gerade geschaltet|heute|gestern";

    const POSTED=new RegExp("("+POSTED_EN+"|"+POSTED_ZH+"|"+POSTED_DE+")","i");

    const POSTED_UNIT=new RegExp("(\\d+)\\s*\\+?\\s*("
        +"minute|min|hour|hr|day|week|month|year"
        +"|分鐘|分钟|小時|小时|天|週|周|個月|个月|年"
        +"|Minuten|Minute|Stunden|Stunde|Tagen|Tage|Tag|Wochen|Woche|Monaten|Monate|Monat|Jahren|Jahre|Jahr"
        +")","i");

    const UNIT={
        minute:1,min:1,hour:60,hr:60,day:1440,week:10080,month:43200,year:525600,
        "分鐘":1,"分钟":1,"小時":60,"小时":60,"天":1440,"週":10080,"周":10080,
        "個月":43200,"个月":43200,"年":525600,
        minuten:1,stunde:60,stunden:60,tag:1440,tage:1440,tagen:1440,
        woche:10080,wochen:10080,monat:43200,monate:43200,monaten:43200,
        jahr:525600,jahre:525600,jahren:525600
    };

    const NOW_TEXT=/just posted|today|剛剛|刚刚|今天|gerade geschaltet|heute/i;
    const YESTERDAY_TEXT=/yesterday|昨天|gestern/i;

    // company page: a "Size" label + the value "51 to 200", or "51 to 200 employees"
    // de uses a dot as the thousands separator ("10.000"), so the number part must accept "." and ","
    const SIZE_LABEL=/^(?:size|company size|employees|number of employees|公司規模|公司规模|規模|规模|員工人數|员工人数|größe|grösse|unternehmensgröße|unternehmensgrösse|mitarbeiter|mitarbeiterzahl)$/i;

    // The unit word is REQUIRED here, unlike the label path. "51 to 200" on its own is only a
    // headcount because a "Size" label next to it says so; standing alone in an element it is
    // indistinguishable from a salary band ("3,000 - 5,000"), and this regex used to be run over
    // the whole page body, where it found exactly that.
    const SIZE_UNIT="(?:employees?|mitarbeiter\\w*|besch[äa]ftigte\\w*|名員工|名员工|員工人數|员工人数)";

    const SIZE_VALUE=new RegExp(
        "(?:(?:more than|over|mehr als)\\s*\\d[\\d.,]*"
        +"|\\d[\\d.,]*\\s*(?:to|bis|–|—|-)\\s*\\d[\\d.,]*"
        +"|\\d[\\d.,]*\\+)\\s*"+SIZE_UNIT,"i");

    // work-model chips on the card, separated from benefit chips (Health insurance, Stock options...)
    // The work model, in one place. readMode() and the chip filter used to carry their own copies
    // of this list, which is how "telearbeit" ended up in one of them and not the other.
    const HYBRID=/hybrid|混合/i;
    const REMOTE=/remote|work from home|遙距|遥距|遠端|远程|在家工作|homeoffice|home-office|telearbeit/i;

    // work-model chips on the card, separated from benefit chips (Health insurance, Stock options...)
    const MODE_CHIP=new RegExp(REMOTE.source+"|"+HYBRID.source,"i");

    const jobs=[];
    const visited=new Set();

    // Both fillPosted and collectFromJson want the page's embedded card JSON, and each call
    // re-scans every <script> and JSON.parses the better part of a megabyte. Once per document is
    // enough. Declared up here rather than next to jobCardsJson because page 1 is collected before
    // the bottom of this file is reached, and a `const` down there would still be in its temporal
    // dead zone by then.
    const cardsJson=new WeakMap();

    const CARDS_KEY='"mosaic-provider-jobcards"';

    // How far past the name the value may start. The two shapes Indeed ships are
    //   window.mosaic.providerData["mosaic-provider-jobcards"]={...}
    //   ..."mosaic-provider-jobcards":{...}
    // so the separator is a few characters away at most. Anything further along is a different
    // statement that merely mentions the name.
    const CARDS_LEAD=/^[\s\])]*[=:]\s*$/;
    const CARDS_LEAD_MAX=40;

    // the marker was on the page but nothing under it parsed - said once, because it means the
    // Recruitment time column will be empty and the reason is not visible anywhere else.
    //
    // These four live up here, not next to readCardsJson at the bottom of the file, for the same
    // reason cardsJson does: page 1 is collected from the `try` block above, long before the
    // bottom of this file is reached, and a `const` down there is still in its temporal dead zone.
    let cardsJsonWarned=false;

    // 403s Cloudflare labels as its own challenge, rather than Indeed refusing the request on its
    // merits. Backing off is the same either way, but it changes what the user should do about it.
    let challenges=0;

    const startedAt=performance.now();

    // A tab navigation kills the content script outright - no catch block runs and nothing is
    // written. The checkpoint turns that from "the whole run is gone" into "the next run starts
    // where this one stopped", which on a 62 page crawl is most of an hour.
    const checkpoint=core.makeCheckpoint("indeedCheckpoint",{log:LOG});

    // set the moment the file is handed to the browser, so the crash path can never write a second one
    let fileWritten=false;

    let resumed=0;

    const report=core.makeReporter("indeed-crawler-status",LOG);

    const norm=core.norm;
    const pick=core.pick;
    const blocks=core.blocks;

    //---------------------------------------------------
    // the engine
    //
    // This was a private copy of core.js's gate and fetcher, and it had drifted. Two things it had
    // stopped doing, both of which cost whole pages:
    //   * anything other than 429/503/403 was written off on the first answer, so a 502 - which is
    //     what Cloudflare returns when Indeed's origin has a moment - lost the page AND the link to
    //     every page behind it, three of those in a row ending the walk;
    //   * a body that stopped arriving mid-read threw straight out of loadPages, so a truncated
    //     response at page 30 of 60 ended the run instead of costing one retry.
    // Core handles both, plus the log throttling and the per-reason request stats the summary
    // prints, and a fix there now reaches this crawler like it reaches the other six.
    //
    // Indeed keeps two rules of its own, because neither belongs in a shared engine: the sign-in
    // wall, and "a paginated page is worth the full attempt ladder even while everything else is
    // being cut short".
    //---------------------------------------------------

    const gate=core.makeGate({
        minGap:MIN_GAP,
        maxGap:MAX_GAP,
        maxCooldown:MAX_COOLDOWN,
        limit:3,
        budget:BLOCK_BUDGET,
        log:LOG
    });

    const fetcher=core.makeFetcher(gate,{
        log:LOG,
        maxAttempts:MAX_ATTEMPTS,
        maxTransport:MAX_TRANSPORT_TRIES,
        transportPause:TRANSPORT_PAUSE,
        // Indeed answers 403 when it suspects a bot, and that one is worth another go
        retryForbidden:true,

        // Two refusals in a row are answered by a real navigation, not by the rest of the ladder -
        // but only while there is a tab left to open. See core.makeFetcher.
        canEscalate:()=>tabs.available,

        onRefused:(status,url,attempt,response)=>{

            // Cloudflare labels its own 403s. It is refusing the browser before Indeed ever looks
            // at the request, so it calls for a captcha solved by hand rather than a longer wait -
            // worth telling apart in the summary even though the backoff is the same. A paged URL
            // is excluded: those are refused to everyone, so a challenge on one says nothing
            // about this browser.
            if(status===403&&!pagedUrl(url)&&response.header("cf-mitigated")==="challenge"){

                challenges++;

                if(challenges<=3) console.warn(LOG,"Cloudflare challenge on",url);

            }

            report(gate.dead
                ?"Indeed has blocked this session - stopping"
                :`rate limited (gap ${Math.round(gate.gap)}ms, ${gate.limit} parallel)`);

        }
    });

    // what Indeed needs on top of the shared fetcher, worked out per request
    function settings(url,tries){

        return {

            // once Indeed has said the rest of the list needs an account, every further page
            // request gets the same answer
            guard:target=>wall.hit&&pagedUrl(target),

            // While things are degrading every URL gets two tries instead of six, so we find out
            // fast - except a paginated page, which is worth the full ladder even then: it carries
            // fifteen jobs and, until it comes back, no way of knowing where the next one starts.
            tries:tries||(gate.blocks>=3&&!pagedUrl(url)?2:MAX_ATTEMPTS),

            inspect:(response,target,attempt)=>{

                // fetch follows the redirect, so the answer carries the address it ended up at
                if(signInWall(response)){

                    hitWall(target,"redirected to the Indeed sign-in page");

                    return "stop";

                }

                // Handing a twice-refused page to a tab instead of finishing the ladder used to be
                // done here, with Indeed's own copy of the status list. It is core.makeFetcher's
                // `canEscalate` now, so every crawler does it the same way and there is one list.

                return "";

            },

            // a paginated page that came back is proof this session may read past page 1
            onOk:()=>{

                if(pagedUrl(url)) wall.cleared=true;

            }

        };

    }

    //---------------------------------------------------
    // the tab fallback
    //
    // The machinery is core.makeTabFallback - the same one every other crawler uses. Only the two
    // things that are Indeed's own live here: a tab sent to the sign-in page is the account wall
    // rather than a bot check, and a paged URL that a tab DID get is proof this session may read
    // past page 1.
    //
    // `askLimit:0` - this crawler never takes the window away from whoever is using the machine.
    // core.makeTabFallback otherwise brings a tab forward and waits for a person when a challenge
    // will not clear itself, which is right for a short run someone is watching; an Indeed run is
    // 80 tabs deep and unattended. The cost of that choice is real and is not hidden: a challenge
    // that does not clear on its own loses that page, and the summary says how many.
    //---------------------------------------------------

    const tabs=core.makeTabFallback({

        log:LOG,
        report,
        askLimit:0,
        lastStatus:fetcher.lastStatus,
        describe:url=>describeUrl(url),

        // an account is needed for this one, and a tab is signed in to the same account
        worthIt:url=>!(wall.hit&&pagedUrl(url)),

        inspect:(reply,url)=>{

            if(isSignIn(reply.url)){

                hitWall(url,"a real tab was sent to the sign-in page too");

                return "stop";

            }

            if(pagedUrl(url)) wall.cleared=true;

            return "";

        }

    });

    // enough of a url to recognise it in a status line, without the tracking query string
    function describeUrl(url){

        try{

            const parsed=new URL(url,ORIGIN);

            const start=parsed.searchParams.get("start");

            if(start) return "the page at start="+start;

            const cmp=parsed.pathname.match(/^\/cmp\/([^/]+)/);

            if(cmp) return decodeURIComponent(cmp[1]).replace(/-/g," ");

            const jk=parsed.searchParams.get("jk");

            return jk?"job "+jk:parsed.pathname;

        }
        catch(e){
            return url;
        }

    }

    // the cheap way first, then a real tab - see core.tabFirst
    const fetchDoc=(url,tries)=>core.tabFirst(fetcher,tabs,url,settings(url,tries));

    // Dedupe by URL: two companies can share one /cmp/ page ("Capgemini" and "Capgemini Sogeti"),
    // so it is read once and a page already in flight is shared. A FAILED result is evicted on
    // purpose - caching null meant a company whose page was refused during the busiest minute of
    // the run could never be read again, not even by the retry pass, and its size cell came out
    // blank, indistinguishable from a company that publishes no headcount at all.
    //
    // This cache sits ABOVE the fetcher's own, because a page a tab rescued has to be shared just
    // like a fetched one.
    const docCache=new Map();

    function fetchDocCached(url){

        if(docCache.has(url)) return docCache.get(url);

        const pending=fetchDoc(url).then(doc=>{

            if(!doc) docCache.delete(url);

            return doc;

        },e=>{

            docCache.delete(url);

            throw e;

        });

        docCache.set(url,pending);

        return pending;

    }

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
        let concurrency=3;
        // off unless the popup says otherwise: the /cmp/ lookup is one request per company and the
        // part of the run Indeed pushes back on hardest
        let wantEmployees=false;

        try{

            const settings=await chrome.storage.local.get(["maxPages","concurrency","employees"]);

            maxPages=+settings.maxPages||0;

            if(settings.concurrency) concurrency=Math.min(8,Math.max(1,+settings.concurrency));

            if(settings.employees===true) wantEmployees=true;

        }
        catch(e){
            console.warn(LOG,"could not read settings, using defaults",e);
        }

        // the setting is the ceiling, not a fixed width: the gate drops below it while blocked
        gate.maxLimit=concurrency;
        gate.limit=concurrency;

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
        // 2. page 1 comes straight from the open DOM (no request, no bot check),
        //    later pages are fetched through &start=
        //---------------------------------------------------

        const first=collectFrom(document);

        console.log(LOG,`page 1: ${first.cards} cards -> ${first.added} jobs`);

        if(jobs.length===0){

            alert("No job cards found. Open an sg.indeed.com search results page (/jobs?q=...) and run again.");
            return;

        }

        // Ask now, while nothing is on fire: pagination is where Indeed refuses hardest, and a
        // fallback that turns out to be unreachable at page 27 has already cost the run.
        if(await tabs.ready()) console.log(LOG,"tab fallback is ready");

        gate.spend(PAGING_BUDGET);

        const paging=await loadPages(maxPages);

        gate.spend(BLOCK_BUDGET);

        console.log(LOG,`${paging.pages} page(s) read`+(paging.stoppedEarly?" (stopped early)":""));

        //---------------------------------------------------
        // 3. group by company
        //---------------------------------------------------

        const companies=buildCompanies(jobs);

        console.log(LOG,`${jobs.length} jobs -> ${companies.length} companies`);

        //---------------------------------------------------
        // 4. Company size lives only on the /cmp/<slug> profile.
        //    Most cards link straight to it -> one request per company.
        //    Only the ones that do not go the long way round via the job page -> two.
        //---------------------------------------------------

        let failed=0;
        let processed=0;
        let withSize=0;
        let filledTime=0;

        let givenUp=false;

        // nothing left to try: the gate has written the fetches off AND the tab route is spent
        const outOfRoad=()=>!tabs.available&&(gate.dead||gate.deadEnds>=BLOCK_LIMIT);

        if(wantEmployees){

            await core.mapPool(companies,concurrency,async(company,index)=>{

                if(givenUp) return;

                company.failed=false;

                // The job page is only worth a request when the card gave us neither the /cmp/ link
                // nor a posting date. Skipping it halves the traffic, which is what actually keeps
                // Indeed from blocking - waiting longer between requests does not help once it has.
                if(!company.companyUrl||!company.posted){

                    const detail=company.jobUrl?await fetchDocCached(company.jobUrl):null;

                    if(!detail){
                        failed++;
                        company.failed=true;
                    }
                    else{

                        // Only read the date field/footer: scanning the whole page picks up "ago"
                        // from the description.
                        if(!company.posted){

                            const posted=readPosted(detail.querySelector('[data-testid="myJobsStateDate"]')
                                ||detail.querySelector(".jobsearch-JobMetadataFooter"));

                            if(posted.text){
                                company.posted=posted.text;
                                company.postedAge=posted.age;
                                filledTime++;
                            }

                        }

                        if(!company.companyUrl){

                            const link=detail.querySelector('a[href*="/cmp/"]');

                            if(link) company.companyUrl=cleanUrl(link.getAttribute("href"));
                            else if(index<3) console.warn(LOG,"no /cmp/ link on",company.jobUrl);

                        }

                    }

                }

                if(company.companyUrl&&!givenUp){

                    const profile=await fetchDocCached(company.companyUrl);

                    if(!profile){
                        failed++;
                        company.failed=true;
                    }
                    else{

                        company.failed=false;

                        const size=readSize(profile);

                        company.employees=size.text;
                        company.employeesSource=size.source;

                        if(company.employees) withSize++;
                        else if(index<3) console.warn(LOG,"no company size on",company.companyUrl);

                    }

                }

                // Once there is no route left at all - fetches written off AND the tab budget
                // spent - every further request is wasted and the run never ends. Stop the lookup
                // and export what we already have.
                if(outOfRoad()&&!givenUp){

                    givenUp=true;

                    console.warn(LOG,"no route left to Indeed - company size lookup stopped early");

                }

                if(!company.counted){
                    company.counted=true;
                    processed++;
                }

                report(`[${processed}/${companies.length}] ${company.name}`);

            },{
                log:LOG,
                // A company refused at the busiest moment of the run is usually readable once the
                // queue has drained and the gap has walked back down. Without this its size cell
                // stays blank, and a blank cell reads as "this company publishes no headcount".
                // Nothing is retried once there is no route left: every request is wasted then.
                shouldRetry:company=>company.failed===true&&!givenUp&&!wall.hit&&!outOfRoad(),
                onRetryPass:count=>report(`Retrying ${count} company page(s) that failed...`)
            });

        }

        //---------------------------------------------------
        // 5. export to excel + trigger the download
        //---------------------------------------------------

        finish({companies,paging,wantEmployees,withSize,filledTime,failed,processed,givenUp,crashed:null});

    }
    catch(e){

        console.error(LOG,"crawl aborted:",e);

        // Everything collected up to the crash is real data. On a 62 page Indeed run that is most
        // of an hour, and throwing it away because the last step failed was the single most
        // expensive thing this crawler did.
        salvage(e);

    }
    finally{

        window.__indeedCrawlerRunning=false;

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
        const paging=state.paging||{pages:0,recovered:0,skipped:0,reason:"end"};

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

        const written=core.exportCsv(results,{
            headers:HEADERS,
            filename:FILE,
            log:LOG
        });

        const withTime=results.filter(r=>r["Recruitment time"]).length;
        const elapsed=Math.round((performance.now()-startedAt)/1000);

        const summary=`Done in ${elapsed}s: ${results.length} companies from ${jobs.length} jobs `
            +`on ${location.hostname} over ${paging.pages} page(s), ${withTime} with recruitment time`
            +(state.filledTime?` (${state.filledTime} from the job page)`:"")
            +(state.wantEmployees?`, ${state.withSize} with company size`:", company size lookup off")
            +`, ${state.failed} request errors.`
            +(resumed?`\nResumed ${resumed} job(s) from an earlier unfinished run.`:"")
            +(paging.recovered?` ${paging.recovered} page(s) were recovered on a second pass.`:"")
            +(paging.skipped?` ${paging.skipped} page(s) could not be read at all.`:"")
            +(state.wantEmployees&&core.describeSizes(companies)
                ?`\n${core.describeSizes(companies)}`:"")
            +(tabs.describe()?"\n"+tabs.describe():"")
            +(tabs.off==="broken"?"\nThe tab fallback could not open tabs at all - reload the "
                +"extension from chrome://extensions and run again.":"")
            +(fetcher.describe()?`\nRequests: ${fetcher.describe()}`:"")
            +(written.clipped?`\n${written.clipped} cell(s) truncated to fit Excel's 32,767 character limit.`:"")
            +(fetcher.stats.netErrors?`\n\n${fetcher.stats.netErrors} connection(s) dropped before Indeed answered `
                +"(ERR_QUIC_PROTOCOL_ERROR and friends). Those are retried, but if there are many "
                +"of them the HTTP/3 path to Indeed is unstable: open chrome://flags, set "
                +"'Experimental QUIC protocol' to Disabled, restart Chrome and run again.":"")
            +PAGING_NOTE(paging)
            +(challenges?`\n\n${challenges} request(s) were answered with a Cloudflare challenge`
                +(tabs.ok?" - which is what the tab fallback above is for.":". Open Indeed in a "
                    +"normal tab, clear the check by hand, then run again."):"")
            +(wall.hit?"\n\nIndeed served page 1 only: everything after it is behind a sign-in "
                +`(${wall.reason}). This is an account requirement, not a rate limit, and waiting `
                +"does not clear it. Sign in to Indeed in this browser and run again to read the "
                +"rest of the pages.":"")
            +(state.givenUp?"\n\nIndeed blocked the session, so company size was only read for the first "
                +`${state.processed} of ${companies.length} companies. Everything else in the file is complete. `
                +"Wait a few minutes, or untick 'Company size' for a clean fast run.":"")
            +(state.crashed?`\n\nThe run stopped early: ${state.crashed}.`
                +"\nEverything collected before that point is in the file above.":"");

        report(summary);

        // the run reached the file, so there is nothing left to resume
        if(!state.crashed) checkpoint.clear();

        // let the download start before the alert blocks the page
        setTimeout(()=>alert(summary+"\nSaved as "+FILE),0);

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
                paging:null,
                wantEmployees:false,
                withSize:companies.filter(c=>c.employees).length,
                filledTime:0,
                failed:0,
                processed:0,
                givenUp:false,
                crashed:(error&&error.message||String(error))
            });

        }
        catch(e){

            console.error(LOG,"could not salvage the run either:",e);

            alert("Crawl failed: "+(error&&error.message||error)+"\nOpen DevTools console for details.");

        }

    }

    //---------------------------------------------------
    // helper: walk the following pages through &start=
    // Clicking "Next" reloads the whole page and kills the content script -> fetch instead.
    // Stops when: a fetched page has no cards left (out of jobs OR a bot check),
    // that page has no Next link, or the max pages limit is reached.
    //---------------------------------------------------

    async function loadPages(maxPages){

        // The gap between one page's start= and the next. Read from the pages themselves rather
        // than assumed, because it follows &limit= (10 on the old build, 15 on the current one).
        // Page 1 starts at 0, so page 2's start IS the stride - known before anything is read,
        // which is what lets even a miss on the very first page be stepped over.
        let step=0;
        let repeats=0;

        // walkPages calls every stop we ask for "empty"; this records which one it really was
        let stopped="";

        // page 1 was already read from the open DOM; ask it where page 2 lives
        const start=nextPageUrl(document,location.href);

        if(start) step=core.paramOf(start,"start",ORIGIN);

        const walk=await core.walkPages({

            first:start,

            // readPage, not fetcher.fetchDoc: a page Indeed refuses is reopened in a real tab
            // before it is written off, and while paginating that is the difference between
            // stopping at page 27 and reading all 62
            fetchDoc:(url,opts)=>fetchDoc(url,opts&&opts.tries),

            onDoc:async(doc,url,page)=>{

                const found=collectFrom(doc);

                // the recovery pass has no page number to give - it is re-reading one that was
                // stepped over, so say that rather than printing "Page 0"
                report(page
                    ?`Page ${page}: ${found.added} new job(s), ${jobs.length} total`
                    :`Recovered ${describeUrl(url)}: ${found.added} new job(s), ${jobs.length} total`);

                // written as we go: a tab navigation kills the content script outright, and
                // without this a 40 page walk that dies at page 39 leaves nothing at all behind
                await checkpoint.save({jobs});

                // 0 cards = the end of the list, or Indeed returned a bot-check page
                if(found.cards===0){
                    console.warn(LOG,"a page had no job cards - end of results or a bot check");
                    stopped="empty";
                    return "stop";
                }

                repeats=found.added?0:repeats+1;

                if(repeats>=MAX_REPEAT_PAGES){
                    console.warn(LOG,`${repeats} pages in a row held nothing new - stopping`);
                    stopped="repeat";
                    return "stop";
                }

                return "";

            },

            nextOf:(doc,url)=>{

                const next=nextPageUrl(doc,url);

                // learn the stride from two pages that really exist, so a later miss can be
                // stepped over without guessing
                if(next){

                    const gap=core.paramOf(next,"start",ORIGIN)-core.paramOf(url,"start",ORIGIN);

                    if(gap>0) step=gap;

                }

                return next;

            },

            // Losing one page must not lose every page behind it: the next url normally comes out
            // of the page we just failed to read. Once the wall is up there is nothing to step to.
            guessNext:url=>wall.hit?"":(step?core.bumpParam(url,"start",step,ORIGIN):""),

            maxPages:maxPages?Math.min(maxPages,HARD_PAGE_CAP):HARD_PAGE_CAP,
            maxMisses:MAX_MISSES,
            recoveryTries:RECOVERY_TRIES,
            report,
            log:LOG

        });

        await checkpoint.save({jobs},true);

        return {
            pages:walk.pages,
            skipped:walk.skipped,
            recovered:walk.recovered,
            stoppedEarly:walk.reason!=="end",
            reason:wall.hit?"wall":(stopped||walk.reason)
        };

    }

    // "Done" on its own reads as "that was all of it", which is exactly wrong when Indeed cut the
    // walk short - the file then looks complete while two thirds of the list is missing.
    function PAGING_NOTE(paging){

        if(paging.reason==="blocked"){
            return `\n\nIndeed stopped serving results at page ${paging.pages} - this is a rate `
                +"limit, not the end of the list. Wait a few minutes and run again, or lower "
                +"'parallel', to pick up the pages after it.";
        }

        if(paging.reason==="limit"){
            return `\n\nStopped at the ${paging.pages} page limit - there are more results. `
                +"Raise 'max pages' to read further.";
        }

        return "";

    }

    //---------------------------------------------------
    // helper: the URL of the page after `fromUrl`, taken from that page's own pagination.
    // Reading it instead of computing start+10 is what keeps a limit=15 search from being crawled
    // in overlapping 10-job windows, which loses the tail of the result list.
    //---------------------------------------------------

    function nextPageUrl(root,fromUrl){

        const next=root.querySelector('a[data-testid="pagination-page-next"][href]');

        if(next) return new URL(next.getAttribute("href"),ORIGIN).toString();

        // some builds render only the numbered links: take the lowest start still ahead of us
        const here=core.paramOf(fromUrl,"start",ORIGIN);

        let best="";
        let bestStart=Infinity;

        for(const link of root.querySelectorAll('a[data-testid^="pagination-page-"][href]')){

            const url=new URL(link.getAttribute("href"),ORIGIN);
            const start=+url.searchParams.get("start")||0;

            if(start>here&&start<bestStart){
                bestStart=start;
                best=url.toString();
            }

        }

        return best;

    }

    //---------------------------------------------------
    // helper: collect jobs from one page
    //---------------------------------------------------

    function collectFrom(root){

        const from=jobs.length;

        const dom=collectFromDom(root);

        // A page with no markup cards is not necessarily empty: some responses come back as the
        // React shell, with the cards only in the embedded provider JSON. Treating those as "end of
        // results" is what used to cut a run short halfway through the list.
        if(!dom.cards) return collectFromJson(root);

        fillPosted(root,from);

        // The two sources do not always agree. Indeed's markup drops cards it decided not to
        // render - a collapsed duplicate, a card the layout had no room for - while the provider
        // JSON still carries them, so reading only the DOM quietly loses a handful of jobs per
        // page. Running both and letting `visited` decide is the difference between "15 of the 15
        // it rendered" and "every job the page actually shipped".
        const json=collectFromJson(root);

        if(json.added){
            console.log(LOG,`${json.added} card(s) on this page existed only in the embedded JSON`);
        }

        return {cards:Math.max(dom.cards,json.cards),added:dom.added+json.added};

    }

    //---------------------------------------------------
    // helper: the posting date, from the provider JSON
    //
    // Indeed has taken the date out of the card markup - neither .date nor myJobsStateDate is
    // rendered any anymore, measured 16 cards on sg with 0 dates between them - but it still ships
    // in the page's own JSON as formattedRelativeTime, on every card. The cards themselves are
    // still read from the DOM, because that is where the /cmp/ link and the work-model chips live;
    // only the dates come from the JSON. Without this the Recruitment time column is empty for
    // every row, which is exactly what a 774-job run with 2 dates in it looks like.
    //---------------------------------------------------

    function fillPosted(root,from){

        const missing=jobs.slice(from).filter(job=>!job.postedText);

        if(!missing.length) return;

        const results=jobCardsJson(root);

        if(!results.length) return;

        const byId=new Map();

        for(const result of results){

            const id=result.jobkey||result.jobKey||"";

            if(id) byId.set(id,result);

        }

        let filled=0;

        for(const job of missing){

            const result=byId.get(job.id);

            if(!result) continue;

            const posted=readPostedText(result.formattedRelativeTime||result.pubDate||"");

            if(!posted.text) continue;

            job.postedText=posted.text;
            job.postedAge=posted.age;

            filled++;

        }

        if(filled) console.log(LOG,`filled ${filled}/${missing.length} posting date(s) from the page JSON`);

    }

    function collectFromDom(root){

        let cards=root.querySelectorAll(CARD);

        if(cards.length===0) cards=root.querySelectorAll(CARD_FALLBACK);

        let added=0;
        let noId=0;

        cards.forEach(card=>{

            // Indeed renders an extra hidden card for the detail pane on the right -> drop it
            if(card.getAttribute("aria-hidden")==="true") return;

            const id=cardJobId(card);

            if(!id){
                noId++;
                return;
            }

            if(visited.has(id)) return;

            visited.add(id);

            jobs.push(readCard(card,id));

            added++;

        });

        // A card with no readable jk is not lost: collectFromJson reads the same page's embedded
        // provider payload, where every card ships with its jobkey, and the two share `visited`. So
        // this is a warning about the markup rather than about the data - but if the JSON is also
        // unreadable on this build, this line is the only thing that will say where the jobs went.
        if(noId){
            console.warn(LOG,`${noId} of ${cards.length} card(s) had no job key in their markup - `
                +"those come from the page's embedded JSON instead");
        }

        return {cards:cards.length,added};

    }

    // The card's job key.
    //
    // data-jk on the title link is where it normally is. When a build stops rendering that
    // attribute the key is still in the ad's own href (?jk=... / /rc/clk?jk=...), and reading it
    // from there is what keeps the card and its JSON twin on ONE id: a synthetic id would pass
    // `visited` and add the same job a second time, which is the opposite of the problem being
    // fixed. If neither is there, collectFromJson still has the job - see the note above.
    function cardJobId(card){

        const link=card.querySelector("a[data-jk]");
        const attr=link&&link.getAttribute("data-jk");

        if(attr) return attr;

        for(const a of card.querySelectorAll("a[href]")){

            const match=/[?&]jk=([^&#]+)/.exec(a.getAttribute("href")||"");

            if(match){

                try{
                    return decodeURIComponent(match[1]);
                }
                catch(e){
                    return match[1];
                }

            }

        }

        return "";

    }

    //---------------------------------------------------
    // helper: the same cards, read from
    // window.mosaic.providerData["mosaic-provider-jobcards"] instead of the markup
    //---------------------------------------------------

    function collectFromJson(root){

        const results=jobCardsJson(root);

        let added=0;

        for(const result of results){

            const id=result.jobkey||result.jobKey||"";

            if(!id||visited.has(id)) continue;

            visited.add(id);

            const posted=readPostedText(result.formattedRelativeTime||result.pubDate||"");

            jobs.push({
                id,
                title:(result.displayTitle||result.title||"").replace(/\s+/g," ").trim(),
                company:(result.company||"").replace(/\s+/g," ").trim(),
                location:(result.formattedLocation||result.jobLocationCity||"").replace(/\s+/g," ").trim(),
                chips:readJsonChips(result),
                postedText:posted.text,
                postedAge:posted.age,
                jobUrl:ORIGIN+"/viewjob?jk="+encodeURIComponent(id),
                companyUrl:result.companyOverviewLink?cleanUrl(result.companyOverviewLink):""
            });

            added++;

        }

        return {cards:results.length,added};

    }

    function jobCardsJson(root){

        if(cardsJson.has(root)) return cardsJson.get(root);

        const results=readCardsJson(root);

        cardsJson.set(root,results);

        if(results.length) console.log(LOG,`read ${results.length} card(s) from the embedded JSON`);

        return results;

    }

    function readCardsJson(root){

        let sawKey=false;

        for(const script of root.querySelectorAll("script")){

            const text=script.textContent||"";

            // EVERY occurrence, not just the first. The name also appears in provider manifests
            // and config arrays earlier in the page; the old code locked onto the first one, took
            // the next "=" - which belonged to an unrelated statement - and handed JSON.parse a
            // JavaScript object literal with unquoted keys. That is the "Expected property name
            // at position 1" error, and it cost the page every posting date on it.
            for(let at=text.indexOf(CARDS_KEY);at>=0;at=text.indexOf(CARDS_KEY,at+CARDS_KEY.length)){

                sawKey=true;

                const results=cardsAt(text,at+CARDS_KEY.length);

                if(results) return results;

            }

        }

        if(sawKey&&!cardsJsonWarned){

            cardsJsonWarned=true;

            console.warn(LOG,"the embedded job card JSON is on the page but no longer in a shape "
                +"this can read - posting dates will be missing. The card markup is unaffected.");

        }

        return [];

    }

    // the model at `from`, or null if what is there is not one
    function cardsAt(text,from){

        const open=text.indexOf("{",from);

        if(open<0||open-from>CARDS_LEAD_MAX) return null;

        // only an assignment or a key may sit between the name and the brace
        if(!CARDS_LEAD.test(text.slice(from,open))) return null;

        const raw=balanced(text,open);

        if(!raw) return null;

        try{

            const data=JSON.parse(raw);
            const model=data&&data.metaData&&data.metaData.mosaicProviderJobCardsModel;

            return model&&Array.isArray(model.results)?model.results:null;

        }
        catch(e){

            // not the payload - another occurrence of the name may still be. Silent on purpose:
            // this is a candidate being rejected, not a failure, and warning per candidate is
            // what filled the console.
            return null;

        }

    }

    // the object literal is followed by the rest of the script, so cut it at its own closing brace,
    // ignoring braces that only appear inside strings
    function balanced(text,open){

        let depth=0;
        let inString=false;
        let escaped=false;

        for(let i=open;i<text.length;i++){

            const ch=text[i];

            if(inString){

                if(escaped) escaped=false;
                else if(ch==="\\") escaped=true;
                else if(ch==='"') inString=false;

                continue;

            }

            if(ch==='"') inString=true;
            else if(ch==="{") depth++;
            else if(ch==="}"&&--depth===0) return text.slice(open,i+1);

        }

        return "";

    }

    function readJsonChips(result){

        const out=[];

        const add=value=>{

            const text=(value||"").replace(/\s+/g," ").trim();

            if(text&&MODE_CHIP.test(text)&&!out.includes(text)) out.push(text);

        };

        for(const taxonomy of result.taxonomyAttributes||[]){
            for(const attribute of taxonomy.attributes||[]) add(attribute.label);
        }

        if(result.remoteWorkModel) add(result.remoteWorkModel.text||result.remoteWorkModel.type);

        return out;

    }

    //---------------------------------------------------
    // helper: read one card
    // Indeed hashes its class names per build (css-19eicqx) -> rely only on data-testid,
    // data-jk and the few classes that have been stable for years (jobTitle, jobMetaDataGroup).
    //---------------------------------------------------

    function readCard(card,id){

        const posted=readPosted(card.querySelector(".jobMetaDataGroup")||card);

        // the company name on the card is usually already a link to the /cmp/ profile.
        // When it is, the job page is pure overhead - that link is the only thing we wanted from it.
        const cmp=card.querySelector('[data-testid="company-name"] a[href*="/cmp/"], a[href*="/cmp/"]');

        return {
            id,
            title:readTitle(card),
            company:pick(card,'[data-testid="company-name"]'),
            location:pick(card,'[data-testid="text-location"]'),
            chips:readChips(card),
            postedText:posted.text,
            postedAge:posted.age,
            jobUrl:ORIGIN+"/viewjob?jk="+encodeURIComponent(id),
            companyUrl:cmp?cleanUrl(cmp.getAttribute("href")):""
        };

    }

    // <span title="Software Engineer">: prefer the attribute, fall back to the text
    function readTitle(card){

        const span=card.querySelector("h3.jobTitle span[title], a[data-jk] span[title]");

        if(span&&span.getAttribute("title")) return span.getAttribute("title").replace(/\s+/g," ").trim();

        return pick(card,"h3.jobTitle")||pick(card,"a[data-jk]");

    }

    // chips inside <ul class="metadataContainer">, keeping only the ones about the work location
    function readChips(card){

        const out=[];

        card.querySelectorAll(".metadataContainer li, .metadataContainer span").forEach(el=>{

            const text=norm(el);

            if(text&&MODE_CHIP.test(text)&&!out.includes(text)) out.push(text);

        });

        return out;

    }

    //---------------------------------------------------
    // helper: the posting date
    // "Posted<span>&nbsp;</span>3 days ago" -> textContent runs the words together, so
    // join per text node first and only then run the regex.
    //---------------------------------------------------

    function readPosted(root){

        if(!root) return {text:"",age:Infinity};

        const stamp=root.querySelector('[data-testid="myJobsStateDate"], .date');

        return readPostedText(blocks(stamp||root).join(" "));

    }

    function readPostedText(text){

        const match=(text||"").match(POSTED);

        if(!match) return {text:"",age:Infinity};

        return {text:match[1],age:postedAge(match[1])};

    }

    function postedAge(text){

        if(NOW_TEXT.test(text)) return 0;
        if(YESTERDAY_TEXT.test(text)) return 1440;

        const unit=text.match(POSTED_UNIT);

        return unit?+unit[1]*UNIT[unit[2].toLowerCase()]:Infinity;

    }

    //---------------------------------------------------
    // helper: group jobs by company
    //---------------------------------------------------

    function buildCompanies(list){

        const map=new Map();

        // "ACME Pte Ltd" and "ACME Pte. Ltd." are one employer and used to become two rows, each
        // holding a slice of the positions. core.nameKey folds case, punctuation and a closed list
        // of legal-form suffixes - and nothing else, so distinct employers ("Acme Tech" vs "Acme
        // Technologies") still stay apart.
        //
        // The /cmp/<slug> path is a better key than any spelling of the name, and it is the one
        // Indeed itself uses: the same employer's cards are written inconsistently ("DBS Bank" /
        // "DBS Bank Ltd" / "DBS") while every one of them links to /cmp/DBS-Bank. Only SOME cards
        // carry that link though - it is a property of the card, not the employer - which is why
        // this goes through core.companyKeys rather than being read per job: keyed one ad at a time
        // the linked ads went to "id:/cmp/DBS-Bank" and the rest to "name:dbs bank", i.e. two rows
        // for one company, which is the duplicate the folded name exists to prevent.
        const keyOf=core.companyKeys(list,job=>job.companyUrl,job=>job.company||"(unknown)");

        for(const job of list){

            const name=job.company||"(unknown)";

            const key=keyOf(job);

            let company=map.get(key);

            if(!company){

                company={
                    name,
                    jobs:0,
                    locations:[],
                    positions:[],
                    modes:[],
                    posted:"",
                    postedAge:Infinity,
                    jobUrl:job.jobUrl,
                    companyUrl:job.companyUrl||"",
                    employees:"",
                    // "label" | "near" | "" - see core.headcount
                    employeesSource:""
                };

                map.set(key,company);

            }

            company.jobs++;

            // any card that carried the /cmp/ link saves the whole company a job-page fetch
            if(!company.companyUrl&&job.companyUrl) company.companyUrl=job.companyUrl;

            keep(company.positions,job.title);
            push(company.locations,job.location);
            push(company.modes,readMode(job.location,job.chips));

            // the newest listing, and its URL as the one to read the company link from
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

    // Positions is one entry per AD, not per distinct title.
    //
    // push() was used here too, and it drops a value the list already holds - so a company running
    // four separate "Software Engineer" ads reached the file as one position and read as though it
    // were hiring for one. Location and Remote/Onsite keep using push(), because those describe the
    // company and really are a set: "Singapore, Singapore, Singapore" is noise, three identical job
    // titles are three jobs.
    //
    // An ad whose title could not be read is still an ad, so it is marked rather than dropped - the
    // number of entries in the cell always equals the number of ads behind the row.
    function keep(list,value){
        list.push(value||"(untitled)");
    }

    // The work location lives in the location field ("Remote", "Hybrid work in Singapore") or
    // in a "Work from home" chip. A city name alone means working there -> Onsite.
    // The title is deliberately NOT read: "Blockchain Engineer (Remote)" is not work-location data.
    function readMode(location,chips){

        const text=[location||""].concat(chips||[]).join(" ");

        if(!text.trim()) return "";

        // hybrid first: "hybrid work from home" contains both
        if(HYBRID.test(text)) return "Hybrid";
        if(REMOTE.test(text)) return "Remote";

        return "Onsite";

    }

    //---------------------------------------------------
    // helper: the headcount on the /cmp/<slug> page
    // "Size" + "51 to 200", or the sentence "51 to 200 employees"
    //---------------------------------------------------

    // Returns {text,source}. The "Size" label with the value in the next block is the reading
    // that can only be one thing; the fallback is a small element that IS the value. What is gone
    // is norm(doc.body).match(...), which turned any number on the profile page - a salary band,
    // a review count, "10+ years" from a testimonial - into the company's headcount, in a cell
    // indistinguishable from a real one.
    function readSize(doc){

        return core.headcount(doc,{
            label:SIZE_LABEL,
            value:SIZE_VALUE,
            scope:'[data-testid*="employee" i],[data-testid*="companyInfo" i],li,tr,td,dd,dt,p,span,div'
        });

    }

    function cleanUrl(href){

        if(!href) return "";

        const url=new URL(href,ORIGIN);

        // Cards link to sub-pages too (/cmp/Dell/reviews, /cmp/Dell/salaries) and only the profile
        // root carries the size, so cut back to /cmp/<slug>. It also collapses every variant of a
        // company onto one cache key.
        const slug=url.pathname.match(/^\/cmp\/[^/]+/);

        // drop campaignid/tk: keep only the company path.
        // /cmp/ links sometimes point at another country's domain (www.indeed.com) -> pull them
        // back to the open root so they match host_permissions and the page language.
        return ORIGIN+(slug?slug[0]:url.pathname);

    }

})();
