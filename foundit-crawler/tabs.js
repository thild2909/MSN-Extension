//---------------------------------------------------
// tabs.js - reading a page the way a person does.
//
// Every crawler in this family runs on core.js and every one of them eventually meets the same
// answer: 429, 503, 403, or a 5xx from a CDN. Backing off is the right response to a rate limit
// and the wrong response to a bot check, and from the outside they look identical - which is how a
// run could sit out its entire cooldown budget and still come away with nothing.
//
// A fetch() from a content script carries no navigation behind it: no document, no
// Sec-Fetch-Mode: navigate, no chance to run the JavaScript a managed challenge asks for. The SAME
// URL opened as a real top level navigation carries the whole browser with it - cookies, TLS
// fingerprint, and the JS that answers the challenge - and normally comes straight back.
//
// So that is the fallback: open the refused URL in a tab, wait for it, lift the HTML out, close
// the tab again. When the check is one that only a person can clear, the tab is brought to the
// front and the user clears it. That is worth doing once: the cookie it sets covers the whole
// site, so the cheap path works again for the rest of the run.
//
// A content script cannot open tabs, which is the only reason this worker exists. It is the same
// file in every crawler - see _shared/README.md.
//---------------------------------------------------

const TABS_LOG="[tabs]";

// how long a tab gets to finish loading before it is written off
const LOAD_TIMEOUT=25000;

// After "complete": the last inline scripts still have to run before the content is in the DOM.
//
// With `extract` this stops being a toll and becomes a ceiling. The tab is read straight away and
// re-read every STEP until the wanted block appears, so a page that is already done costs nothing
// and only a slow one pays. Without `extract` there is nothing to test for, so the full wait stands.
const SETTLE=700;
const SETTLE_STEP=150;

// A managed challenge solves itself in a real browser - it just needs a few seconds. This is how
// long the tab is given to get past it on its own, before the person is asked.
const CHALLENGE_WAIT=15000;
const CHALLENGE_STEP=1500;

// ...and how long they get once it is in front of them. Generous on purpose: this is somebody
// reading a checkbox, and giving up early wastes the interruption we just spent.
const USER_WAIT=180000;
const USER_STEP=2000;

// how often the tab is asked whether it has finished. Also what keeps this service worker alive:
// MV3 stops a worker that has been idle for 30s, and a bare setTimeout does not count as activity.
//
// This is pure latency on a page that loads quickly: at 400ms the average tab paid 200ms waiting
// to be asked a question it could already answer, plus another 400 before it was asked the first
// time. chrome.tabs.get is a cheap IPC call, so ask more often.
const POLL=200;

// "Just a moment...", "Verify you are human" and friends. Only ever tested against a SMALL
// document: a real search results page is an order of magnitude bigger than any interstitial, and
// without the size guard this would match the same words inside a job description.
const CHALLENGE=/just a moment|checking your browser|verify (?:you are|yourself)|are you a human|cf-browser-verification|challenge-platform|__cf_chl|enable javascript and cookies|press and hold|unusual traffic/i;
const CHALLENGE_MAX_BYTES=150000;

function sleep(ms){
    return new Promise(resolve=>setTimeout(resolve,ms));
}

//---------------------------------------------------
// which URLs this extension is allowed to open
//
// Taken from the manifest rather than written out again here, so the shared copy of this file
// stays identical across crawlers and a new country domain only has to be added in one place.
//---------------------------------------------------

let allowed=null;

function allowedHosts(){

    if(allowed) return allowed;

    allowed=(chrome.runtime.getManifest().host_permissions||[]).map(pattern=>{

        // "https://*.glassdoor.com/*" -> /^https:\/\/([^/]+\.)?glassdoor\.com\/.*/
        //
        // The leading "*." is handled before the generic "*" -> ".*" step, and the group is
        // OPTIONAL because that is what Chrome's own match patterns mean: "*.glassdoor.com"
        // covers the bare domain as well as any subdomain. Letting the generic step have it
        // instead produced ".*\.glassdoor\.com", which demanded a subdomain and so refused to
        // open glassdoor.com itself - the one host the crawler is always on.
        //
        // Note the escape pass leaves "/" and "*" alone, so this matches a literal "*\." - the
        // asterisk unescaped, the dot escaped by the line above it.
        const escaped=pattern
            .replace(/[.+?^${}()|[\]\\]/g,"\\$&")
            .replace(/^https:\/\/\*\\\./,"https://([^/]+\\.)?")
            .replace(/\*/g,".*");

        // anchored at BOTH ends: without the $, "https://sg.indeed.com/*" would also accept
        // "https://sg.indeed.com.evil.com/" only by luck of the trailing slash
        return new RegExp("^"+escaped+"$");

    });

    return allowed;

}

function permitted(url){

    return /^https:\/\//i.test(url)&&allowedHosts().some(pattern=>pattern.test(url));

}

//---------------------------------------------------
// A small pool of tabs, not one at a time.
//
// This used to be a single promise chain, on the reasoning that concurrent tabs compete for the
// same connection and are the burst of traffic that got the plain fetches refused to begin with.
// That holds for a dozen tabs. It does not hold for the first few, and "one at a time" was by far
// the most expensive thing in a refused run: a tab load is seconds, almost all of it waiting on the
// network, so every page sat out the whole load of every page in front of it while the browser did
// nothing. A crawl whose pages all need a tab ran strictly serially no matter what "parallel" said
// in the popup - which is exactly what parallel-does-nothing looks like from the outside.
//
// So: capped, not unbounded. The cap is set by the caller (it is the same "parallel" setting the
// fetches use) and hard-limited here, because this side is the one that knows what a tab costs.
//
// Two things stay serial on purpose:
//   - a tab is only ever brought to the FRONT one at a time, so the person is never handed four
//     checks at once (see `asking` below)
//   - the slot is handed straight to the next waiter rather than released and re-taken, so the
//     pool cannot overshoot its cap between an await and a resume
//---------------------------------------------------

const TAB_LIMIT_MAX=8;

let tabLimit=4;
let running=0;
const queued=[];

function setTabLimit(value){

    const wanted=Math.min(TAB_LIMIT_MAX,Math.max(1,Math.round(+value||0)));

    if(!value||wanted===tabLimit) return;

    tabLimit=wanted;

    // widening mid-run has to wake the tabs already waiting, or the new width only takes effect
    // after the next tab happens to finish
    while(running<tabLimit&&queued.length){
        running++;
        queued.shift()();
    }

}

function takeSlot(){

    if(running<tabLimit){

        running++;

        return Promise.resolve();

    }

    return new Promise(resolve=>queued.push(resolve));

}

function freeSlot(){

    const next=queued.shift();

    // hand the slot over rather than giving it back and letting the next waiter re-take it
    if(next) next();
    else running--;

}

async function withSlot(job){

    await takeSlot();

    try{
        return await job();
    }
    finally{
        freeSlot();
    }

}

async function waitForLoad(tabId){

    const until=Date.now()+LOAD_TIMEOUT;

    // chrome.tabs.create resolves before the navigation has started, so a tab can still be
    // reporting the previous "complete" on about:blank for a moment
    await sleep(POLL);

    for(;;){

        let tab;

        try{
            tab=await chrome.tabs.get(tabId);
        }
        catch(e){
            return "gone";
        }

        if(tab.status==="complete"&&tab.url&&tab.url!=="about:blank") return "ok";

        if(Date.now()>until) return "timeout";

        await sleep(POLL);

    }

}

// Lift the rendered document out of the tab.
//
// `extract` is a list of CSS selectors naming the only part of the page the caller actually reads.
// When one of them matches, that markup comes back instead of the whole document - and a job page
// is often more than a megabyte, nearly all of it a JSON blob for the page's own JavaScript. That
// megabyte was being structure-cloned twice (tab -> worker -> content script) and then handed to
// DOMParser, per page, to read three fields out of it.
//
// Nothing matching is not an error: the page is returned whole, exactly as before. That is also
// what keeps challenge detection working - an interstitial matches no selector, so it always
// arrives in full.
//
// `partialOnly` is for the poll below: while waiting for the block to appear there is no point
// dragging the whole document back on every look, so an empty body says "not yet" and the page is
// only ever fetched in full once.
async function readTab(tabId,extract,partialOnly){

    const [entry]=await chrome.scripting.executeScript({
        target:{tabId},
        args:[extract&&extract.length?extract:null,!!partialOnly],
        func:(selectors,slim)=>{

            let found=[];

            if(selectors){

                for(const selector of selectors){

                    try{
                        found.push(...document.querySelectorAll(selector));
                    }
                    catch(e){
                        // a selector this browser will not parse is not worth failing the read for
                    }

                }

                // Keep only the outermost matches. Two selectors overlap on purpose here
                // ("overviewItem" also matches "overviewItemValue" inside it), and emitting a
                // child alongside its parent would deliver the same field twice - once inside its
                // row, once loose at top level with every other loose field for a sibling. A
                // caller pairing a value with the label next to it then pairs it with the wrong one.
                found=found.filter((node,index)=>
                    found.indexOf(node)===index&&!found.some(other=>other!==node&&other.contains(node)));

            }

            const part=found.map(node=>node.outerHTML).join("\n");

            return {
                html:part||(slim?"":document.documentElement.outerHTML),
                partial:!!part,
                url:location.href,
                title:document.title
            };

        }
    });

    return entry&&entry.result||null;

}

function challenged(page){

    if(!page||!page.html) return false;

    // the block the caller came for is on the page, so whatever else it is, it is not an interstitial
    if(page.partial) return false;

    if(page.html.length>CHALLENGE_MAX_BYTES) return false;

    return CHALLENGE.test(page.title||"")||CHALLENGE.test(page.html);

}

// Read as soon as the page is ready rather than after a fixed wait. See SETTLE.
async function readWhenSettled(tabId,extract){

    if(!extract||!extract.length){

        await sleep(SETTLE);

        return readTab(tabId,extract);

    }

    // Reading the moment the tab says "complete" means sometimes reading it while it is still
    // moving - a client-side redirect tears the frame out from under executeScript. That is not a
    // failure, it is the case this poll is here for, so keep looking rather than writing the page
    // off the way a fixed wait followed by one read would have.
    const look=async()=>{

        try{
            return await readTab(tabId,extract,true);
        }
        catch(e){
            return null;
        }

    };

    let page=await look();
    let waited=0;

    while(!(page&&page.partial)&&waited<SETTLE){

        await sleep(SETTLE_STEP);

        waited+=SETTLE_STEP;

        page=await look();

    }

    // it never appeared: take the page as it is, so the caller can see what it got instead -
    // a challenge, a sign-in wall, or a listing that genuinely has no such block
    if(!(page&&page.partial)) page=await readTab(tabId,extract);

    return page;

}

// poll the tab until the check clears or the time runs out
async function waitOutChallenge(tabId,page,budget,step,extract){

    let waited=0;

    while(challenged(page)&&waited<budget){

        await sleep(step);

        waited+=step;

        try{
            page=await readTab(tabId,extract);
        }
        catch(e){
            return {page,waited};
        }

    }

    return {page,waited};

}

// Only one tab may take the window at a time. The pool means several can reach a check in the same
// second, and stacking them would pull the window away from the person repeatedly while they are
// already working on the first one - and the cookie the first check sets covers the whole site, so
// the others very often have nothing left to ask.
let asking=false;

// bring the tab to the front so the person can clear the check themselves
async function askUser(tab){

    try{

        await chrome.tabs.update(tab.id,{active:true});

        if(tab.windowId!=null) await chrome.windows.update(tab.windowId,{focused:true});

        return true;

    }
    catch(e){

        console.warn(TABS_LOG,"could not bring the tab to the front",e);

        return false;

    }

}

//---------------------------------------------------
// the whole trip: open, wait, read, close
//---------------------------------------------------

async function fetchInTab(url,letUserSolve,extract){

    if(!permitted(url)){
        return {ok:false,error:"refusing to open a URL outside this extension's own sites",fatal:false};
    }

    let tab;

    try{
        // active:false - the tab loads without taking the window away from whatever the user is
        // doing. It is only brought forward if a person is actually needed, and it is closed again
        // in the finally below, so nothing is left behind either way.
        tab=await chrome.tabs.create({url,active:false});
    }
    catch(e){
        return {ok:false,error:"could not open a tab: "+(e&&e.message||e),fatal:true};
    }

    let askedUser=false;

    try{

        const loaded=await waitForLoad(tab.id);

        if(loaded==="gone") return {ok:false,error:"the tab was closed before the page loaded"};

        // A timeout is not a failure on its own: sites keep long-polling connections open, so
        // "complete" sometimes never arrives on a page that has been readable for ten seconds.
        // Read it anyway and let the caller judge the html.
        let page=await readWhenSettled(tab.id,extract);

        // 1. give it a few seconds to solve itself, which is what usually happens
        let round=await waitOutChallenge(tab.id,page,CHALLENGE_WAIT,CHALLENGE_STEP,extract);

        page=round.page;

        let waited=round.waited;
        let solvedByUser=false;

        // 2. still challenged: this one wants a person. Put it in front of them rather than
        //    failing silently and leaving the pages behind it out of the file with no explanation.
        //    Not while another tab already has them, though - see `asking`. The caller hands its
        //    interruption quota back when the reply says nobody was asked, so skipping here costs
        //    the run nothing but this one page.
        if(challenged(page)&&letUserSolve&&!asking){

            askedUser=true;
            asking=true;

            try{

                await askUser(tab);

                round=await waitOutChallenge(tab.id,page,USER_WAIT,USER_STEP,extract);

                page=round.page;
                waited+=round.waited;

                solvedByUser=!challenged(page);

            }
            finally{
                asking=false;
            }

        }

        if(!page||!page.html) return {ok:false,error:"the tab could not be read",askedUser};

        if(challenged(page)){

            return {
                ok:false,
                challenged:true,
                askedUser,
                error:`the check on the page was still there after ${Math.round(waited/1000)}s`
            };

        }

        return {ok:true,html:page.html,partial:!!page.partial,url:page.url,waited,askedUser,
            solvedByUser,timedOut:loaded==="timeout"};

    }
    catch(e){

        console.warn(TABS_LOG,"tab read failed",url,e);

        return {ok:false,error:e&&e.message||String(e),askedUser};

    }
    finally{

        chrome.tabs.remove(tab.id).catch(()=>{});

    }

}

chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{

    // Answered before a crawl starts, so "this extension has no working background worker" is
    // reported in the first second rather than discovered after twenty refused pages. It also
    // wakes the worker, which MV3 will have shut down during the long stretch of plain fetches.
    if(message&&message.type==="tab:ping"){

        sendResponse({ok:true});

        return false;

    }

    if(!message||message.type!=="tab:fetch") return false;

    // the caller's "parallel" setting, clamped here: this side is the one that knows what a tab costs
    setTabLimit(message.limit);

    const extract=Array.isArray(message.extract)?message.extract.map(String):null;

    withSlot(()=>fetchInTab(String(message.url||""),message.letUserSolve!==false,extract))
        .then(sendResponse)
        .catch(e=>sendResponse({ok:false,error:e&&e.message||String(e)}));

    // keeps the channel open for the async reply
    return true;

});
