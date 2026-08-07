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

// after "complete": the last inline scripts still have to run before the content is in the DOM
const SETTLE=700;

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
const POLL=400;

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
// One tab at a time.
//
// Opening six tabs at once is both slower than doing them in turn - they compete for the same
// connection - and exactly the burst of traffic that got the plain fetches refused in the first
// place. It would also put six tabs in front of the user at once.
//---------------------------------------------------

let chain=Promise.resolve();

function serialize(job){

    const run=chain.then(job,job);

    chain=run.catch(()=>{});

    return run;

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

// lift the rendered document out of the tab
async function readTab(tabId){

    const [entry]=await chrome.scripting.executeScript({
        target:{tabId},
        func:()=>({
            html:document.documentElement.outerHTML,
            url:location.href,
            title:document.title
        })
    });

    return entry&&entry.result||null;

}

function challenged(page){

    if(!page||!page.html) return false;

    if(page.html.length>CHALLENGE_MAX_BYTES) return false;

    return CHALLENGE.test(page.title||"")||CHALLENGE.test(page.html);

}

// poll the tab until the check clears or the time runs out
async function waitOutChallenge(tabId,page,budget,step){

    let waited=0;

    while(challenged(page)&&waited<budget){

        await sleep(step);

        waited+=step;

        try{
            page=await readTab(tabId);
        }
        catch(e){
            return {page,waited};
        }

    }

    return {page,waited};

}

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

async function fetchInTab(url,letUserSolve){

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
        await sleep(SETTLE);

        let page=await readTab(tab.id);

        // 1. give it a few seconds to solve itself, which is what usually happens
        let round=await waitOutChallenge(tab.id,page,CHALLENGE_WAIT,CHALLENGE_STEP);

        page=round.page;

        let waited=round.waited;
        let solvedByUser=false;

        // 2. still challenged: this one wants a person. Put it in front of them rather than
        //    failing silently and leaving the pages behind it out of the file with no explanation.
        if(challenged(page)&&letUserSolve){

            askedUser=true;

            await askUser(tab);

            round=await waitOutChallenge(tab.id,page,USER_WAIT,USER_STEP);

            page=round.page;
            waited+=round.waited;

            solvedByUser=!challenged(page);

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

        return {ok:true,html:page.html,url:page.url,waited,askedUser,solvedByUser,
            timedOut:loaded==="timeout"};

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

    serialize(()=>fetchInTab(String(message.url||""),message.letUserSolve!==false))
        .then(sendResponse)
        .catch(e=>sendResponse({ok:false,error:e&&e.message||String(e)}));

    // keeps the channel open for the async reply
    return true;

});
