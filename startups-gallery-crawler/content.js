(async()=>{

    const LOG="[sg-crawler]";

    //---------------------------------------------------
    // guard against double runs when the button is clicked repeatedly
    //---------------------------------------------------

    if(window.__sgCrawlerRunning){
        alert("Crawler is already running on this tab. Wait for it to finish.");
        return;
    }

    window.__sgCrawlerRunning=true;

    const core=window.CrawlerCore;

    if(!core){

        alert("core.js is not loaded in this tab. popup.js must inject core.js before content.js.");

        window.__sgCrawlerRunning=false;

        return;

    }

    //---------------------------------------------------
    // selectors
    //
    // Framer hashes every class name per build - "framer-1m313x7" is this deploy's Post and next
    // deploy's something else - so nothing here reads a class. What it reads instead are the
    // design-time names Framer emits as data-framer-name, the hrefs (which are routes, not
    // styling), and <time datetime>, which is the only element on the row that says what it is.
    //---------------------------------------------------

    const POST='[data-framer-name="Post"]';

    const AMOUNT='[data-framer-name="Amount"]';

    const COMPANY_LINK='a[href*="/companies/"]';

    const INVESTOR_LINK='a[href*="/investors/"]';

    const CATEGORY_LINK='a[href*="/categories/"]';

    const SOURCE_LINK='a[data-framer-name="Source"]';

    // the press link, when data-framer-name is not there to name it
    const EXTERNAL_LINK='a[target="_blank"]';

    //---------------------------------------------------
    // patterns
    //---------------------------------------------------

    // the Load More control carries no id, no role and no stable class - only its own label
    const LOAD_MORE=/^load\s*more$/i;

    // which constructor each event type needs. A PointerEvent dispatched as a plain Event has no
    // pointerId and no isPrimary, and framer-motion drops it.
    const POINTER_EVENT=/^pointer/;

    const MOUSE_EVENT=/^(?:mouse|click|dbl)/;

    // "$45M · Series B" - amount and stage in one cell, split by a middle dot. The glyph has
    // changed on other sites in this folder before, so accept the family rather than the one.
    const CELL_SEP=/\s*[·•∙●|–—]\s*/;

    const MONEY=/^[$€£¥]\s?[\d.,]+\s*[KMB]?$/i;

    // the employees pill: a bare "11–50" or "1000+" with no word next to it, because the label is
    // an icon. Anchored at BOTH ends - this is matched against a whole cell, and an unanchored
    // version of it matches the "11" in a press headline.
    const EMPLOYEES=/^\d[\d,]*(?:\s*[-–—]\s*\d[\d,]*|\s*\+)?$/;

    // "Raised $45M Series B on August 12, 2026"
    const RAISED=/^raised\s+[$€£¥]/i;

    // "Logo of Peak XV" - the alt text on an investor logo, and the only place a company page
    // spells an investor's name rather than its slug
    const LOGO_ALT=/^logo\s+of\s+/i;

    // shortest paragraph worth treating as the company description. Every pill, button and label
    // on the page is well under it, which is what makes "the first long paragraph" safe.
    const DESC_MIN=40;

    // the site's own boilerplate, appended to every meta description - dropped when the meta tag
    // is used as the fallback, because it says nothing about this company
    const META_TAIL=/\s*Find top early-stage startups.*$/i;

    //---------------------------------------------------
    // pacing and limits
    //---------------------------------------------------

    // The pace floor is zero on purpose: nothing is paid until startups.gallery actually pushes
    // back. The gate below widens the moment anything is refused.
    const MIN_GAP=0;

    // how long one Load More click has to produce new rows before the click is called a no-op
    const BATCH_TIMEOUT=12000;

    // ...and how long the DOM has to stay still after the last mutation before the batch is read.
    // Framer re-renders the whole list rather than appending to it, so a read taken mid-render
    // sees fewer rows than a read taken after it.
    const BATCH_SETTLE=350;

    // belt and braces behind the MutationObserver, for a batch that lands with no mutation the
    // observer is watching (a swapped-in subtree with the same shape)
    const BACKSTOP_POLL=500;

    // clicks in a row that added no rows before the feed is called finished. Two, not one: the
    // button no-ops while it is off screen, and a rate limited request behind it comes back empty
    // once and works on the retry.
    const STUCK_LIMIT=3;

    // hard ceiling on clicks when the popup leaves "max clicks" blank, so a feed that never stops
    // serving cannot run forever
    const CLICK_CEILING=400;

    const gate=core.makeGate({minGap:MIN_GAP,limit:6,log:LOG});

    const fetcher=core.makeFetcher(gate,{
        log:LOG,

        // Two refusals in a row are answered by a real navigation rather than by the rest of the
        // ladder - but only while there is a tab left to open. See core.makeFetcher.
        canEscalate:()=>tabs.available
    });

    // A company page is ~390KB and three quarters of it is the inline stylesheet in <head> and the
    // site's own category directory in the footer. Everything read below sits between <body> and
    // the jobs feed - about 37KB. DOMParser runs on the crawl's own main thread, so at parallel 6
    // the parses queue rather than overlap, and on a feed of several hundred companies this cut is
    // most of the detail phase's wall clock.
    const cheap=(url,opts)=>fetcher.fetchDoc(url,Object.assign({
        slice:sliceCompany,
        sliced:hasCompanyHeader
    },opts||{}));

    const tabs=core.makeTabFallback({
        log:LOG,
        report:text=>report(text),
        lastStatus:fetcher.lastStatus,
        describe:url=>url.replace(/^https?:\/\/[^/]+\/companies\//,"")
    });

    const fetchDoc=(url,opts)=>core.tabFirst({fetchDoc:cheap},tabs,url,opts);

    const report=core.makeReporter("sg-crawler-status",LOG);

    const norm=core.norm;

    // kept outside the try: the helpers at the end of the file are hoisted and run from inside it,
    // so anything they close over has to be initialised before the try block starts
    const rounds=[];
    const seenRounds=new Set();

    // slug -> display name, learned from the feed rows. A company page prints its investors as
    // logos and only about half of them carry an alt attribute, so the feed - where every lead
    // investor is spelled out in full - is what teaches the rest their names.
    const investorNames=new Map();

    const stats={
        posts:0,           // feed rows seen, including ones already read on an earlier batch
        dupes:0,           // the same round seen twice -> dropped
        noCompanyLink:0,   // row with no /companies/ anchor -> name read off the row instead
        noAmount:0,
        noDate:0,
        noSource:0
    };

    const startedAt=performance.now();

    // A tab navigation kills the content script outright - no catch block runs and nothing is
    // written. The checkpoint turns that from "the whole run is gone" into "the next run starts
    // where this one stopped", which on this site matters more than most: the feed has no page
    // URLs, so a run that dies at click 40 cannot be resumed by asking for page 41.
    const checkpoint=core.makeCheckpoint("sgCheckpoint",{log:LOG});

    // set the moment the file is handed to the browser, so the crash path can never write a second one
    let fileWritten=false;

    let resumed=0;

    // which gesture the button actually answered. Worth carrying into the summary: this control
    // is the entire paginator, and the gesture it listens for is the thing most likely to change
    // under the crawler without anything looking broken.
    let pressedWith="";

    let dumpedRow=false;

    try{

        //---------------------------------------------------
        // 1. settings + where we are
        //---------------------------------------------------

        const settings=await chrome.storage.local.get(["maxClicks","details","concurrency"]);

        const maxClicks=Math.max(0,parseInt(settings.maxClicks,10)||0);
        const wantDetails=settings.details!==false;
        const concurrency=Math.min(12,Math.max(1,parseInt(settings.concurrency,10)||4));

        if(!/\/news/.test(location.pathname)){
            console.warn(LOG,"this does not look like https://startups.gallery/news -"
                +" reading whatever funding rows are on the page anyway");
        }

        report("Reading the feed...");

        //---------------------------------------------------
        // 2. resume an unfinished run
        //---------------------------------------------------

        const saved=await checkpoint.load();

        if(saved&&saved.rounds&&saved.rounds.length){

            for(const round of saved.rounds){

                if(!round||seenRounds.has(round.key)) continue;

                seenRounds.add(round.key);
                rounds.push(round);

            }

            resumed=rounds.length;

            if(resumed) console.log(LOG,`resumed ${resumed} round(s) from an unfinished run`);

        }

        //---------------------------------------------------
        // 3. walk the feed by clicking "Load More"
        //
        // There is no page URL to walk. ?page=2 and ?skip=50 both answer 200 with the SAME first
        // 50 rows, so a crawler that trusted either would have written the first page over and
        // over and called it a complete run. The button is the only paginator this feed has.
        //---------------------------------------------------

        const feed=await walkFeed(maxClicks);

        console.log(LOG,`read ${feed.batches} batch(es), clicked Load More ${feed.clicks} time(s),`
            +` ${rounds.length} funding round(s)`);

        if(!rounds.length){

            alert("No funding rows found on this page.\n\nOpen https://startups.gallery/news and run it there.");

            window.__sgCrawlerRunning=false;

            return;

        }

        await checkpoint.save({rounds},true);

        //---------------------------------------------------
        // 4. one company page per company, however many rounds it has
        //
        // Location, Employees, Description and the full investor list are on the company page and
        // nowhere on the row. A company that raised twice is two rows in the file and one request
        // here, which on a long feed is most of the requests saved.
        //---------------------------------------------------

        const companies=new Map();

        for(const round of rounds){

            if(!round.companyUrl) continue;

            if(!companies.has(round.companyUrl)){
                companies.set(round.companyUrl,{url:round.companyUrl,name:round.company,detail:null});
            }

        }

        const list=Array.from(companies.values());

        let fetched=0;
        let failedDetail=0;

        if(wantDetails&&list.length){

            report(`Reading ${list.length} company page(s)...`);

            // Size the tab budget to the work in front of it now that the list is known. The
            // default is a flat 80, which on a feed of several hundred companies decides the
            // export rather than rescuing it: once a challenge starts refusing plain requests,
            // EVERY company needs a tab, and the ones past the budget get neither.
            tabs.setLimit(concurrency);
            tabs.setBudget(list.length);

            // wakes the MV3 worker, so the first refusal is not also a cold start
            await tabs.ready();

            await core.mapPool(list,concurrency,async(company,index)=>{

                const doc=await fetchDoc(company.url);

                fetched++;

                if(!doc){

                    failedDetail++;
                    company.failedFetch=true;

                }
                else{

                    company.detail=readCompany(doc,index===0);
                    company.failedFetch=false;

                }

                report(`[${fetched}/${list.length}] ${company.name}`);

            },{
                log:LOG,
                retries:1,

                // A page refused at the busiest moment of the run is usually readable once the
                // queue has drained, and a blank Location is indistinguishable from a company
                // that publishes none.
                shouldRetry:company=>company.failedFetch===true
            });

        }
        else if(!wantDetails){
            console.log(LOG,"company pages are switched off in the popup -"
                +" Location, Employees, Description and Investors will be blank");
        }

        //---------------------------------------------------
        // 5. build the rows and write the file
        //---------------------------------------------------

        const results=rounds.map(round=>buildRow(round,companies.get(round.companyUrl)));

        finish({
            results,
            companies:list,
            feed,
            fetched,
            failedDetail,
            wantDetails,
            crashed:null
        });

    }
    catch(e){

        console.error(LOG,"crawl aborted:",e);

        // Everything collected up to the crash is real data, and on this site it is expensive
        // data: the feed cannot be re-entered part way, so throwing it away means clicking Load
        // More from the top all over again.
        salvage(e);

    }
    finally{

        window.__sgCrawlerRunning=false;

    }

    //---------------------------------------------------
    // helper: click Load More until the feed is exhausted
    //
    // Every batch is READ before the next click, so a batch that was still rendering when it was
    // read is picked up by the round after it - except the last, which is why the loop reads once
    // more after it has decided the feed is over.
    //---------------------------------------------------

    async function walkFeed(maxClicks){

        const ceiling=maxClicks||CLICK_CEILING;

        let clicks=0;
        let batches=0;
        let stuck=0;
        let stoppedEarly=false;
        let reason="the Load More button was gone";

        for(;;){

            const found=collectFrom(document);

            batches++;

            report(`Batch ${batches}: +${found.added} round(s), ${rounds.length} total`);

            const button=loadMoreButton();

            if(!button) break;

            if(clicks>=ceiling){

                stoppedEarly=true;
                reason=maxClicks?"the max clicks setting was reached":`the ${CLICK_CEILING} click ceiling was reached`;

                console.log(LOG,reason);

                break;

            }

            const before=countPosts();

            // Framer only mounts what is near the viewport, and a button that is not laid out
            // does not react to a press at all
            if(button.scrollIntoView) button.scrollIntoView({block:"center"});

            // `stuck` picks the gesture: a real pointer press first, then the keyboard, then the
            // elements either side of the control. See pressButton.
            const how=pressButton(button,stuck);

            clicks++;

            const grew=await waitForBatch(before,BATCH_TIMEOUT);

            if(grew&&!pressedWith){

                pressedWith=how;

                if(how!=="pointer") console.warn(LOG,`Load More did not answer a pointer press -`
                    +` it loaded on "${how}" instead. The control has changed; check pressButton.`);

            }

            if(!grew){

                stuck++;

                if(stuck>=STUCK_LIMIT){

                    stoppedEarly=true;
                    reason=`${stuck} clicks in a row loaded nothing`;

                    console.warn(LOG,reason+" - treating that as the end of the feed");

                    break;

                }

                // the button no-ops when it is scrolled out of view, so nudge the page and give
                // it longer each time before believing it
                window.scrollBy(0,-200);

                await core.sleep(600*stuck);

                continue;

            }

            stuck=0;

            await checkpoint.save({rounds});

        }

        // One last read, after the loop has decided the feed is over: every round reads at the
        // TOP, so the final batch has no round after it to pick it up.
        const last=collectFrom(document);

        if(last.added) console.log(LOG,`${last.added} row(s) arrived after the last batch was read`);

        return {clicks,batches,stoppedEarly,reason,posts:countPosts(),pressedWith};

    }

    function countPosts(){
        return document.querySelectorAll(POST).length;
    }

    //---------------------------------------------------
    // helper: press the button
    //
    // This is the whole paginator, so it is worth being exact about. The control is a Framer
    // component - "framer-v-121ine6" is its current VARIANT and data-highlight="true" is the
    // marker Framer puts on anything with a tap or hover variant - which means the gesture behind
    // it is framer-motion's, and framer-motion arms a tap on `pointerdown` and completes it on
    // `pointerup`.
    //
    // HTMLElement.click() fires NEITHER. It dispatches one click event and nothing else, so the
    // tap handler never runs: the button visibly does nothing, no rows arrive, and the walk reads
    // a perfectly good feed as an exhausted one and writes the first 50 rounds as a complete run.
    //
    // So a press here is the sequence a mouse actually produces. The native click() still goes
    // out at the end of it, because a component wired to a plain onClick is just as likely and
    // costs one more event to cover.
    //---------------------------------------------------

    function pressButton(el,attempt){

        if(attempt>=2){

            // Events bubble, so pressing the label reaches a listener on the control - and
            // pressing the wrapper reaches one that was put outside it.
            pointerPress(el.parentElement);
            pointerPress(el.querySelector&&el.querySelector("p"));

            return "wrapper";

        }

        if(attempt===1) return keyPress(el);

        return pointerPress(el);

    }

    function pointerPress(el){

        if(!el) return "";

        const rect=el.getBoundingClientRect?el.getBoundingClientRect():null;

        const x=Math.round(rect?rect.left+rect.width/2:0);
        const y=Math.round(rect?rect.top+rect.height/2:0);

        const init={
            bubbles:true,cancelable:true,composed:true,
            clientX:x,clientY:y,screenX:x,screenY:y,
            pointerId:1,pointerType:"mouse",isPrimary:true,
            button:0,buttons:1,detail:1
        };

        const released=Object.assign({},init,{buttons:0});

        // the pointer arrives before it presses. A component with a hover variant arms on the way
        // in, and a tap on an element the pointer has never been over is not a shape the library
        // produces on its own.
        send(el,"pointerover",init);
        send(el,"pointerenter",Object.assign({},init,{bubbles:false}));
        send(el,"mouseover",init);
        send(el,"pointermove",init);

        send(el,"pointerdown",init);
        send(el,"mousedown",init);
        send(el,"pointerup",released);
        send(el,"mouseup",released);

        // last, and only once: nothing above dispatched a click, so a plain onClick handler fires
        // exactly one time rather than loading two batches for one press
        if(typeof el.click==="function") el.click();
        else send(el,"click",released);

        return "pointer";

    }

    // tabindex="0" is on the control, so it is reachable by keyboard and something has to answer
    // Enter when it is. Tried second: if the pointer press did nothing, this says whether the
    // component moved to a different gesture or the button is simply dead.
    function keyPress(el){

        if(!el) return "";

        if(typeof el.focus==="function") el.focus();

        const keys=[
            {key:"Enter",code:"Enter",keyCode:13},
            {key:" ",code:"Space",keyCode:32}
        ];

        for(const stroke of keys){

            const init={
                bubbles:true,cancelable:true,composed:true,
                key:stroke.key,code:stroke.code,keyCode:stroke.keyCode,which:stroke.keyCode
            };

            send(el,"keydown",init);
            send(el,"keyup",init);

        }

        return "keyboard";

    }

    function send(el,type,init){

        if(!el||typeof el.dispatchEvent!=="function") return;

        let event=null;

        try{

            if(POINTER_EVENT.test(type)&&typeof PointerEvent==="function") event=new PointerEvent(type,init);
            else if(MOUSE_EVENT.test(type)&&typeof MouseEvent==="function") event=new MouseEvent(type,init);
            else if(typeof KeyboardEvent==="function"&&/^key/.test(type)) event=new KeyboardEvent(type,init);
            else if(typeof Event==="function") event=new Event(type,init);

        }
        catch(e){
            event=null;
        }

        if(!event) return;

        try{
            el.dispatchEvent(event);
        }
        catch(e){
            // a listener of the page's own throwing is not this crawler's failure to report
        }

    }

    //---------------------------------------------------
    // helper: wait for a click to actually load rows
    //---------------------------------------------------

    function waitForBatch(before,timeout){

        return new Promise(resolve=>{

            let settle=null;
            let backstop=null;
            let cap=null;
            let done=false;

            const finishWait=grew=>{

                if(done) return;

                done=true;

                clearTimeout(settle);
                clearInterval(backstop);
                clearTimeout(cap);

                observer.disconnect();

                resolve(grew);

            };

            // counting is the expensive part, so it happens once per quiet moment rather than
            // once per mutation - a batch of fifty rows is hundreds of mutations and one count
            const check=()=>{
                if(countPosts()>before) finishWait(true);
            };

            const observer=new MutationObserver(()=>{

                clearTimeout(settle);

                settle=setTimeout(check,BATCH_SETTLE);

            });

            observer.observe(document.documentElement,{childList:true,subtree:true});

            backstop=setInterval(check,BACKSTOP_POLL);

            cap=setTimeout(()=>finishWait(countPosts()>before),timeout);

            // the batch may have landed between the click and this line
            check();

        });

    }

    //---------------------------------------------------
    // helper: read every funding row currently in the feed
    //---------------------------------------------------

    function collectFrom(root){

        const posts=feedRows(root);

        let added=0;

        for(let i=0;i<posts.length;i++){

            stats.posts++;

            const round=readRow(posts[i]);

            if(!round) continue;

            if(seenRounds.has(round.key)){
                stats.dupes++;
                continue;
            }

            seenRounds.add(round.key);
            rounds.push(round);

            added++;

            if(!dumpedRow){
                dumpedRow=true;
                console.log(LOG,"first row parsed as:",JSON.stringify(round));
            }

        }

        return {added};

    }

    // The rows are named "Post" in Framer, which survives a rebuild the way a hashed class does
    // not - but it is still a name someone typed, so there is a fallback that needs no name at
    // all: a company link, walked up to the first ancestor that also holds the round's date.
    function feedRows(root){

        const named=root.querySelectorAll(POST);

        if(named&&named.length) return named;

        const out=[];
        const seen=[];

        const links=root.querySelectorAll(COMPANY_LINK);

        for(let i=0;i<links.length;i++){

            const row=rowOf(links[i]);

            if(!row||seen.indexOf(row)>=0) continue;

            seen.push(row);
            out.push(row);

        }

        if(out.length) console.warn(LOG,`no ${POST} rows on the page -`
            +` fell back to walking up from ${out.length} company link(s)`);

        return out;

    }

    // grow the block around a company link until it also carries the date, which is what makes it
    // a funding row rather than a logo
    function rowOf(link){

        let node=link;

        for(let hops=0;node&&hops<6;hops++){

            if(node.querySelector&&node.querySelector("time")) return node;

            node=node.parentElement;

        }

        return null;

    }

    //---------------------------------------------------
    // helper: one feed row -> one funding round
    //---------------------------------------------------

    function readRow(post){

        if(!post) return null;

        const link=post.querySelector(COMPANY_LINK);

        const companyUrl=absolute(link&&link.getAttribute("href"));

        const name=norm(link)||norm(post.querySelector("p"))||"";

        if(!link) stats.noCompanyLink++;

        if(!name&&!companyUrl) return null;

        // "$45M · Series B" -> the two halves. The stage of THIS round, which is not always the
        // company's current stage: a company that raised a Series A in the feed and has since
        // raised a B shows "Series B" on its page and "Series A" on the older row.
        const cell=norm(post.querySelector(AMOUNT))||moneyCell(post);

        const parts=cell?cell.split(CELL_SEP):[];

        let amount="";
        let stage="";

        for(const part of parts){

            const text=part.trim();

            if(!text) continue;

            if(!amount&&MONEY.test(text)) amount=text;
            else if(!stage) stage=text;

        }

        if(!amount&&parts.length) amount=parts[0].trim();

        if(!amount) stats.noAmount++;

        const time=post.querySelector("time");

        const date=isoDate(time&&time.getAttribute("datetime"))||norm(time);

        if(!date) stats.noDate++;

        const investor=post.querySelector(INVESTOR_LINK);

        const leadName=norm(investor);
        const leadSlug=slugOf(investor&&investor.getAttribute("href"));

        // every lead investor in the feed is spelled out in full next to its slug, which is what
        // the company pages' logo-only investor lists are read through
        if(leadSlug&&leadName&&!investorNames.has(leadSlug)) investorNames.set(leadSlug,leadName);

        const source=sourceUrl(post);

        if(!source) stats.noSource++;

        return {
            key:(companyUrl||"name:"+core.nameKey(name))+"|"+date+"|"+amount,
            company:name,
            companyUrl,
            amount,
            stage,
            date,
            lead:leadName,
            source
        };

    }

    // the amount cell, when data-framer-name is not there to name it
    function moneyCell(post){

        const cells=post.querySelectorAll("p");

        for(let i=0;i<cells.length;i++){

            const text=norm(cells[i]);

            if(!text) continue;

            const head=text.split(CELL_SEP)[0].trim();

            if(MONEY.test(head)) return text;

        }

        return "";

    }

    // the press link. Named "Source" by Framer, and when it is not, it is the one external link
    // on the row - the company and the investor both point back into startups.gallery.
    function sourceUrl(post){

        const named=post.querySelector(SOURCE_LINK);

        if(named) return absolute(named.getAttribute("href"));

        const links=post.querySelectorAll(EXTERNAL_LINK);

        for(let i=0;i<links.length;i++){

            const href=links[i].getAttribute("href")||"";

            if(/^https?:\/\//i.test(href)&&!/^https?:\/\/(?:www\.)?startups\.gallery/i.test(href)) return href;

        }

        return "";

    }

    //---------------------------------------------------
    // helper: the Load More button
    //
    // Framer renders one copy of a responsive component per breakpoint and hides all but one with
    // CSS. Clicking the first match is therefore clicking an invisible button on most screens -
    // it fires, nothing loads, and the walk reads that as the end of the feed.
    //---------------------------------------------------

    function loadMoreButton(){

        const candidates=[];

        const nodes=document.querySelectorAll('[tabindex],button,a,[data-highlight="true"],[role="button"]');

        for(let i=0;i<nodes.length;i++){

            if(LOAD_MORE.test(norm(nodes[i]))) candidates.push(nodes[i]);

        }

        if(!candidates.length) return null;

        // innermost first: the outer wrapper carries the same text as the control inside it, and
        // only the control listens for the click
        const inner=candidates.filter(node=>{

            for(const other of candidates){
                if(other!==node&&node.contains&&node.contains(other)) return false;
            }

            return true;

        });

        const shortlist=inner.length?inner:candidates;

        for(const node of shortlist){
            if(visible(node)&&!node.disabled) return node;
        }

        // Nothing measurable: either every copy really is hidden - the feed is exhausted and the
        // button is gone from the layout - or this is a document with no layout at all, which is
        // what the tests run against. Clicking the first is right in the second case and harmless
        // in the first, where the walk's own stuck counter ends it.
        return shortlist[0]||null;

    }

    function visible(el){

        if(!el) return false;

        // jsdom-free documents have neither, and a document with no layout cannot answer the
        // question - so it is not asked
        if(typeof el.getClientRects!=="function") return true;

        return el.getClientRects().length>0;

    }

    //---------------------------------------------------
    // helper: one company page -> the columns the feed row cannot fill
    //---------------------------------------------------

    function readCompany(doc,dump){

        // Every pill and every investor logo is a block anchor. The site's own category directory
        // in the footer links to the SAME routes, as inline text inside a paragraph - it is
        // "framer-text" that tells the two apart, and it is the only class name here worth
        // reading because it is Framer's own, not a per-build hash.
        const pills=blockAnchors(doc,CATEGORY_LINK);

        const detail={
            location:pillText(pills,"/categories/locations/"),
            industry:pillText(pills,"/categories/industries/"),
            stage:stageOf(pills),
            employees:readEmployees(doc,pills),
            investors:readInvestors(doc),
            description:readDescription(doc),
            website:buttonHref(doc,/^visit\s+website$/i)
        };

        if(dump) console.log(LOG,"first company page parsed as:",JSON.stringify(detail));

        return detail;

    }

    function blockAnchors(root,selector){

        const all=root.querySelectorAll(selector);

        const out=[];

        for(let i=0;i<all.length;i++){

            const classes=(all[i].getAttribute("class")||"").split(/\s+/);

            if(classes.indexOf("framer-text")<0) out.push(all[i]);

        }

        return out;

    }

    function pillText(pills,route){

        for(const pill of pills){

            if((pill.getAttribute("href")||"").indexOf(route)>=0) return norm(pill);

        }

        return "";

    }

    // The stage pill reads "$45M Series B" - the amount and the stage run together - so the slug
    // is what the stage is actually taken from. "series-b" -> "Series B".
    function stageOf(pills){

        for(const pill of pills){

            const href=pill.getAttribute("href")||"";

            if(href.indexOf("/categories/stages/")<0) continue;

            return prettySlug(slugOf(href));

        }

        return "";

    }

    // The employees pill has no label and no link: the header row is location, stage, industry,
    // work type and then a bare "11–50" under a people icon. So it is read as "the cell in the
    // pill row that is not inside one of the pills" - structural, and it needs no class name.
    function readEmployees(doc,pills){

        if(!pills.length) return "";

        const row=pills[0].parentElement;

        if(!row||!row.querySelectorAll) return "";

        const inside=[];

        for(const pill of pills){

            const cells=pill.querySelectorAll("p");

            for(let i=0;i<cells.length;i++) inside.push(cells[i]);

        }

        const cells=row.querySelectorAll("p");

        for(let i=0;i<cells.length;i++){

            if(inside.indexOf(cells[i])>=0) continue;

            const text=norm(cells[i]);

            if(EMPLOYEES.test(text)) return text;

        }

        return "";

    }

    // "Backed by" is a strip of logos. About half carry alt="Logo of Accel"; the rest carry
    // nothing but the slug in their href, which is why the feed's lead investors are collected
    // into a dictionary first.
    function readInvestors(doc){

        const anchors=blockAnchors(doc,INVESTOR_LINK);

        const names=[];

        for(const anchor of anchors){

            const slug=slugOf(anchor.getAttribute("href"));

            if(!slug) continue;

            const name=norm(anchor)
                ||altName(anchor)
                ||investorNames.get(slug)
                ||prettySlug(slug);

            if(name&&names.indexOf(name)<0) names.push(name);

        }

        return names;

    }

    function altName(anchor){

        const images=anchor.querySelectorAll("img");

        for(let i=0;i<images.length;i++){

            const alt=(images[i].getAttribute("alt")||"").replace(/\s+/g," ").trim();

            if(LOGO_ALT.test(alt)) return alt.replace(LOGO_ALT,"").trim();

        }

        return "";

    }

    // The description is the paragraph directly under "Raised $45M Series B on August 12, 2026".
    // Nothing names it, so it is found by position and then by length: every other paragraph in
    // the header - the pills, the buttons, the labels - is a handful of characters.
    function readDescription(doc){

        const cells=doc.querySelectorAll("p");

        const texts=[];

        for(let i=0;i<cells.length;i++) texts.push(norm(cells[i]));

        let start=0;

        for(let i=0;i<texts.length;i++){

            if(RAISED.test(texts[i])) start=i+1;

        }

        for(let i=start;i<texts.length;i++){

            if(texts[i].length>=DESC_MIN&&!RAISED.test(texts[i])) return texts[i];

        }

        // the marker moved, or this company has no write-up: fall back to the longest paragraph
        let longest="";

        for(const text of texts){
            if(text.length>longest.length&&!RAISED.test(text)) longest=text;
        }

        if(longest.length>=DESC_MIN) return longest;

        // ...and finally the meta tag, which carries the one-line tagline. It is kept in the slice
        // for exactly this case.
        const meta=doc.querySelector('meta[name="description"]');

        const content=meta&&meta.getAttribute("content")||"";

        return content.replace(META_TAIL,"").trim();

    }

    // "Visit Website" and "View Jobs" are the two buttons in the header. Both are ordinary
    // anchors; only their label says which is which.
    function buttonHref(doc,label){

        const links=doc.querySelectorAll("a");

        for(let i=0;i<links.length;i++){

            if(!label.test(norm(links[i]))) continue;

            const href=links[i].getAttribute("href")||"";

            if(/^https?:\/\//i.test(href)) return href;

        }

        return "";

    }

    //---------------------------------------------------
    // helper: cut a company page down to the part that is read
    //---------------------------------------------------

    function sliceCompany(html){

        const start=html.indexOf("<body");

        if(start<0) return "";

        // The footer is the site's whole category and investor directory - every city, every
        // stage, every fund - linking to the same routes the header pills do. Cutting there is
        // what keeps readInvestors() from filing the entire directory under this company, and it
        // is the bigger half of the page.
        let end=html.length;

        const directory=/<a[^>]*class="framer-text[^"]*"[^>]*href="[^"]*\/(?:investors|categories)\//i.exec(html);

        if(directory&&directory.index>start) end=directory.index;

        const feed=html.indexOf('id="feed-',start);

        if(feed>start&&feed<end) end=feed;

        // the meta tag lives in <head>, above the cut, and readDescription falls back to it
        const meta=/<meta[^>]+name="description"[^>]*>/i.exec(html);

        return (meta?meta[0]:"")+html.slice(start,end);

    }

    // Did the cut land? The words it looks for turn up in press copy too, and a cut that missed
    // costs one small wasted parse before the whole page is parsed as it was before.
    function hasCompanyHeader(doc){
        return !!(doc.querySelector("h1")||doc.querySelector(CATEGORY_LINK));
    }

    //---------------------------------------------------
    // helper: one funding round + its company -> one row
    //---------------------------------------------------

    function buildRow(round,company){

        const detail=company&&company.detail||null;

        const investors=detail&&detail.investors||[];

        // The round's own stage beats the company page's, which is the company's CURRENT stage:
        // an older round in the feed would otherwise be relabelled with whatever the company has
        // raised since.
        const stage=round.stage||(detail&&detail.stage)||"";

        return {
            "Company Name":round.company,
            "Location":detail&&detail.location||"",
            "Funding Stage":stage,
            "Investors":investors.join(", "),
            "Employees":detail&&detail.employees||"",
            "Invest Amount":round.amount,
            "Date":round.date,
            "Description":detail&&detail.description||"",
            "Lead Investor":round.lead,
            "Industry":detail&&detail.industry||"",
            "Website":detail&&detail.website||"",
            "Company Page":round.companyUrl||"",
            "Press Source":round.source||""
        };

    }

    //---------------------------------------------------
    // helper: write the file
    //---------------------------------------------------

    function finish(state){

        // the crash path calls this too, and an exception raised INSIDE it would come back round
        // and download a second copy of the same file
        if(fileWritten) return;

        fileWritten=true;

        // fixed header: a round whose company page was never read must still keep all 13 columns
        const HEADERS=["Company Name","Location","Funding Stage","Investors","Employees",
            "Invest Amount","Date","Description","Lead Investor","Industry","Website",
            "Company Page","Press Source"];

        const written=core.exportCsv(state.results,{
            headers:HEADERS,
            filename:"startups_gallery_funding.csv",
            log:LOG
        });

        const results=state.results;
        const feed=state.feed||{clicks:0,batches:0,stoppedEarly:false,reason:"",posts:0};

        const filled=header=>results.filter(row=>row[header]).length;

        const elapsed=Math.round((performance.now()-startedAt)/1000);

        const summary=[
            `Done in ${elapsed}s. Saved as startups_gallery_funding.csv`,
            ``,
            `Feed:      ${feed.batches} batch(es), Load More pressed ${feed.clicks} time(s)`
                +(feed.pressedWith&&feed.pressedWith!=="pointer"?` (it answered "${feed.pressedWith}", not a pointer press)`:"")
                +(feed.stoppedEarly?` - STOPPED EARLY, ${feed.reason}`:` - ${feed.reason}`),
            `Rows:      ${stats.posts} row(s) read, ${stats.dupes} already seen`
                +(resumed?`, ${resumed} resumed from an earlier unfinished run`:""),
            `Rounds:    ${results.length} funding round(s) across ${state.companies.length} company page(s)`,
            state.wantDetails
                ? `Details:   ${state.fetched-state.failedDetail}/${state.companies.length} company page(s) read`
                    +(state.failedDetail?`, ${state.failedDetail} could not be read at all`:"")
                : `Details:   switched off in the popup - Location, Employees, Description and Investors are blank`,
            `Filled:    ${filled("Location")} location, ${filled("Employees")} employees, `
                +`${filled("Investors")} investors, ${filled("Description")} description, `
                +`${filled("Invest Amount")} amount, ${filled("Date")} date`,
            stats.noCompanyLink||stats.noAmount||stats.noDate||stats.noSource
                ? `Gaps:      ${stats.noCompanyLink} row(s) with no company link, ${stats.noAmount} with no amount, `
                    +`${stats.noDate} with no date, ${stats.noSource} with no press link`
                : `Gaps:      none - every row carried a company, an amount, a date and a press link`,
            written.clipped?`Truncated: ${written.clipped} cell(s) hit Excel's 32,767 character limit`:"",
            fetcher.describe()?`Requests:  ${fetcher.describe()}`:"",
            tabs.describe()?`${tabs.describe()}`:"",
            state.crashed?`\nThe run stopped early: ${state.crashed}.`
                +`\nEverything collected before that point is in the file above.`:""
        ].filter(line=>line!=="").join("\n");

        console.log(LOG,"\n"+summary);

        // the popup only has a single status line -> send the short version
        report(`Done: ${results.length} funding round(s), ${state.companies.length} company page(s).`);

        // the run reached the file, so there is nothing left to resume
        if(!state.crashed) checkpoint.clear();

        // let the download start before the alert blocks the page
        setTimeout(()=>alert(summary),0);

    }

    // build the file out of whatever survived the crash
    function salvage(error){

        try{

            if(!rounds.length){
                alert("Crawl failed before anything was collected: "+(error&&error.message||error));
                return;
            }

            finish({
                results:rounds.map(round=>buildRow(round,null)),
                companies:[],
                feed:null,
                fetched:0,
                failedDetail:0,
                wantDetails:false,
                crashed:(error&&error.message||String(error))
            });

        }
        catch(e){

            console.error(LOG,"could not salvage the run either:",e);

            alert("Crawl failed: "+(error&&error.message||error)+"\nOpen DevTools console for details.");

        }

    }

    //---------------------------------------------------
    // small helpers
    //---------------------------------------------------

    // The feed links to "./companies/blacksmith" and a company page to "../investors/peak-xv",
    // both relative to wherever the reader happens to be. Resolving them against the page they
    // were read from is what keeps a relative href from becoming /news/companies/blacksmith.
    function absolute(href){

        if(!href) return "";

        try{
            return new URL(href,location.href).href;
        }
        catch(e){
            return "";
        }

    }

    function slugOf(href){

        if(!href) return "";

        const match=/\/(?:investors|companies|categories\/[a-z-]+(?:\/[a-z-]+)?)\/([^/?#]+)/i.exec(href);

        return match?match[1]:"";

    }

    // "peak-xv" -> "Peak XV" is beyond a slug, so this only title-cases: it is the LAST fallback,
    // behind the anchor's own text, its logo's alt and the name the feed spelled out.
    function prettySlug(slug){

        if(!slug) return "";

        return slug.split("-")
            .filter(Boolean)
            .map(word=>word.charAt(0).toUpperCase()+word.slice(1))
            .join(" ");

    }

    // "2026-08-12T00:00:00.000Z" -> "2026-08-12". The date is printed as "Aug 12, 2026", which
    // Excel sorts alphabetically; the datetime attribute next to it does not have that problem.
    function isoDate(value){

        if(!value) return "";

        const match=/^(\d{4}-\d{2}-\d{2})/.exec(value);

        return match?match[1]:"";

    }

})();
