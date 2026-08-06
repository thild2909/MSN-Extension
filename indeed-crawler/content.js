(async()=>{

    const LOG="[indeed-crawler]";
    const ORIGIN=location.origin;

    // sg / au / hk / uk / my .indeed.com - same markup, only the domain and language differ
    const COUNTRY=(location.hostname.split(".")[0]||"").toLowerCase();
    const FILE="indeed_"+(/^[a-z]{2}$/.test(COUNTRY)?COUNTRY+"_":"")+"companies.xlsx";

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

    // Extra floor between two requests, per request kind, ON TOP of the adaptive gap below.
    // Zero on purpose: a fixed toll is paid on every request whether or not Indeed minds, and at
    // 900ms across 62 pages that was a minute of waiting for nothing. The gap is the real control
    // and it already widens the moment anything is refused - so run at full speed and let being
    // rate limited, not the fear of it, be what slows the crawler down.
    const DELAY=0;
    const DETAIL_DELAY=0;

    // Indeed rate limits per IP, so pacing one worker at a time is useless: the gate has to
    // sit in front of EVERY request. It does three things at once -
    //   1. at most `limit` requests in flight, and the limit shrinks while we are being blocked
    //   2. never two request STARTS closer together than `gap` (+ jitter, so the workers
    //      that were blocked together do not come back in lockstep)
    //   3. a 429/403/503 parks every worker until `pausedUntil`, not just the one that got it
    // the floor the gap returns to once nothing is being refused - i.e. how fast a clean run goes
    const MIN_GAP=120;
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

    // what a block costs once the exit IP has been swapped: just enough for the network stack to
    // finish picking up the new route, instead of the exponential cooldown a same-IP block earns
    const ROTATE_SETTLE=1200;

    // how long every worker is parked while the swap is in flight (apply + the IP echo check)
    const ROTATE_HOLD=6000;

    // the worker clears the browser proxy after 20 quiet minutes; a long run has to say it is alive
    const PING_EVERY=60000;

    const throttle={

        deadEnds:0,
        dead:false,
        paidOut:0,

        // how much cooling off is worth sitting through before the session is written off. Raised
        // while paginating, where quitting early throws away every page still to come.
        budget:BLOCK_BUDGET,

        gap:MIN_GAP,
        pausedUntil:0,
        nextSlot:0,
        chain:Promise.resolve(),

        limit:1,
        maxLimit:1,
        active:0,
        waiting:[],

        clean:0,
        blocks:0,

        // called before the request goes out; must be paired with leave()
        async enter(pace){

            for(;;){

                if(this.active<this.limit){
                    this.active++;
                    break;
                }

                await new Promise(resolve=>this.waiting.push(resolve));

            }

            // one shared queue so the start times interleave instead of bunching up
            const mine=this.chain.then(async()=>{

                for(;;){

                    const now=performance.now();
                    const wait=Math.max(this.pausedUntil-now,this.nextSlot-now);

                    if(wait<=0) break;

                    await sleep(wait+Math.random()*200);

                }

                this.nextSlot=performance.now()+Math.max(pace||0,this.gap);

            });

            this.chain=mine.catch(()=>{});

            return mine;

        },

        leave(){

            this.active--;

            const next=this.waiting.shift();

            if(next) next();

        },

        holdUntil:0,

        // park every worker without counting it as a penalty. Used while the exit IP is being
        // swapped: a request that leaves mid-swap goes out on the IP we are running away from,
        // gets blocked again, and buys nothing.
        hold(ms){

            const until=performance.now()+ms;

            this.holdUntil=Math.max(this.holdUntil,until);
            this.pausedUntil=Math.max(this.pausedUntil,until);

        },

        // the swap finished early - hand back the part of the hold nobody needed. A cooldown that
        // outlives the hold was set by a real penalty and is left alone.
        release(ms){

            if(this.pausedUntil>this.holdUntil) return;

            this.holdUntil=0;
            this.pausedUntil=performance.now()+(ms||0);

        },

        // `rotated` is true when the request went out on an IP that has since been replaced.
        // Indeed rate limits per IP, so on a fresh IP the block simply does not apply any more:
        // sitting out the full exponential cooldown would be waiting for nothing. Only the short
        // settle time the network stack needs to pick up the new route is worth paying.
        // `widen` says this is a NEW request being refused rather than another go at one already
        // refused. Only the first tells us anything about pace: the gap grows 1.7x per block, so
        // letting all six retries of one unhappy page widen it multiplies the pace by 24 and every
        // page after it crawls at the 8s ceiling. Retries still cool down - that is the lever for
        // waiting a rate limit out - they just stop rewriting the speed of the whole run.
        penalize(retryMs,rotated,widen){

            this.blocks++;
            this.clean=0;

            if(rotated){

                this.release(ROTATE_SETTLE+Math.random()*200);

                // the pace was never the problem on the new IP, and the block budget must not run
                // down on cooldowns we did not actually serve
                this.blocks=Math.max(0,this.blocks-1);

                report(`rate limited - switched exit IP (${proxy.label||"new IP"})`);

                return;

            }

            if(widen) this.gap=Math.min(MAX_GAP,this.gap*1.7);

            // 1.5s, 3s, 6s, 12s, 24s, 48s... capped, and always at least what Retry-After asked for
            const cool=Math.min(MAX_COOLDOWN,
                Math.max(retryMs||0,1500*Math.pow(2,Math.min(5,this.blocks-1))));

            this.pausedUntil=Math.max(this.pausedUntil,performance.now()+cool+Math.random()*400);

            // being blocked means we are running too wide as well as too fast
            if(this.limit>1) this.limit--;

            // every cooldown since the last page that actually came back
            this.paidOut+=cool;

            if(this.paidOut>=this.budget){

                this.dead=true;

                report("Indeed has blocked this session - stopping the company size lookup");

                return;

            }

            report(`rate limited - pausing ${Math.round(cool/1000)}s`
                +` (gap ${Math.round(this.gap)}ms, ${this.limit} parallel)`);

        },

        relax(){

            this.clean++;
            this.deadEnds=0;
            this.paidOut=0;

            // A clean run walks the penalty back down. It used to shed 20% every ten pages, which
            // from a 2.4s gap needs ~100 clean requests to get back to normal - so one bad moment
            // at page 48 taxed every page after it. The penalty should last as long as Indeed is
            // actually pushing back, not for the rest of the run.
            if(this.clean%3===0&&this.blocks>0) this.blocks--;

            if(this.clean%3!==0) return;

            this.gap=Math.max(MIN_GAP,this.gap*0.65);

            if(this.limit<this.maxLimit){

                this.limit++;

                const next=this.waiting.shift();

                if(next) next();

            }

        }

    };

    //---------------------------------------------------
    // Webshare proxy, driven from background.js
    //
    // The IP is what Indeed rate limits, so changing it is the only move that actually clears a
    // block - every other knob here (gap, parallelism, cooldown) just slows down how fast we walk
    // into the next one. A content script cannot change its own route, so background.js does it.
    //---------------------------------------------------

    const proxy={

        enabled:false,
        used:false,
        label:"",
        pool:0,

        // which IP the crawler is currently sending on. A request carries the seat it left under,
        // so a 429 that arrives after the IP already changed is recognised as stale.
        seat:"",
        rotations:0,
        exhausted:false,

        since:0,
        every:0,
        lastPing:0,

        // every worker that was blocked by the same IP shares this one promise
        rotating:null,

        async send(message){

            try{

                const reply=await chrome.runtime.sendMessage(message);

                return reply||{ok:false,error:"no reply from the extension worker"};

            }
            catch(e){

                return {ok:false,error:e&&e.message||String(e)};

            }

        },

        async start(country,every){

            const reply=await this.send({type:"proxy:enable",country});

            if(!reply.ok) return reply;

            this.enabled=true;
            this.used=true;
            this.every=every>0?every:0;
            this.label=reply.label||"";
            this.seat=reply.seat||"";
            this.pool=reply.pool||0;
            this.lastPing=performance.now();

            return reply;

        },

        // Indeed's edge refuses some datacentre IPs outright with a Cloudflare interstitial. That
        // is not a rate limit and no wait clears it, so the address is retired and we move on. If
        // the whole pool turns out to be refused, the run is finished on the real IP - a slow
        // crawl beats a crawl where every request comes back as a captcha page.
        async giveUp(reason){

            await this.stop();

            this.exhausted=true;
            this.label="direct connection";

            report("Proxy off: "+reason+" - continuing on the normal connection");

            console.warn(LOG,"proxy given up:",reason);

        },

        // `seat` is the IP the blocked request actually left under. Several workers are always in
        // flight together, so their 429s arrive in a burst - but they were all earned on the same
        // address, and one rotation answers all of them. Quoting the seat back is what tells a
        // block on the IP we are still using apart from one on an IP we have already left; a
        // wall-clock window cannot, and would either burn the whole pool on one bad minute or
        // swallow the verdict on the IP that replaced it.
        async rotate(reason,seat){

            if(!this.enabled||this.exhausted) return false;

            // the route already moved on after that request left: nothing more to do for it
            if(seat&&this.seat&&seat!==this.seat) return true;

            // and the ones that left under the seat still in use share a single rotation
            if(this.rotating) return this.rotating;

            this.rotating=(async()=>{

                const reply=await this.send({type:"proxy:rotate",reason:String(reason||"block")});

                if(!reply.ok){

                    // every address refused: the proxy is not a slower route any more, it is a
                    // wall, and the real IP is the only one left that answers
                    if(reply.walled){
                        await this.giveUp(reply.error);
                        return false;
                    }

                    // one usable IP left, or the worker is gone - keep it and fall back to the
                    // plain backoff instead of asking for a swap that cannot happen
                    this.exhausted=true;

                    report("proxy cannot rotate ("+(reply.error||"unknown")+") - backing off instead");

                    return false;

                }

                this.since=0;
                this.lastPing=performance.now();
                this.seat=reply.seat||"";

                if(reply.label) this.label=reply.label;
                if(reply.rotations) this.rotations=reply.rotations;

                return true;

            })();

            try{
                return await this.rotating;
            }
            finally{
                this.rotating=null;
            }

        },

        // called after every page that came back: swaps the IP before Indeed gets a chance to
        // count far enough to block it, and keeps the worker's auto-off timer from firing
        async onSuccess(){

            if(!this.enabled) return;

            if(this.every&&++this.since>=this.every){

                // same reason as a block driven swap: nothing may leave while the route changes
                throttle.hold(ROTATE_HOLD);

                try{
                    await this.rotate("scheduled");
                }
                finally{
                    throttle.release(0);
                }

                return;

            }

            if(performance.now()-this.lastPing<PING_EVERY) return;

            this.lastPing=performance.now();

            await this.send({type:"proxy:ping"});

        },

        async stop(){

            if(!this.enabled) return;

            this.enabled=false;

            await this.send({type:"proxy:disable"});

        }

    };

    //---------------------------------------------------
    // the sign-in wall
    //
    // Indeed serves page 1 of a search to anyone and answers every later page with a redirect to
    // secure.indeed.com carrying "branding=page-two-signin" - or, when the request looks like a
    // fetch rather than a click, with Cloudflare's 403 in front of it. Measured on sg, au, hk, uk
    // and de: page 1 is 200 and page 2 is the wall, on the home connection and on every proxy
    // alike. It is an account requirement, not a rate limit, so pacing, cooling off and swapping
    // exit IPs are all answers to a question nobody asked.
    //---------------------------------------------------

    const SIGNIN_HOST=/(^|\.)secure\.indeed\.com$/i;
    const SIGNIN_PATH=/page-two-signin|\/auth\b|\/account\/login/i;

    // `cleared` latches as soon as any paginated page comes back: from then on the crawler knows
    // for a fact that this session may read past page 1, so a later refusal is something else.
    const wall={hit:false,cleared:false,reason:""};

    function pagedUrl(url){

        try{
            return +new URL(url,ORIGIN).searchParams.get("start")>0;
        }
        catch(e){
            return false;
        }

    }

    // fetch follows the redirect, so the answer carries the address it ended up at
    function signInWall(response){

        if(!response||!response.url) return false;

        try{

            const url=new URL(response.url,ORIGIN);

            return SIGNIN_HOST.test(url.hostname)||SIGNIN_PATH.test(url.pathname+url.search);

        }
        catch(e){
            return false;
        }

    }

    function hitWall(url,reason){

        if(wall.hit) return;

        wall.hit=true;
        wall.reason=reason;

        console.warn(LOG,"sign-in wall:",reason,url);

        report("Indeed only serves page 1 without an account - stopping pagination");

    }

    // two companies can share one /cmp/ page ("Capgemini" and "Capgemini Sogeti") -> fetch it once
    const docCache=new Map();

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
    const SIZE_DOC=/(more than \d[\d.,]*|over \d[\d.,]*|mehr als \d[\d.,]*|\d[\d.,]*\s*(?:to|bis|–|—|-)\s*\d[\d.,]*|\d[\d.,]*\+)\s*(?:employees?|mitarbeiter\w*|名員工|名员工)?/i;

    // work-model chips on the card, separated from benefit chips (Health insurance, Stock options...)
    const MODE_CHIP=/remote|work from home|hybrid|遙距|遥距|遠端|远程|在家工作|混合|homeoffice|home-office|telearbeit/i;

    const jobs=[];
    const visited=new Set();

    // connections that died before Indeed answered anything - kept apart from Indeed's own
    // refusals, because the two call for opposite reactions and have different remedies
    let netErrors=0;

    const startedAt=performance.now();

    // A tab navigation kills the content script outright - no catch block runs and nothing is
    // written. The checkpoint turns that from "the whole run is gone" into "the next run starts
    // where this one stopped", which on a 62 page crawl is most of an hour.
    const checkpoint=core.makeCheckpoint("indeedCheckpoint",{log:LOG});

    // set the moment the file is handed to the browser, so the crash path can never write a second one
    let fileWritten=false;

    let resumed=0;

    function sleep(ms){
        return new Promise(r=>setTimeout(r,ms));
    }

    // send status back to the popup (it may already be closed -> swallow the error)
    function report(text){

        console.log(LOG,text);

        try{
            chrome.runtime.sendMessage({type:"indeed-crawler-status",text}).catch(()=>{});
        }
        catch(e){}

    }

    // textContent + whitespace collapse: a DOMParser document is never rendered, so innerText cannot be trusted
    function norm(el){
        return (el&&el.textContent||"").replace(/\s+/g," ").trim();
    }

    function pick(root,selector){
        return norm(root.querySelector(selector));
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

        let maxPages=0;
        let concurrency=3;
        // off unless the popup says otherwise: the /cmp/ lookup is one request per company and the
        // part of the run Indeed pushes back on hardest
        let wantEmployees=false;
        let useProxy=false;

        // Swapping on a schedule only pays off with a pool where most addresses work. Here most of
        // them are refused, so a timed swap is as likely to walk off a good IP onto a dead one -
        // the crawler swaps when it is actually blocked instead.
        let rotateEvery=0;

        try{

            const settings=await chrome.storage.local.get(
                ["maxPages","concurrency","employees","useProxy","rotateEvery"]);

            maxPages=+settings.maxPages||0;

            if(settings.concurrency) concurrency=Math.min(8,Math.max(1,+settings.concurrency));

            if(settings.employees===true) wantEmployees=true;

            useProxy=settings.useProxy===true;

            if(settings.rotateEvery!==undefined) rotateEvery=Math.max(0,+settings.rotateEvery||0);

        }
        catch(e){
            console.warn(LOG,"could not read settings, using defaults",e);
        }

        // the setting is the ceiling, not a fixed width: the gate drops below it while blocked
        throttle.maxLimit=concurrency;
        throttle.limit=concurrency;

        //---------------------------------------------------
        // 1b. route the fetches through Webshare before the first one goes out
        //     (page 1 is read from the already loaded DOM, so it stays on the real IP either way)
        //---------------------------------------------------

        if(useProxy){

            const started=await proxy.start(COUNTRY,rotateEvery);

            if(started.ok){

                report(`Proxy on: ${started.label} - ${started.pool} IP(s) available`);

                console.log(LOG,"proxy on:",started.label);

            }
            else{

                // running unproxied is still a working crawl, just the slower one - the alternative
                // is refusing to start over a proxy the user can fix afterwards
                report("Proxy off: "+started.error+" - continuing on the normal connection");

                console.warn(LOG,"proxy could not be enabled:",started.error);

            }

        }

        //---------------------------------------------------
        // 2. page 1 comes straight from the open DOM (no request, no bot check),
        //    later pages are fetched through &start=
        //---------------------------------------------------

        //---------------------------------------------------
        // 1c. pick up an unfinished run on the same search
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

        const first=collectFrom(document);

        console.log(LOG,`page 1: ${first.cards} cards -> ${first.added} jobs`);

        if(jobs.length===0){

            alert("No job cards found. Open an sg.indeed.com search results page (/jobs?q=...) and run again.");
            return;

        }

        throttle.budget=PAGING_BUDGET;

        const paging=await loadPages(maxPages);

        throttle.budget=BLOCK_BUDGET;

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
                        company.employees=readSize(profile);

                        if(company.employees) withSize++;
                        else if(index<3) console.warn(LOG,"no company size on",company.companyUrl);

                    }

                }

                // Once Indeed hard-blocks the session, every further request is wasted and the run
                // never ends. Stop the lookup and export what we already have.
                if((throttle.dead||throttle.deadEnds>=BLOCK_LIMIT)&&!givenUp){

                    givenUp=true;

                    console.warn(LOG,"Indeed is blocking the session - company size lookup stopped early");

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
                // Nothing is retried once the session is written off: every request is wasted then.
                shouldRetry:company=>company.failed===true&&!givenUp&&!throttle.dead&&!wall.hit,
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

        // the PAC is a browser wide setting: leaving it behind would route every later Indeed visit
        // through Webshare, including ones made by hand after the crawl
        await proxy.stop();

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

        const written=core.exportXlsx(results,{
            headers:HEADERS,
            widths:[32,24,60,18,16,16],
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
            +(written.clipped?`\n${written.clipped} cell(s) truncated to fit Excel's 32,767 character limit.`:"")
            +(netErrors?`\n\n${netErrors} connection(s) dropped before Indeed answered `
                +"(ERR_QUIC_PROTOCOL_ERROR and friends). Those are retried, but if there are many "
                +"of them the HTTP/3 path to Indeed is unstable: open chrome://flags, set "
                +"'Experimental QUIC protocol' to Disabled, restart Chrome and run again.":"")
            +PAGING_NOTE(paging)
            +(proxy.used?`\nProxy: ${proxy.rotations} IP change(s), last exit ${proxy.label||"unknown"}`
                +(proxy.enabled?".":" (the rest of the run went out on the normal connection)."):"")
            +(wall.hit?"\n\nIndeed served page 1 only: everything after it is behind a sign-in "
                +`(${wall.reason}). This is an account requirement, not a rate limit - it is `
                +"identical on every IP, so the proxy cannot get past it. Sign in to Indeed in this "
                +"browser and run again to read the rest of the pages.":"")
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

        let pages=1;
        let stoppedEarly=false;
        let repeats=0;
        let misses=0;
        let rounds=0;

        // pages stepped over during the walk, kept for a second pass at the end
        const missed=[];

        // why the walk ended, so the summary can say whether the list ran out or Indeed cut us off
        let reason="end";

        const limit=maxPages?Math.min(maxPages,HARD_PAGE_CAP):HARD_PAGE_CAP;

        // every &start= we have already asked for, so a page that links back to itself or to an
        // earlier one cannot put the loop in a circle
        const seen=new Set();

        // the gap between one page's start= and the next. Read from the pages themselves rather
        // than assumed, because it follows &limit= (10 on the old build, 15 on the current one).
        let step=0;

        // page 1 was already read from the open DOM; ask it where page 2 lives
        let url=nextPageUrl(document,location.href);

        // page 1 starts at 0, so page 2's start IS the stride - known before anything is fetched,
        // which is what lets even a miss on the very first fetched page be stepped over
        if(url) step=startOf(url);

        // the miss path can advance without pages++, so the loop needs its own stop
        while(url&&pages<limit&&rounds++<limit*2){

            if(seen.has(url)){
                console.warn(LOG,"pagination pointed back at a page already read - stopping");
                reason="loop";
                break;
            }

            seen.add(url);

            const doc=await fetchDoc(url,DELAY);

            // a walled page can still parse (Cloudflare's interstitial is valid html) - it just
            // has no jobs on it, and asking for page 3 would be pointless
            if(wall.hit){
                stoppedEarly=true;
                reason="wall";
                break;
            }

            if(!doc){

                // Losing one page must not lose every page behind it. The next URL normally comes
                // out of the page we just failed to read, so without this the run ends here - at
                // page 27 of 60, throwing away two thirds of the list over one busy moment.
                // The step is known from the pages that did arrive, so we can step over it.
                const next=step?bumpStart(url,step):"";

                if(++misses>=MAX_MISSES||!next){
                    stoppedEarly=true;
                    reason="blocked";
                    break;
                }

                missed.push(url);

                console.warn(LOG,`page after start=${startOf(url)} did not come back - skipping to`,next);

                url=next;

                continue;

            }

            misses=0;

            const found=collectFrom(doc);

            pages++;

            report(`Page ${pages}: ${found.added} new job(s), ${jobs.length} total`);

            // written as we go: a tab navigation kills the content script outright, and without
            // this a 40 page walk that dies at page 39 leaves nothing at all behind
            await checkpoint.save({jobs});

            // 0 cards = the end of the list, or Indeed returned a bot-check page
            if(found.cards===0){
                console.warn(LOG,"page",pages,"had no job cards - end of results or a bot check");
                stoppedEarly=true;
                reason="empty";
                break;
            }

            repeats=found.added?0:repeats+1;

            if(repeats>=MAX_REPEAT_PAGES){
                console.warn(LOG,`${repeats} pages in a row held nothing new - stopping`);
                reason="repeat";
                break;
            }

            const next=nextPageUrl(doc,url);

            // learn the stride from two pages that really exist, so a later miss can be stepped
            // over without guessing
            if(next){

                const gap=startOf(next)-startOf(url);

                if(gap>0) step=gap;

            }

            url=next;

        }

        if(url&&pages>=limit){
            stoppedEarly=true;
            reason="limit";
        }

        // Second pass over the pages that were stepped over. The rate limit that cost them has had
        // the whole rest of the list to cool off by now, so a page skipped at 48 of 62 usually
        // comes back on the way out - which is the difference between 61 pages and all 62.
        let skipped=missed.length;

        if(missed.length&&!wall.hit&&!throttle.dead){

            report(`Retrying ${missed.length} page(s) that were skipped...`);

            for(const retry of missed){

                const doc=await fetchDoc(retry,DELAY,RECOVERY_TRIES);

                if(!doc) continue;

                const found=collectFrom(doc);

                pages++;
                skipped--;

                report(`Recovered page at start=${startOf(retry)}: ${found.added} new job(s), `
                    +`${jobs.length} total`);

            }

        }

        await checkpoint.save({jobs},true);

        return {pages,stoppedEarly,skipped,recovered:missed.length-skipped,reason};

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

    function startOf(url){

        try{
            return +new URL(url,ORIGIN).searchParams.get("start")||0;
        }
        catch(e){
            return 0;
        }

    }

    // the same URL one page further on
    function bumpStart(url,step){

        try{

            const next=new URL(url,ORIGIN);

            next.searchParams.set("start",String(startOf(url)+step));

            return next.toString();

        }
        catch(e){
            return "";
        }

    }

    //---------------------------------------------------
    // helper: the URL of the page after `fromUrl`, taken from that page's own pagination.
    // Reading it instead of computing start+10 is what keeps a limit=15 search from being crawled
    // in overlapping 10-job windows, which loses the tail of the result list.
    //---------------------------------------------------

    function nextPageUrl(root,fromUrl){

        const next=root.querySelector('a[data-testid="pagination-page-next"][href]');

        if(next) return absolute(next.getAttribute("href"));

        // some builds render only the numbered links: take the lowest start still ahead of us
        const here=+new URL(fromUrl,ORIGIN).searchParams.get("start")||0;

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

    function absolute(href){
        return new URL(href,ORIGIN).toString();
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

        cards.forEach(card=>{

            // Indeed renders an extra hidden card for the detail pane on the right -> drop it
            if(card.getAttribute("aria-hidden")==="true") return;

            const link=card.querySelector("a[data-jk]");
            const id=link?link.getAttribute("data-jk"):"";

            if(!id||visited.has(id)) return;

            visited.add(id);

            jobs.push(readCard(card,id));

            added++;

        });

        return {cards:cards.length,added};

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

        if(results.length) console.log(LOG,`read ${results.length} card(s) from the embedded JSON`);

        return {cards:results.length,added};

    }

    function jobCardsJson(root){

        for(const script of root.querySelectorAll("script")){

            const text=script.textContent||"";

            const at=text.indexOf('"mosaic-provider-jobcards"');

            if(at<0) continue;

            const assign=text.indexOf("=",at);

            if(assign<0) continue;

            const open=text.indexOf("{",assign);

            if(open<0) continue;

            const raw=balanced(text,open);

            if(!raw) continue;

            try{

                const data=JSON.parse(raw);
                const model=data&&data.metaData&&data.metaData.mosaicProviderJobCardsModel;

                if(model&&Array.isArray(model.results)) return model.results;

            }
            catch(e){
                console.warn(LOG,"could not parse the embedded job card JSON",e);
            }

        }

        return [];

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

        for(const job of list){

            const name=job.company||"(unknown)";

            // "ACME Pte Ltd" and "ACME Pte. Ltd." are one employer and used to become two rows,
            // each holding a slice of the positions. core.nameKey folds case, punctuation and a
            // closed list of legal-form suffixes - and nothing else, so distinct employers
            // ("Acme Tech" vs "Acme Technologies") still stay apart.
            const key=core.nameKey(name);

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
                    employees:""
                };

                map.set(key,company);

            }

            company.jobs++;

            // any card that carried the /cmp/ link saves the whole company a job-page fetch
            if(!company.companyUrl&&job.companyUrl) company.companyUrl=job.companyUrl;

            push(company.positions,job.title);
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

    // The work location lives in the location field ("Remote", "Hybrid work in Singapore") or
    // in a "Work from home" chip. A city name alone means working there -> Onsite.
    // The title is deliberately NOT read: "Blockchain Engineer (Remote)" is not work-location data.
    function readMode(location,chips){

        const text=[location||""].concat(chips||[]).join(" ");

        if(!text.trim()) return "";

        if(/hybrid|混合/i.test(text)) return "Hybrid";
        if(/remote|work from home|遙距|遥距|遠端|远程|在家工作|homeoffice|home-office|telearbeit/i.test(text)) return "Remote";

        return "Onsite";

    }

    //---------------------------------------------------
    // helper: the headcount on the /cmp/<slug> page
    // "Size" + "51 to 200", or the sentence "51 to 200 employees"
    //---------------------------------------------------

    function readSize(doc){

        for(const el of doc.querySelectorAll('[data-testid*="employee" i], [data-testid*="companyInfo" i], li, tr')){

            const parts=blocks(el);

            for(let i=0;i+1<parts.length;i++){

                if(SIZE_LABEL.test(parts[i])&&parts[i+1]) return parts[i+1];

            }

        }

        const body=norm(doc.body).match(SIZE_DOC);

        return body?body[0]:"";

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

    //---------------------------------------------------
    // helper: split text per text node, so words do not run together when the
    // markup has no whitespace between tags
    //---------------------------------------------------

    function blocks(el){

        const parts=[];

        (function walk(node){

            for(const child of node.childNodes){

                if(child.nodeType===3){

                    const text=(child.nodeValue||"").replace(/\s+/g," ").trim();

                    if(text) parts.push(text);

                }
                else if(child.nodeType===1){
                    walk(child);
                }

            }

        })(el);

        return parts;

    }

    //---------------------------------------------------
    // helper: fetch + parse, backing off automatically when rate limited
    // Indeed answers 403 when it suspects a bot -> treat that as a rate limit and retry too.
    //---------------------------------------------------

    // `tries` overrides the attempt budget - used by the recovery pass, where the page has already
    // had the full ladder once and a second one would cost more than the page is worth
    async function fetchDoc(url,pace,tries){

        // once the session is blocked outright, retrying only makes the run longer, never better
        if(throttle.dead) return null;

        // and once Indeed has told us the rest of the list needs an account, every further page
        // request gets the same answer
        if(wall.hit&&pagedUrl(url)) return null;

        // While things are degrading every URL gets two tries instead of six, so we find out fast -
        // except a paginated page, which is worth the full ladder even then: it carries fifteen
        // jobs and, until it comes back, no way of knowing where the page after it starts.
        const attempts=tries||(throttle.blocks>=3&&!pagedUrl(url)?2:MAX_ATTEMPTS);

        // which exit IPs this one URL has already been refused on. Two different addresses giving
        // the same answer is the proof that the address was never the reason.
        const refusedOn=new Set();

        // connections that died before Indeed answered, counted separately from refusals
        let transportFails=0;

        for(let attempt=1;attempt<=attempts;attempt++){

            if(throttle.dead) break;

            // the wait lives BEFORE the request: that is the only place it can cap the send rate.
            // Waiting afterwards (as it used to) left the retries of a 429 completely unpaced.
            await throttle.enter(pace);

            // read BEFORE the request goes out: by the time it comes back the crawler may already
            // be on a different IP, and this is the one the answer belongs to
            const seat=proxy.seat;

            let response;

            try{

                // A bare fetch() sends "Accept: */*" and no referrer, which reads as an API client.
                // Asking for html from the page we are already on looks like an ordinary page load.
                response=await fetch(url,{
                    credentials:"include",
                    referrer:location.href,
                    headers:{"Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}
                });

            }
            catch(e){

                throttle.leave();

                netErrors++;
                transportFails++;

                console.warn(LOG,`fetch failed (${transportFails}/${MAX_TRANSPORT_TRIES})`,
                    url,e&&e.message||e);

                // A rejected fetch is the connection dying, not an answer: there is no status and
                // it says nothing about pace, so it must not widen the gap or count as a block.
                //
                // ERR_QUIC_PROTOCOL_ERROR / QUIC_TOO_MANY_RTOS is the usual one. Indeed advertises
                // HTTP/3, so Chrome talks to it over UDP, and a path that starts losing packets
                // takes the whole session down with it. Chrome retires a broken h3 session after a
                // few failures and falls back to TCP - which is exactly why retrying works, and
                // why giving up on the first one was wrong: it cost a whole page, and while
                // paginating, the link to every page behind it.
                if(transportFails<MAX_TRANSPORT_TRIES&&attempt<attempts){

                    await sleep(TRANSPORT_PAUSE*transportFails+Math.random()*300);

                    continue;

                }

                return null;

            }

            // Indeed hands page 1 of a search to anyone and sends every later page to a sign-in
            // ("branding=page-two-signin"). That redirect is the wall the crawler keeps hitting;
            // it is the same on every address, so it must never be mistaken for a block.
            if(signInWall(response)){

                throttle.leave();

                hitWall(url,"redirected to the Indeed sign-in page");

                return null;

            }

            if(response.status===429||response.status===503||response.status===403){

                throttle.leave();

                refusedOn.add(seat||"direct");

                // Page 2 of a search is refused to every visitor on every address - measured on
                // sg, au, hk, uk and de, proxied and direct alike. So once one of those pages has
                // been refused on two different exit IPs there is nothing left to learn: more
                // rotations would spend the pool proving the same point, and retiring those IPs
                // would empty it over something they did not do.
                //
                // Two refusals are enough whether or not the address changed in between: with a
                // proxy that is two different IPs saying the same thing, and without one it is the
                // same wall twice. Either way the remaining four attempts and their forty seconds
                // of cooldown buy nothing.
                //
                // Narrow on purpose, because calling something a wall ends the crawl:
                //   * only 403 - a 429 or 503 is pace, not permission, and clears by waiting. One
                //     busy moment at page 27 must not be read as "you need an account";
                //   * only paged URLs - everywhere else a refusal really can be about the address,
                //     and the pool has to be walked to find that out;
                //   * only while no paginated page has ever come back. One that did is proof the
                //     way is open, so whatever this is, it is not the sign-in wall.
                if(response.status===403&&pagedUrl(url)&&!wall.cleared&&attempt>=2){

                    throttle.release(0);

                    hitWall(url,refusedOn.size>1
                        ?`HTTP 403 on ${refusedOn.size} different exit IPs`
                        :"HTTP 403 on every attempt");

                    return null;

                }

                // A new IP is a new rate limit budget, so ask for one before deciding how long to
                // wait. Everyone is parked first: a sibling request that slips out mid-swap still
                // travels on the IP we are leaving behind.
                if(proxy.enabled&&!proxy.exhausted) throttle.hold(ROTATE_HOLD);

                // Cloudflare labels its own 403s, and "challenge" normally means the exit IP was
                // refused before Indeed ever looked at the request - grounds to retire it.
                // But only a page anyone may read can testify about an address. A paged search
                // result is refused to every visitor, so a challenge on one says nothing about the
                // IP that asked, and retiring the pool over it is how a good IP gets thrown away.
                const challenged=response.headers.get("cf-mitigated")==="challenge";

                const reason=challenged&&!pagedUrl(url)?"challenge":response.status;

                const wasProxied=proxy.enabled;

                const rotated=await proxy.rotate(reason,seat);

                // dropping the proxy altogether changes the exit IP just as much as swapping it:
                // the retry leaves on the real address, which is not the one that was blocked
                const moved=rotated||(wasProxied&&!proxy.enabled);

                // a failed swap leaves the hold behind, and it would silently stand in for the
                // real backoff penalize is about to work out
                if(!moved) throttle.release(0);

                // parks every worker, so the retry does not go out with five siblings
                throttle.penalize(retryAfter(response),moved,attempt===1);

                continue;

            }

            if(!response.ok){

                throttle.leave();

                console.warn(LOG,"HTTP",response.status,url);

                return null;

            }

            let html;

            try{
                html=await response.text();
            }
            finally{
                throttle.leave();
            }

            throttle.relax();

            if(pagedUrl(url)) wall.cleared=true;

            // moving off an IP BEFORE it collects a block is cheaper than the block: no cooldown,
            // no lost request, and Indeed never sees enough traffic from one address to act on
            await proxy.onSuccess();

            return new DOMParser().parseFromString(html,"text/html");

        }

        throttle.deadEnds++;

        console.warn(LOG,`gave up after ${attempts} blocked attempts`,url);

        return null;

    }

    // Dedupe by URL: the same page is never fetched twice, and a page already in flight is shared.
    //
    // A FAILED result is evicted on purpose. Caching null meant a company whose /cmp/ page was
    // refused once, during the busiest minute of the run, could never be read again - not by the
    // retry pass, not by anything - and its size cell came out blank, indistinguishable from a
    // company that publishes no headcount at all.
    function fetchDocCached(url,pace){

        if(docCache.has(url)) return docCache.get(url);

        const pending=fetchDoc(url,pace).then(doc=>{

            if(!doc) docCache.delete(url);

            return doc;

        },e=>{

            docCache.delete(url);

            throw e;

        });

        docCache.set(url,pending);

        return pending;

    }

    // Retry-After is either a number of seconds or an HTTP date
    function retryAfter(response){

        const header=response.headers.get("retry-after");

        if(!header) return 0;

        const seconds=+header;

        if(seconds>0) return Math.min(MAX_COOLDOWN,seconds*1000);

        const when=Date.parse(header);

        return when?Math.min(MAX_COOLDOWN,Math.max(0,when-Date.now())):0;

    }

})();
