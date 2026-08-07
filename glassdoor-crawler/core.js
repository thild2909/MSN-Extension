//---------------------------------------------------
// core.js - the shared crawl engine for every crawler in this family.
//
// Every crawler used to carry its own copy of "fetch, back off, walk the pages, write the file",
// and each copy lost data in a slightly different way: a dropped connection returned null with no
// retry, one failed page ended the whole pagination, and an exception anywhere threw away
// everything already collected. This file is the one implementation of those four things, so a fix
// lands everywhere at once.
//
// It is injected BEFORE content.js (see popup.js) and publishes window.CrawlerCore. Both scripts
// run in the same isolated world, so the page can neither see nor tamper with any of it.
//
// The four guarantees it exists to provide:
//   COVERAGE      - a page that fails is stepped over, remembered, and retried at the end, never
//                   allowed to end the walk and silently truncate the result set
//   NO DATA LOSS  - whatever has been collected is written to a file even when the run crashes,
//                   and is checkpointed to storage so a tab navigation does not erase it either
//   FAULT TOLERANCE - transport failures, rate limits and hard refusals are told apart and
//                   answered differently, because the right reaction to each is opposite
//   SPEED         - pacing is adaptive: full speed until the site actually pushes back, and the
//                   penalty is walked back down as soon as it stops
//---------------------------------------------------

window.CrawlerCore = (function(){

    "use strict";

    const VERSION="1.0";

    // Excel refuses to open a file with a cell longer than this, so a company with 900 positions
    // would produce a file nobody can read - which is a worse outcome than a truncated cell.
    const CELL_LIMIT=32767;

    function sleep(ms){
        return new Promise(r=>setTimeout(r,ms));
    }

    // textContent + whitespace collapse: a DOMParser document is never rendered, so innerText
    // cannot be trusted on anything that did not come from the live tab
    function norm(el){
        return (el&&el.textContent||"").replace(/\s+/g," ").trim();
    }

    function pick(root,selector){
        return norm(root&&root.querySelector(selector));
    }

    // split text per text node, so words do not run together when the markup has no whitespace
    // between tags ("Listed"+"five days ago" -> "Listedfive days ago" with textContent)
    function blocks(el){

        const parts=[];

        if(!el) return parts;

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
    // the gate
    //
    // Sites rate limit per IP, so pacing one worker at a time is useless: the control has to sit in
    // front of EVERY request. It does three things at once -
    //   1. at most `limit` requests in flight, and the limit shrinks while we are being refused
    //   2. never two request STARTS closer together than `gap` (+ jitter, so workers that were
    //      blocked together do not come back in lockstep)
    //   3. a 429/403/503 parks every worker until `pausedUntil`, not just the one that got it
    //
    // The floor is zero delay on purpose. A fixed toll is paid on every request whether or not the
    // site minds, and at 800ms across 60 pages that is a minute of waiting for nothing. The gap is
    // the real control and it widens the moment anything is refused - so run at full speed and let
    // being rate limited, rather than the fear of it, be what slows the crawler down.
    //---------------------------------------------------

    function makeGate(options){

        const o=Object.assign({
            minGap:0,
            maxGap:8000,
            maxCooldown:30000,
            limit:4,
            // how much cooling off is worth sitting through before the session is written off
            budget:180000,
            log:console
        },options||{});

        return {

            minGap:o.minGap,
            maxGap:o.maxGap,
            maxCooldown:o.maxCooldown,

            gap:o.minGap,
            pausedUntil:0,
            nextSlot:0,
            holdUntil:0,
            chain:Promise.resolve(),

            limit:o.limit,
            maxLimit:o.limit,
            active:0,
            waiting:[],

            clean:0,
            blocks:0,
            deadEnds:0,
            dead:false,
            paidOut:0,
            budget:o.budget,

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

            // park every worker without counting it as a penalty. Used while something outside the
            // pacing model is being fixed (an exit IP swap): a request that leaves mid-change goes
            // out under the condition we are running away from and buys nothing.
            hold(ms){

                const until=performance.now()+ms;

                this.holdUntil=Math.max(this.holdUntil,until);
                this.pausedUntil=Math.max(this.pausedUntil,until);

            },

            // the hold finished early - hand back the part nobody needed. A cooldown that outlives
            // the hold was set by a real penalty and is left alone.
            release(ms){

                if(this.pausedUntil>this.holdUntil) return;

                this.holdUntil=0;
                this.pausedUntil=performance.now()+(ms||0);

            },

            // `widen` says this is a NEW request being refused rather than another go at one
            // already refused. Only the first tells us anything about pace: the gap grows 1.7x per
            // block, so letting all six retries of one unhappy page widen it multiplies the pace by
            // 24 and every page after it crawls at the ceiling. Retries still cool down - that is
            // the lever for waiting a rate limit out - they just stop rewriting the whole run.
            penalize(retryMs,widen){

                this.blocks++;
                this.clean=0;

                if(widen) this.gap=Math.min(this.maxGap,Math.max(250,this.gap)*1.7);

                // 1.5s, 3s, 6s, 12s, 24s... capped, and always at least what Retry-After asked for
                const cool=Math.min(this.maxCooldown,
                    Math.max(retryMs||0,1500*Math.pow(2,Math.min(5,this.blocks-1))));

                const until=Math.max(this.pausedUntil,performance.now()+cool+Math.random()*400);

                this.pausedUntil=until;

                // Being refused means we are running too wide as well as too fast - but only a NEW
                // request being refused says that. This was outside the `widen` guard while the
                // gap was inside it, so one unhappy URL retried five times narrowed the pool five
                // times: parallel 6 collapsed to 1 on a single bad page, and since relax() only
                // widens once per three clean answers it took fifteen good pages to undo. Exactly
                // the multiplication the comment above says must not happen, on the other lever.
                if(widen&&this.limit>1) this.limit--;

                // every cooldown since the last request that actually came back
                this.paidOut+=cool;

                if(this.paidOut>=this.budget){

                    this.dead=true;

                    return {cool,dead:true,until};

                }

                return {cool,dead:false,until};

            },

            // The caller has decided not to wait this one out - it has a better answer than
            // waiting, a real navigation in a tab. Parking every OTHER worker for a cooldown
            // nobody is going to serve is pure loss: a single 502 on one company page was pausing
            // the whole pool for thirty seconds on the way to a fallback that does not need it.
            //
            // Only the worker that set the pause may take it back. If another has since asked for
            // longer, that one is about a refusal this crawler has not routed around, and it stands.
            // The gap and the block count are untouched either way - the refusal really happened.
            forgive(outcome){

                if(!outcome||this.pausedUntil!==outcome.until) return;

                this.pausedUntil=performance.now();
                this.paidOut=Math.max(0,this.paidOut-outcome.cool);

            },

            relax(){

                this.clean++;
                this.deadEnds=0;
                this.paidOut=0;

                // A clean run walks the penalty back down. Shedding it slowly means one bad moment
                // at page 48 taxes every page after it; the penalty should last as long as the site
                // is actually pushing back, not for the rest of the run.
                if(this.clean%3!==0) return;

                if(this.blocks>0) this.blocks--;

                this.gap=Math.max(this.minGap,this.gap*0.65);

                // Geometric decay approaches the floor but never reaches it: from a 2.4s gap,
                // 0.65^n is still ~150ms after a dozen clean rounds. That left every request for
                // the REST of the run paying a toll earned by one bad moment at page 4. Once the
                // remainder is down to noise, snap it to the floor and be done with the penalty.
                if(this.gap-this.minGap<100) this.gap=this.minGap;

                if(this.limit<this.maxLimit){

                    this.limit++;

                    const next=this.waiting.shift();

                    if(next) next();

                }

            },

            // raise the block budget for a stretch of the run where giving up is expensive
            // (pagination: quitting costs every page still to come, not one column)
            spend(budget){
                this.budget=budget;
                this.paidOut=0;
            }

        };

    }

    //---------------------------------------------------
    // the fetcher
    //
    // The single most expensive bug this replaces: `catch(e){ return null }`. A dropped connection
    // is not an answer - there is no status, it says nothing about pace, and it is very often gone
    // by the next attempt. Returning null on the first one cost a whole page, and while paginating,
    // the link to every page behind it.
    //---------------------------------------------------

    function makeFetcher(gate,options){

        const o=Object.assign({
            log:"[crawler]",
            // a rate limit is worth a few goes; a hard refusal is not worth six
            maxAttempts:5,
            // a dropped connection is worth a few goes, but not the full ladder: if the network is
            // actually down, six tries per URL turns a stalled run into a very long stalled run
            maxTransport:3,
            transportPause:700,
            credentials:"include",
            // A bare fetch() sends "Accept: */*" and no referrer, which reads as an API client.
            // Asking for html from the page we are already on looks like an ordinary page load.
            accept:"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            referrer:location.href,
            // sites that answer a bot check with 403 want it retried; ones that mean it do not
            retryForbidden:true,
            // swapped out by crawlers that must route some URLs through the service worker
            request:null,
            onRefused:null,

            // How many refused attempts before the ladder is abandoned in favour of whatever the
            // caller falls back to, and a predicate saying whether it has one left to fall back
            // to. Wired to `()=>tabs.available` by every crawler with a tab fallback; leave
            // canEscalate null and the ladder always runs in full, as it did before.
            escalateAfter:2,
            canEscalate:null
        },options||{});

        const stats={
            requests:0,
            netErrors:0,
            refusals:0,
            permanent:0,
            deadEnds:0,
            byReason:{}
        };

        // The last answer each URL got. A tab fallback needs it to tell a REFUSAL - which a real
        // navigation usually answers differently - from a 404, which it answers exactly the same
        // way, only several seconds slower.
        const answers=new Map();

        function note(reason){

            stats.byReason[reason]=(stats.byReason[reason]||0)+1;

            // one console line per failed URL buries everything else when a whole domain answers
            // 403 -> keep the first few of each kind and only count the rest
            return stats.byReason[reason]<=3;

        }

        async function plainRequest(url){

            const response=await fetch(url,{
                credentials:o.credentials,
                referrer:o.referrer,
                headers:{"Accept":o.accept}
            });

            return {
                status:response.status,
                url:response.url,
                header:name=>response.headers.get(name),
                text:()=>response.text()
            };

        }

        const send=o.request||plainRequest;

        // Retry-After is either a number of seconds or an HTTP date
        function retryAfter(response){

            const header=response.header&&response.header("retry-after");

            if(!header) return 0;

            const seconds=+header;

            if(seconds>0) return Math.min(gate.maxCooldown,seconds*1000);

            const when=Date.parse(header);

            return when?Math.min(gate.maxCooldown,Math.max(0,when-Date.now())):0;

        }

        // `tries` overrides the attempt budget - used by the recovery pass, where the URL has
        // already had the full ladder once and a second one would cost more than it is worth
        async function fetchDoc(url,opts){

            const settings=opts||{};

            // once the session is refused outright, retrying only makes the run longer, never better
            if(gate.dead) return null;

            if(settings.guard&&settings.guard(url)) return null;

            const attempts=settings.tries||o.maxAttempts;

            let transportFails=0;

            for(let attempt=1;attempt<=attempts;attempt++){

                if(gate.dead) break;

                // the wait lives BEFORE the request: that is the only place it can cap the send
                // rate. Waiting afterwards leaves the retries of a 429 completely unpaced.
                await gate.enter(settings.pace);

                let response;

                stats.requests++;

                try{
                    response=await send(url);
                }
                catch(e){

                    gate.leave();

                    stats.netErrors++;
                    transportFails++;

                    if(note("connection dropped")){
                        console.warn(o.log,`connection dropped (${transportFails}/${o.maxTransport})`,
                            url,e&&e.message||e);
                    }

                    // A rejected fetch is the connection dying, not an answer: it has no status and
                    // says nothing about pace, so it must not widen the gap or count as a block.
                    // ERR_QUIC_PROTOCOL_ERROR is the usual one - Chrome retires a broken h3 session
                    // after a few failures and falls back to TCP, which is exactly why retrying works.
                    if(transportFails<o.maxTransport&&attempt<attempts){

                        await sleep(o.transportPause*transportFails+Math.random()*300);

                        continue;

                    }

                    return null;

                }

                const status=response.status;

                answers.set(url,status);

                // the caller may want to inspect a refusal before we decide what it means
                // (a sign-in redirect, a Cloudflare challenge, a country wall)
                if(settings.inspect){

                    const verdict=settings.inspect(response,url,attempt);

                    if(verdict==="stop"){
                        gate.leave();
                        return null;
                    }

                }

                // 429/503 is pace. 403 is usually a bot check on the same lever. 5xx is the site
                // having a moment. All three clear by waiting, so all three go round again.
                if(status===429||status===503||(status===403&&o.retryForbidden)||status>=500){

                    gate.leave();

                    stats.refusals++;

                    const outcome=gate.penalize(retryAfter(response),attempt===1);

                    if(o.onRefused) o.onRefused(status,url,attempt,response);

                    if(note("HTTP "+status)){
                        console.warn(o.log,`HTTP ${status} - pausing ${Math.round(outcome.cool/1000)}s`
                            +` (gap ${Math.round(gate.gap)}ms, ${gate.limit} parallel)`,url);
                    }

                    if(outcome.dead) return null;

                    // The caller has a better answer than the rest of this ladder - a real
                    // navigation in a tab - and this refusal has already survived a retry. 403,
                    // 429 and 503 are all statuses a site picks for a request that did not look
                    // like a browser, and none of them are really about how fast we asked, so four
                    // more fetches and forty seconds of cooling off buy nothing but delay.
                    //
                    // canEscalate is asked every time rather than once: the moment the fallback is
                    // spent or unreachable the ladder becomes the only thing left, and it has to
                    // run in full instead of being cut short in favour of a tab that never opens.
                    if(o.canEscalate&&attempt>=o.escalateAfter&&o.canEscalate(url)){

                        gate.forgive(outcome);

                    if(note("handed to the tab fallback")){
                            console.warn(o.log,`HTTP ${status} on attempt ${attempt} - handing `
                                +"this one to the tab fallback instead of the rest of the ladder",url);
                        }

                        return null;

                    }

                    continue;

                }

                // 404/410/401 and friends: waiting changes nothing, so stop paying for it
                if(status<200||status>=300){

                    gate.leave();

                    stats.permanent++;

                    if(note("HTTP "+status)) console.warn(o.log,"HTTP",status,url);

                    return null;

                }

                let html;

                try{
                    html=await response.text();
                }
                catch(e){

                    gate.leave();

                    stats.netErrors++;

                    if(note("body never arrived")) console.warn(o.log,"body never arrived",url,e);

                    // the headers came back but the body did not: that is still a transport
                    // failure and still worth another go
                    if(attempt<attempts) continue;

                    return null;

                }

                gate.leave();
                gate.relax();

                if(settings.onOk) settings.onOk(response,html);

                return new DOMParser().parseFromString(html,"text/html");

            }

            gate.deadEnds++;
            stats.deadEnds++;

            console.warn(o.log,`gave up after ${attempts} attempt(s)`,url);

            return null;

        }

        // dedupe by URL: the same page is never fetched twice, and a page already in flight is
        // shared. A FAILED result is evicted on purpose - caching null means a company whose page
        // was refused once during a bad minute is never read again, even on a second pass.
        const cache=new Map();

        function fetchDocCached(url,opts){

            if(cache.has(url)) return cache.get(url);

            const pending=fetchDoc(url,opts).then(doc=>{

                if(!doc) cache.delete(url);

                return doc;

            },e=>{

                cache.delete(url);

                throw e;

            });

            cache.set(url,pending);

            return pending;

        }

        function describe(){

            const parts=Object.keys(stats.byReason)
                .sort((a,b)=>stats.byReason[b]-stats.byReason[a])
                .map(reason=>`${stats.byReason[reason]}x ${reason}`);

            return parts.length?parts.join(", "):"";

        }

        // undefined when nothing ever answered - a dropped connection, or a session the gate had
        // already written off before the request went out
        function lastStatus(url){
            return answers.get(url);
        }

        return {fetchDoc,fetchDocCached,stats,describe,cache,lastStatus};

    }

    //---------------------------------------------------
    // run in parallel with a cap, and give the failures a second chance
    //
    // The retry pass is the point. A company whose page was refused at the busiest moment of the
    // run is almost always readable once the queue has drained - and the alternative is an empty
    // cell in the file that looks exactly like "this company has no size".
    //---------------------------------------------------

    async function mapPool(items,limit,worker,options){

        const o=Object.assign({retries:1,shouldRetry:null,onRetryPass:null,log:"[crawler]"},options||{});

        async function pass(list){

            let next=0;

            const runners=[];

            for(let i=0;i<Math.min(limit,list.length);i++){

                runners.push((async()=>{

                    for(;;){

                        const index=next++;

                        if(index>=list.length) return;

                        // one failing item must not kill the whole worker
                        try{
                            await worker(list[index].item,list[index].index);
                        }
                        catch(e){
                            console.warn(o.log,"worker failed for item",list[index].index,e);
                        }

                    }

                })());

            }

            await Promise.all(runners);

        }

        let queue=items.map((item,index)=>({item,index}));

        await pass(queue);

        if(!o.shouldRetry) return;

        for(let round=0;round<o.retries;round++){

            const again=queue.filter(entry=>o.shouldRetry(entry.item,entry.index));

            if(!again.length) return;

            if(o.onRetryPass) o.onRetryPass(again.length,round+1);

            queue=again;

            await pass(queue);

        }

    }

    //---------------------------------------------------
    // walk a known list of pages, in order, without a barrier
    //
    // The batch pattern this replaces - Promise.all over a slice, then the next slice - costs the
    // time of the SLOWEST page in every batch. Here the pool keeps `limit` pages in flight at all
    // times while the main loop consumes them strictly in page order, so parsing stays
    // deterministic (the file comes out in the same order every run) and no worker ever idles
    // waiting for a straggler. Memory stays bounded at limit+1 parsed documents.
    //
    // Pages that never came back are returned, not swallowed: the caller retries them at the end,
    // when whatever was refusing them has had the whole rest of the run to cool off.
    //---------------------------------------------------

    async function pipelinePages(pages,fetchOne,onDoc,options){

        const o=Object.assign({limit:4,log:"[crawler]"},options||{});

        const inflight=new Map();

        const start=index=>{

            if(index>=pages.length||inflight.has(index)) return;

            inflight.set(index,Promise.resolve().then(()=>fetchOne(pages[index],index)).catch(e=>{

                console.warn(o.log,"page fetch threw",pages[index],e);

                return null;

            }));

        };

        for(let i=0;i<Math.min(o.limit,pages.length);i++) start(i);

        const missed=[];

        let stopped=false;

        for(let i=0;i<pages.length;i++){

            const pending=inflight.get(i);

            inflight.delete(i);

            const doc=pending?await pending:null;

            // keep the window full: the next page starts the moment this one is consumed
            start(i+o.limit);

            if(!doc) missed.push(pages[i]);

            const verdict=await onDoc(pages[i],doc,i);

            if(verdict==="stop"){
                stopped=true;
                break;
            }

        }

        // anything still in flight was speculative lookahead past an early stop
        inflight.clear();

        return {missed,stopped};

    }

    //---------------------------------------------------
    // walk pages one at a time when the next URL can only be read off the page just fetched
    //
    // The rule that matters: losing one page must not lose every page behind it. The next URL
    // normally comes out of the page we just failed to read, so without a way to guess it the run
    // ends there - at page 27 of 60, throwing away two thirds of the list over one busy moment.
    // `guessNext` is that way out; the page is remembered and retried at the end.
    //---------------------------------------------------

    async function walkPages(options){

        const o=Object.assign({
            first:"",
            fetchDoc:null,
            onDoc:null,
            nextOf:null,
            guessNext:null,
            maxPages:100,
            maxMisses:3,
            recoveryTries:2,
            report:()=>{},
            log:"[crawler]"
        },options||{});

        // every URL already asked for, so a page that links back to itself or to an earlier one
        // cannot put the loop in a circle
        const seen=new Set();
        const missed=[];

        let url=o.first;
        let pages=1;
        let misses=0;
        let rounds=0;
        let reason="end";

        // the miss path can advance without pages++, so the loop needs its own stop
        while(url&&pages<o.maxPages&&rounds++<o.maxPages*2){

            if(seen.has(url)){
                console.warn(o.log,"pagination pointed back at a page already read - stopping");
                reason="loop";
                break;
            }

            seen.add(url);

            const doc=await o.fetchDoc(url);

            if(!doc){

                const next=o.guessNext?o.guessNext(url):"";

                if(++misses>=o.maxMisses||!next){
                    reason="blocked";
                    break;
                }

                missed.push(url);

                console.warn(o.log,"a page did not come back - stepping over it to",next);

                url=next;

                continue;

            }

            misses=0;

            const verdict=await o.onDoc(doc,url,pages+1);

            pages++;

            if(verdict==="stop"){
                reason="empty";
                break;
            }

            url=o.nextOf(doc,url);

        }

        if(url&&pages>=o.maxPages) reason="limit";

        // Second pass over the pages that were stepped over. The rate limit that cost them has had
        // the whole rest of the list to cool off by now, so a page skipped at 48 of 62 usually
        // comes back on the way out - which is the difference between 61 pages and all 62.
        let recovered=0;

        if(missed.length){

            o.report(`Retrying ${missed.length} page(s) that were skipped...`);

            for(const retry of missed){

                const doc=await o.fetchDoc(retry,{tries:o.recoveryTries});

                if(!doc) continue;

                await o.onDoc(doc,retry,0);

                pages++;
                recovered++;

            }

        }

        return {pages,reason,skipped:missed.length-recovered,recovered};

    }

    //---------------------------------------------------
    // the same URL one page further on, for sites whose pagination is a plain ?page= counter.
    // Reading the next link off the page is always preferred; this is only the way to step over a
    // page that never arrived.
    //---------------------------------------------------

    function bumpParam(url,param,step,origin){

        try{

            const next=new URL(url,origin||location.origin);

            const here=+next.searchParams.get(param)||0;

            next.searchParams.set(param,String(here+(step||1)));

            return next.toString();

        }
        catch(e){
            return "";
        }

    }

    function paramOf(url,param,origin){

        try{
            return +new URL(url,origin||location.origin).searchParams.get(param)||0;
        }
        catch(e){
            return 0;
        }

    }

    //---------------------------------------------------
    // company name grouping
    //
    // "ACME Pte Ltd", "ACME Pte. Ltd." and "Acme  Pte Ltd" are one employer and used to become
    // three rows, each with a third of the positions. Normalisation is deliberately conservative:
    // only punctuation, case, whitespace and a closed list of legal-form suffixes are removed, so
    // "Acme Tech" and "Acme Technologies" still stay apart.
    //---------------------------------------------------

    const LEGAL=/\b(?:pte\.?|pty\.?|ltd\.?|limited|llc|l\.l\.c\.|inc\.?|incorporated|corp\.?|corporation|co\.?|company|gmbh|mbh|ag|kg|ohg|ug|bv|b\.v\.|nv|n\.v\.|sa|s\.a\.|srl|s\.r\.l\.|spa|s\.p\.a\.|plc|sdn\.?|bhd\.?|kk|k\.k\.|oy|ab|as|a\/s|aps|holdings?|group)\b/g;

    function nameKey(name){

        const clean=(name||"")
            .toLowerCase()
            .replace(/\(.*?\)/g," ")
            .replace(/[‘’“”]/g,"'")
            .replace(/[.,]/g," ")
            .replace(/\s+/g," ")
            .trim()
            .replace(LEGAL," ")
            .replace(/[^\p{L}\p{N}]+/gu," ")
            .replace(/\s+/g," ")
            .trim();

        // stripping everything left nothing recognisable ("Ltd." on its own) -> keep the original,
        // because merging every such row into one would be far worse than not merging at all
        return clean||(name||"").toLowerCase().trim();

    }

    //---------------------------------------------------
    // the tab fallback
    //
    // When a site answers a fetch() with 429/503/403/5xx it is often not saying "too fast" - it is
    // saying "that did not look like a browser". A fetch from a content script carries no
    // navigation behind it: no document, no Sec-Fetch-Mode: navigate, no chance to run the
    // JavaScript a managed challenge asks for. Cloudflare and friends score it accordingly, and no
    // amount of waiting changes the answer - which is why a run could sit out its whole cooldown
    // budget and still come away with nothing.
    //
    // The same URL opened as a real top level navigation carries the entire browser with it, and
    // normally comes straight back. So that is the fallback: hand the refused URL to tabs.js,
    // which opens it, waits, lifts the HTML out and closes the tab again. If the challenge is one
    // only a person can clear, the tab is brought to the front and the user clears it - once, for
    // the whole site, after which the cheap path works again for the rest of the run.
    //
    // A content script cannot open tabs, which is the only reason the service worker exists.
    //---------------------------------------------------

    function makeTabFallback(options){

        const o=Object.assign({

            // How much of a refused run is worth rescuing this way. A tab load is a few seconds
            // and they cannot run in parallel, so this is a time budget as much as a page budget.
            budget:80,

            // How many pages in a row must have needed a tab before the cheap path stops being
            // tried first. Past that the retry ladder in front of every page is pure delay,
            // because none of them come back.
            preferAfter:3,

            // ...and how many tab reads later the cheap path is re-tested, so a block that has
            // since lifted is noticed instead of being paid for until the end of the run
            recheck:10,

            // How many times a run may take the window away from the person using it. A tab that
            // steals focus is expensive to them, so this is deliberately small: one solved
            // challenge sets a cookie for the whole site and the cheap path works again.
            askLimit:2,

            // told the outcome, so the caller can react (a sign-in wall is not a bot check)
            inspect:null,

            // a URL the caller knows a tab cannot help with
            worthIt:null,

            lastStatus:null,

            // How many times a message to the service worker may go unanswered before it is
            // treated as genuinely absent rather than merely asleep. See wake() below.
            workerTries:3,
            workerWake:250,

            describe:url=>url,
            report:()=>{},
            log:"[crawler]"

        },options||{});

        // 404/410 mean the page is not there, and a tab renders the same "not found" more slowly.
        // Only a refusal is worth reopening - that is the one a real navigation answers differently.
        function refusal(status){
            return status===429||status===503||status===403||status>=500;
        }

        // Ask the service worker, allowing for the fact that it may not be running.
        //
        // MV3 shuts a worker down whenever it goes idle, and the FIRST tab of a run comes after a
        // long stretch of nothing but fetches - so it very often lands exactly in the window where
        // the worker is booting and sendMessage rejects with "Could not establish connection.
        // Receiving end does not exist." That is transient: the same message a moment later is
        // delivered to the worker Chrome just started.
        //
        // This used to be one attempt whose rejection was marked `fatal`, which switched the whole
        // fallback off for the rest of the run on a race that resolves itself in ~200ms. A run that
        // could have rescued sixty pages rescued none, and said nothing about why.
        async function wake(message){

            let last="";

            for(let attempt=1;attempt<=o.workerTries;attempt++){

                try{

                    const reply=await chrome.runtime.sendMessage(message);

                    if(reply) return reply;

                    last="the worker accepted the message but answered nothing";

                }
                catch(e){
                    last=e&&e.message||String(e);
                }

                if(attempt<o.workerTries){

                    console.warn(o.log,`the background worker did not answer `
                        +`(${attempt}/${o.workerTries}) - ${last}`);

                    await sleep(o.workerWake*attempt);

                }

            }

            // it was given every chance and is genuinely not there
            return {ok:false,error:last,fatal:true};

        }

        return {

            used:0,
            ok:0,
            failed:0,
            solved:0,
            asked:0,
            streak:0,

            // "" while usable, otherwise why it stopped - the summary has to be able to say which
            off:"",

            // Latching it here rather than at the point of use is what makes the stop audible.
            // The budget was previously only noticed inside get(), which worthIt() had already
            // short-circuited past - so the fallback quietly went dormant and the summary went on
            // reporting a tidy "3/3 rescued" while everything after that point was missing.
            // Switching the fallback off is the moment a run quietly stops being able to recover,
            // so it is never done silently. It used to be: `off` was set, one console.warn was
            // written, and the next eighty refusals produced no output at all - which reads from
            // the console exactly like the fallback was never wired up.
            stop(reason){

                if(this.off) return;

                this.off=reason;

                if(reason==="budget"){

                    o.report(`Tab fallback used up its ${o.budget} page budget - anything refused `
                        +"from here on will be missing from the file.");

                    return;

                }

                o.report("The tab fallback cannot reach this extension's background worker, so "
                    +"refused pages can no longer be reopened. Open chrome://extensions, reload "
                    +"the extension, and run again.");

            },

            get available(){
                return !this.off&&this.used<o.budget;
            },

            // every recent page has needed a tab, so try it first and skip the ladder
            get preferred(){
                return this.streak>=o.preferAfter;
            },

            // a cheap fetch came back: the block may have lifted
            clean(){
                this.streak=0;
            },

            worthIt(url){

                if(this.off) return false;

                if(this.used>=o.budget){

                    this.stop("budget");

                    return false;

                }

                if(o.worthIt&&!o.worthIt(url)) return false;

                // A ternary, not `o.lastStatus&&o.lastStatus(url)`: that yields null rather than
                // undefined when no lookup was supplied, which failed the "nothing ever answered"
                // test below and quietly refused to open a tab for anyone who did not pass one.
                const status=o.lastStatus?o.lastStatus(url):undefined;

                // no status at all means nothing ever answered - a dropped connection, or a
                // session the gate had already written off. Both are worth a real navigation.
                return status===undefined||refusal(status);

            },

            // Called once before a crawl starts. Two jobs: wake the worker, so the first real
            // refusal is not also a cold start, and say early - rather than after twenty refused
            // pages - if there is no worker to wake.
            //
            // A failed ping deliberately does NOT switch the fallback off. This is a diagnostic,
            // not a verdict: an older worker may not answer "tab:ping" at all, and a ping can lose
            // the same start-up race a fetch would have survived. The fallback is only given up on
            // when a real page request has exhausted its retries, in get() below.
            async ready(){

                if(this.off) return false;

                const reply=await wake({type:"tab:ping"});

                if(reply&&reply.ok) return true;

                o.report("Could not reach this extension's background worker, so refused pages may "
                    +"not be reopenable. If that happens, open chrome://extensions, reload the "
                    +"extension, and run again.");

                return false;

            },

            async get(url){

                if(this.off) return null;

                if(this.used>=o.budget){

                    this.stop("budget");

                    return null;

                }

                this.used++;

                // Only interrupt the person when the automatic path has nothing left to try, and
                // only a couple of times a run.
                //
                // The quota is CLAIMED here, before the await, not counted from the replies. Every
                // crawler runs this from a pool, so with parallel=6 all six workers reached a
                // refusal in the same tick, all six read `asked` as 0, and all six were told they
                // could ask - turning askLimit:2 into six tabs taking the window in turn. Reading
                // a limit before an await and updating it after is only ever right at parallel=1.
                const letUserSolve=this.asked<o.askLimit;

                if(letUserSolve) this.asked++;

                o.report(`Refused - reopening ${o.describe(url)} in a tab (${this.used}/${o.budget})`);

                const reply=await wake({type:"tab:fetch",url,letUserSolve});

                // the page loaded without needing anyone, so hand the claim back rather than
                // spending a run's whole interruption budget on tabs that never interrupted
                if(letUserSolve&&!(reply&&reply.askedUser)) this.asked--;

                if(!reply||!reply.ok){

                    this.failed++;

                    console.warn(o.log,"tab fallback failed:",reply&&reply.error||"no reply from the worker");

                    // no worker, or tabs cannot be opened at all: every later attempt fails the
                    // same way, and each one costs a wasted round trip
                    if(!reply||reply.fatal) this.stop("broken");

                    else if(reply.challenged&&reply.askedUser){

                        o.report("The check in the tab was not cleared, so the pages behind it "
                            +"cannot be read. Open the site in a normal tab, clear it by hand, "
                            +"then run again.");

                    }

                    return null;

                }

                this.ok++;
                this.streak++;

                if(reply.solvedByUser){

                    this.solved++;

                    // the cookie that check just set covers the whole site, so the cheap path is
                    // worth trying again immediately rather than after another `recheck` tabs
                    this.streak=0;

                    o.report("Thanks - that check is cleared for the whole site, carrying on.");

                }

                // re-test the cheap path now and then: whatever was refusing fetches may have
                // stopped, and a fetch is an order of magnitude cheaper than a tab load
                if(this.streak>=o.preferAfter+o.recheck) this.streak=0;

                return reply;

            },

            // the same thing, parsed, so callers can drop it straight in where a fetch went
            async fetchDoc(url){

                if(!this.worthIt(url)) return null;

                const reply=await this.get(url);

                if(!reply) return null;

                if(o.inspect&&o.inspect(reply,url)==="stop") return null;

                return new DOMParser().parseFromString(reply.html,"text/html");

            },

            describe(){

                if(!this.used&&!this.off) return "";

                return `Tabs: ${this.ok}/${this.used} page(s) rescued by reopening them`
                    +(this.solved?`, ${this.solved} after you cleared a check`:"")
                    +(this.failed?`, ${this.failed} failed`:"")
                    +(this.off==="budget"?" - budget spent":"")
                    +(this.off==="broken"?" - the tab worker never answered":"");

            }

        };

    }

    // Read a page the cheap way, and only if that is refused, the way a person would.
    async function tabFirst(fetcher,tabs,url,opts){

        // Every recent page has needed a tab, so the ladder in front of this one would only be
        // delay. The gate is not consulted here: once it writes the session off, fetchDoc returns
        // immediately, which is already the fast path we want.
        if(tabs.preferred){

            const early=await tabs.fetchDoc(url);

            if(early) return early;

        }

        const doc=await fetcher.fetchDoc(url,opts);

        if(doc){

            tabs.clean();

            return doc;

        }

        // refused, dead connection, or the gate gave up on fetches altogether. A real navigation
        // is a different proposition entirely.
        return tabs.fetchDoc(url);

    }

    //---------------------------------------------------
    // the headcount, and how much it is worth
    //
    // "51 to 200 employees" sitting next to a field labelled "Company size" is a fact. The same
    // string found by running the same regex over the whole <body> is a guess - "join our team of
    // 200 employees" in an advert reads identically, and it lands in the file looking just as
    // authoritative as the real thing. That is worse than an empty cell, because nothing
    // downstream can tell the two apart, and it was happening on five of the seven crawlers.
    //
    // So the search runs in two bounded steps and never over the whole document:
    //   "label" - a text block that IS a size label, with the value in the very next block
    //   "near"  - a leaf element whose text is MOSTLY the value ("501-1000 Employees" on its own)
    // and it reports which of the two answered, so the summary can say how much of the column is
    // fact and how much is inference.
    //
    // There is deliberately no third step. A whole-body scan is the thing this replaces.
    //---------------------------------------------------

    const SIZE_SCOPE="li,tr,td,dd,dt,p,span,div,section,article";

    function headcount(root,options){

        const o=Object.assign({
            // anchored: matched against one whole text block, e.g. /^(?:company size|size)$/i
            label:null,
            // the value itself, e.g. /\d[\d.,]*\s*(?:to|-)\s*\d[\d.,]*\s*employees?/i
            value:null,
            scope:SIZE_SCOPE,
            // an element longer than this is a section, not a field
            maxLen:160
        },options||{});

        if(!root||!o.value) return {text:"",source:""};

        const elements=root.querySelectorAll(o.scope);

        // 1. label + the next text block. Nothing else can produce that pairing, so it is taken
        //    at face value - including values the regex below would not recognise.
        if(o.label){

            for(const el of elements){

                const parts=blocks(el);

                // a container wrapping half the page pairs a label with whatever text happens to
                // follow it several sections later
                if(parts.length>12) continue;

                for(let i=0;i+1<parts.length;i++){

                    if(o.label.test(parts[i])&&parts[i+1]){
                        return {text:parts[i+1].replace(/\s+/g," ").trim(),source:"label"};
                    }

                }

            }

        }

        // 2. a leaf element that is mostly the value. The half-length rule is what separates
        //    "501-1000 Employees" in its own span from "Join our team of 200 employees" in an
        //    advert: the first IS the field, the second only mentions a number.
        for(const el of elements){

            if(el.querySelector(o.scope)) continue;

            const text=blocks(el).join(" ");

            if(!text||text.length>o.maxLen) continue;

            const match=text.match(o.value);

            if(match&&match[0].length*2>=text.length){
                return {text:match[0].replace(/\s+/g," ").trim(),source:"near"};
            }

        }

        return {text:"",source:""};

    }

    // One line for the summary, over rows carrying an `employeesSource`. Without it the column is
    // a number with no provenance and no way to audit it; with it a run says out loud how much of
    // the column is a labelled field and how much is inference.
    function describeSizes(rows){

        let label=0;
        let near=0;
        let blank=0;

        for(const row of rows||[]){

            const source=row&&row.employeesSource;

            if(source==="label") label++;
            else if(source==="near") near++;
            else blank++;

        }

        if(!label&&!near) return "";

        return `Employees: ${label+near} read (${label} from a labelled field, `
            +`${near} from an unlabelled element), ${blank} blank`;

    }

    //---------------------------------------------------
    // the checkpoint
    //
    // A content script dies instantly when the tab navigates - no catch block runs, no file is
    // written, and an hour of crawling is gone. Writing the collected rows to storage every few
    // seconds means the next run can pick them back up instead.
    //---------------------------------------------------

    function makeCheckpoint(key,options){

        const o=Object.assign({every:5000,ttl:6*60*60*1000,log:"[crawler]"},options||{});

        let lastAt=0;
        let pending=null;

        return {

            // cheap to call from the collect loop: it only writes when `every` has elapsed
            async save(payload,force){

                const now=Date.now();

                if(!force&&now-lastAt<o.every) return;

                lastAt=now;

                try{

                    pending=chrome.storage.local.set({[key]:{
                        at:now,
                        href:location.href,
                        payload
                    }});

                    await pending;

                }
                catch(e){
                    console.warn(o.log,"could not write the checkpoint",e);
                }

            },

            // returns the payload of an unfinished run on the same search, or null
            async load(){

                try{

                    const stored=await chrome.storage.local.get(key);
                    const entry=stored[key];

                    if(!entry) return null;

                    if(Date.now()-(entry.at||0)>o.ttl) return null;

                    // a checkpoint from a different search would silently mix two result sets
                    if(entry.href!==location.href) return null;

                    return entry.payload||null;

                }
                catch(e){

                    console.warn(o.log,"could not read the checkpoint",e);

                    return null;

                }

            },

            async clear(){

                try{
                    await chrome.storage.local.remove(key);
                }
                catch(e){}

            }

        };

    }

    //---------------------------------------------------
    // the file
    //
    // Written through a blob + anchor rather than XLSX.writeFile so a download error surfaces in
    // the console instead of failing silently, and every cell is clipped: one company with 900
    // positions past Excel's 32,767 character ceiling produces a file that will not open at all.
    //---------------------------------------------------

    function clip(value,limit){

        if(typeof value!=="string") return value;

        const max=limit||CELL_LIMIT;

        if(value.length<=max) return value;

        return value.slice(0,max-20)+" ...[truncated]";

    }

    function exportXlsx(rows,options){

        const o=Object.assign({
            headers:null,
            widths:null,
            sheet:"Companies",
            filename:"export.xlsx",
            log:"[crawler]"
        },options||{});

        if(typeof XLSX==="undefined") throw new Error("XLSX is not loaded in this tab");

        let clipped=0;

        const safe=rows.map(row=>{

            const out={};

            for(const key of Object.keys(row)){

                const value=row[key];

                if(typeof value==="string"&&value.length>CELL_LIMIT) clipped++;

                out[key]=clip(value);

            }

            return out;

        });

        const ws=XLSX.utils.json_to_sheet(safe,o.headers?{header:o.headers}:undefined);

        if(o.widths) ws["!cols"]=o.widths.map(w=>({wch:w}));

        const wb=XLSX.utils.book_new();

        XLSX.utils.book_append_sheet(wb,ws,o.sheet);

        const buffer=XLSX.write(wb,{bookType:"xlsx",type:"array"});

        const blob=new Blob([buffer],{
            type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        });

        const url=URL.createObjectURL(blob);

        const a=document.createElement("a");

        a.href=url;
        a.download=o.filename;
        a.style.display="none";

        document.body.appendChild(a);
        a.click();
        a.remove();

        setTimeout(()=>URL.revokeObjectURL(url),60000);

        if(clipped) console.warn(o.log,`${clipped} cell(s) were longer than Excel allows and were truncated`);

        return {rows:safe.length,clipped};

    }

    //---------------------------------------------------
    // status back to the popup (it may already be closed -> swallow the error)
    //---------------------------------------------------

    function makeReporter(type,log){

        return function(text){

            console.log(log,text);

            try{
                chrome.runtime.sendMessage({type,text}).catch(()=>{});
            }
            catch(e){}

        };

    }

    return {
        VERSION,
        CELL_LIMIT,
        sleep,
        norm,
        pick,
        blocks,
        clip,
        makeGate,
        makeFetcher,
        mapPool,
        pipelinePages,
        walkPages,
        bumpParam,
        paramOf,
        nameKey,
        makeTabFallback,
        tabFirst,
        headcount,
        describeSizes,
        makeCheckpoint,
        exportXlsx,
        makeReporter
    };

})();
