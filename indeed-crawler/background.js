//---------------------------------------------------
// Webshare proxy rotation.
//
// Why a service worker at all: a content script cannot change the IP its own fetch() goes out on.
// The browser picks the route, so the only lever is chrome.proxy - and that lives in the extension
// process, not in the tab. content.js therefore asks this worker to swap the exit IP and waits.
//
// The proxy config is BROWSER WIDE, so it is applied through a PAC script that sends only
// *.indeed.com (plus the IP echo used to verify a swap) through Webshare and everything else
// DIRECT. Normal browsing in other tabs is never routed through the proxy.
//---------------------------------------------------

const LOG="[indeed-proxy]";

const DEFAULT_API_KEY="r2z3cglglwp23zu54a0twgpzf1es9mltni353217";

// mode=direct returns proxy_address/port pairs to connect to one by one. The backbone endpoint
// (p.webshare.io) rotates by itself but is not enabled on every plan, so the list is the portable
// way to get a different IP - each entry IS a different IP.
const API_LIST="https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page_size=100";

// echoes back the IP the request came out on -> the only honest confirmation that a swap took
const CHECK_URL="https://ipv4.webshare.io/";
const CHECK_TIMEOUT=9000;

// the list is billed per call and changes at most when proxies get replaced
const LIST_TTL=6*60*60*1000;

// a crawl that dies with the tab must not leave the browser proxied
const AUTO_OFF_MINUTES=20;

// uk.indeed.com served from a Warsaw IP looks stranger to Indeed than from a London one, so a
// proxy in the matching country is preferred when the plan happens to have one
const COUNTRY_OF={sg:"SG",au:"AU",hk:"HK",uk:"GB",my:"MY",de:"DE"};

//---------------------------------------------------
// state
// storage.session survives a service worker restart (which happens constantly in MV3) but is
// dropped when the browser closes - exactly the lifetime a proxy assignment should have.
//---------------------------------------------------

// built fresh per call: a shared literal would hand every caller the SAME usage object, and the
// block counts of one crawl would follow the next one around
function blank(){
    return {enabled:false,current:null,usage:{},rotations:0,lastRotateAt:0,lastIp:"",preferred:""};
}

async function getState(){

    const stored=await chrome.storage.session.get("proxyState");

    return Object.assign(blank(),stored.proxyState||{});

}

function setState(state){
    return chrome.storage.session.set({proxyState:state});
}

async function getApiKey(){

    const stored=await chrome.storage.local.get("webshareKey");

    return (stored.webshareKey||DEFAULT_API_KEY).trim();

}

//---------------------------------------------------
// proxy authentication
//
// Chrome will not take user:pass out of a PAC result, so the credentials have to be handed over
// when the proxy challenges. Registered at the top level: the worker is woken by this event and a
// listener added later would miss it.
//
// Answering the same requestId twice means the credentials were rejected; answering again would
// loop forever, so the second challenge cancels instead.
//---------------------------------------------------

const answered=new Set();

chrome.webRequest.onAuthRequired.addListener(

    (details,callback)=>{

        if(!details.isProxy){
            callback({});
            return;
        }

        if(answered.has(details.requestId)){

            answered.delete(details.requestId);

            console.warn(LOG,"proxy rejected the credentials",details.challenger);

            callback({cancel:true});

            return;

        }

        answered.add(details.requestId);

        getState().then(state=>{

            const current=state.current;

            if(!current) callback({});
            else callback({authCredentials:{username:current.username,password:current.password}});

        }).catch(e=>{

            console.warn(LOG,"could not read the proxy credentials",e);

            callback({});

        });

    },

    {urls:["<all_urls>"]},

    ["asyncBlocking"]

);

// requestIds are never reused, so the guard set has to be swept or it grows for the whole session
chrome.webRequest.onCompleted.addListener(d=>answered.delete(d.requestId),{urls:["<all_urls>"]});
chrome.webRequest.onErrorOccurred.addListener(d=>answered.delete(d.requestId),{urls:["<all_urls>"]});

chrome.proxy.onProxyError.addListener(details=>{
    console.warn(LOG,"proxy error",details);
});

//---------------------------------------------------
// the proxy list
//---------------------------------------------------

async function loadList(force){

    const cached=await chrome.storage.local.get(["webshareList","webshareListAt"]);

    if(!force&&Array.isArray(cached.webshareList)&&cached.webshareList.length
        &&Date.now()-(cached.webshareListAt||0)<LIST_TTL){

        return cached.webshareList;

    }

    const key=await getApiKey();

    if(!key) throw new Error("No Webshare API key saved");

    // the API host is DIRECT in the PAC, so this call is never routed through a proxy that may
    // itself be the thing that is broken
    const response=await fetch(API_LIST,{headers:{Authorization:"Token "+key}});

    if(!response.ok){

        throw new Error(response.status===401
            ?"Webshare rejected the API key (401)"
            :"Webshare API returned HTTP "+response.status);

    }

    const data=await response.json();

    const list=(data.results||[])
        .filter(p=>p.valid&&p.proxy_address&&p.port)
        .map(p=>({
            id:p.id,
            host:p.proxy_address,
            port:p.port,
            username:p.username,
            password:p.password,
            country:p.country_code||"",
            city:p.city_name||""
        }));

    if(!list.length) throw new Error("Webshare returned no usable proxies");

    await chrome.storage.local.set({webshareList:list,webshareListAt:Date.now()});

    console.log(LOG,`loaded ${list.length} proxies`);

    return list;

}

//---------------------------------------------------
// picking the next exit IP
//
// Least blocked first, then least recently used. An IP that Indeed just 429'd is therefore the
// last one to come back around, and a full cycle is spent before any IP is reused.
//---------------------------------------------------

// An IP Cloudflare has decided to challenge is not slow or busy, it is refused: Indeed's edge
// scores the address itself, so the same IP answers with the same interstitial an hour later.
// Rotating onto it again only wastes a request, so it is out for the rest of the session.
function usable(list,state){

    const usage=state.usage||{};

    return list.filter(p=>!(usage[p.id]||{}).walled);

}

function pickNext(list,state){

    const usage=state.usage||{};
    const currentId=state.current&&state.current.id;
    const want=state.preferred||"";

    const pool=usable(list,state).filter(p=>p.id!==currentId);

    // country affinity is a preference, not a filter: a plan with no proxy in the target country
    // must still rotate
    const matching=want?pool.filter(p=>p.country===want):[];
    const candidates=matching.length?matching:pool;

    if(!candidates.length) return null;

    return candidates.slice().sort((a,b)=>{

        const ua=usage[a.id]||{blocks:0,lastUsed:0};
        const ub=usage[b.id]||{blocks:0,lastUsed:0};

        return ua.blocks-ub.blocks||ua.lastUsed-ub.lastUsed;

    })[0];

}

//---------------------------------------------------
// applying it
//---------------------------------------------------

function pacFor(proxy){

    const server=proxy.host+":"+proxy.port;

    // No "; DIRECT" fallback on purpose: if the proxy is down the request must fail, not quietly
    // go out on the real IP that is already being rate limited.
    return `function FindProxyForURL(url, host){
    host = ("" + host).toLowerCase();
    if (host === "ipv4.webshare.io") return "PROXY ${server}";
    if (host === "indeed.com" || host.slice(-11) === ".indeed.com") return "PROXY ${server}";
    return "DIRECT";
}`;

}

async function assertControllable(){

    const settings=await chrome.proxy.settings.get({});

    if(settings.levelOfControl==="controlled_by_other_extensions"){
        throw new Error("Another extension controls the proxy settings - disable it first");
    }

    if(settings.levelOfControl==="not_controllable"){
        throw new Error("Proxy settings are locked by policy on this machine");
    }

}

async function apply(proxy){

    await chrome.proxy.settings.set({

        scope:"regular",

        value:{
            mode:"pac_script",
            pacScript:{data:pacFor(proxy),mandatory:true}
        }

    });

    // the setting lands asynchronously in the network stack; a request sent immediately can still
    // take the old route
    await new Promise(r=>setTimeout(r,300));

}

async function clearProxy(){

    try{
        await chrome.proxy.settings.clear({scope:"regular"});
    }
    catch(e){
        console.warn(LOG,"could not clear the proxy settings",e);
    }

    await chrome.alarms.clear("proxy-auto-off");

}

// asks the proxy what IP it exits on. Non fatal: a failed check is worth reporting but not worth
// refusing a proxy that may only be slow.
async function checkIp(){

    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),CHECK_TIMEOUT);

    try{

        const response=await fetch(CHECK_URL+"?t="+Date.now(),{
            cache:"no-store",
            signal:controller.signal
        });

        if(!response.ok) return "";

        return (await response.text()).trim().split(/\s+/)[0]||"";

    }
    catch(e){

        console.warn(LOG,"IP check failed",e);

        return "";

    }
    finally{
        clearTimeout(timer);
    }

}

function describe(proxy,ip){

    if(!proxy) return "";

    const where=[proxy.city,proxy.country].filter(Boolean).join(", ");

    return (ip||proxy.host)+(where?" ("+where+")":"");

}

//---------------------------------------------------
// the operations content.js and the popup call
// Serialized through one chain: two rotations overlapping would leave the PAC and the credentials
// describing different proxies, and every request in between would fail auth.
//---------------------------------------------------

let chain=Promise.resolve();

function serialize(task){

    const run=chain.then(task,task);

    chain=run.then(()=>{},()=>{});

    return run;

}

async function heartbeat(){

    await chrome.alarms.clear("proxy-auto-off");
    await chrome.alarms.create("proxy-auto-off",{delayInMinutes:AUTO_OFF_MINUTES});

}

async function enable(preferred){

    await assertControllable();

    const list=await loadList(false);

    const state=await getState();

    state.preferred=COUNTRY_OF[(preferred||"").toLowerCase()]||"";

    const proxy=pickNext(list,state);

    if(!proxy) throw new Error(`all ${list.length} Webshare IP(s) are challenged by Indeed's Cloudflare`);

    await apply(proxy);

    const ip=await checkIp();

    state.enabled=true;
    state.current=proxy;
    state.usage=state.usage||{};
    state.usage[proxy.id]=Object.assign({blocks:0},state.usage[proxy.id],{lastUsed:Date.now()});

    await setState(state);
    await heartbeat();

    console.log(LOG,"proxy on:",describe(proxy,ip));

    // `seat` identifies WHICH IP a request went out on. The caller quotes it back when reporting a
    // block, which is how a block earned on an IP we have already left is told apart from one
    // earned on the IP we are on now - the first needs no rotation, the second does.
    // The pool it cares about is what it can still be moved to, not what the plan was sold as.
    return {ok:true,ip,seat:proxy.id,label:describe(proxy,ip),country:proxy.country,
        pool:usable(list,state).length,rotations:state.rotations};

}

async function rotate(reason){

    const state=await getState();

    if(!state.enabled) return {ok:false,error:"proxy is off"};

    const list=await loadList(false);

    if(state.current){

        const seen=state.usage[state.current.id]||{blocks:0,lastUsed:0};

        // only a real block counts against an IP; a scheduled swap must not push it to the back
        if(reason&&reason!=="scheduled") seen.blocks++;

        // a challenge is a verdict on the address, not on the pace it was used at
        if(reason==="challenge") seen.walled=true;

        seen.lastUsed=Date.now();

        state.usage[state.current.id]=seen;

    }

    const left=usable(list,state);

    // nothing to fall back to inside the pool - the caller has to go back to the real IP
    if(!left.length){

        await setState(state);

        return {ok:false,walled:true,
            error:`all ${list.length} Webshare IP(s) are challenged by Indeed's Cloudflare`};

    }

    const proxy=pickNext(list,state);

    if(!proxy||(state.current&&proxy.id===state.current.id)){
        return {ok:false,error:"no other proxy to switch to",pool:left.length};
    }

    await apply(proxy);

    const ip=await checkIp();

    state.current=proxy;
    state.rotations++;
    state.lastRotateAt=Date.now();
    state.lastIp=ip;
    state.usage[proxy.id]=Object.assign({blocks:0},state.usage[proxy.id],{lastUsed:Date.now()});

    await setState(state);
    await heartbeat();

    console.log(LOG,`rotated (${reason||"manual"}) ->`,describe(proxy,ip));

    // `seat` identifies WHICH IP a request went out on. The caller quotes it back when reporting a
    // block, which is how a block earned on an IP we have already left is told apart from one
    // earned on the IP we are on now - the first needs no rotation, the second does.
    // The pool it cares about is what it can still be moved to, not what the plan was sold as.
    return {ok:true,ip,seat:proxy.id,label:describe(proxy,ip),country:proxy.country,
        pool:usable(list,state).length,rotations:state.rotations};

}

async function disable(){

    await clearProxy();

    const state=await getState();

    state.enabled=false;
    state.current=null;

    await setState(state);

    console.log(LOG,"proxy off");

    return {ok:true};

}

//---------------------------------------------------
// the audit behind the popup's Check button
//
// A proxy being alive says nothing about whether it is any use here: Indeed sits behind Cloudflare
// and refuses a large share of datacentre addresses with a managed challenge, whatever the pace.
// So every IP is walked once against the real search page and the refused ones are retired before
// a crawl starts, instead of one wasted request each in the middle of it.
//---------------------------------------------------

const PROBE_TIMEOUT=15000;

async function probe(url){

    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),PROBE_TIMEOUT);

    try{

        const response=await fetch(url,{
            credentials:"omit",
            cache:"no-store",
            signal:controller.signal
        });

        return {
            status:response.status,
            // Cloudflare tags its own interstitials, so a 403 from Indeed itself is not mistaken
            // for an IP reputation block
            challenged:response.headers.get("cf-mitigated")==="challenge"
        };

    }
    catch(e){

        return {status:0,challenged:false,error:e&&e.message||String(e)};

    }
    finally{
        clearTimeout(timer);
    }

}

async function audit(preferred){

    await assertControllable();

    // forced: the audit is also how a pool replaced in the Webshare dashboard gets picked up, so
    // it must not answer out of a six hour old cache
    const list=await loadList(true);

    const root="https://"+((preferred||"sg").toLowerCase())+".indeed.com/jobs?q=engineer";

    const before=await getState();

    const state=await getState();

    state.preferred=COUNTRY_OF[(preferred||"").toLowerCase()]||"";
    state.usage=state.usage||{};

    const good=[];
    const walled=[];
    const dead=[];

    for(const proxy of list){

        await apply(proxy);

        // onAuthRequired reads the credentials back out of storage, so the seat has to be
        // published before anything is sent through it
        state.current=proxy;

        await setState(state);

        const verdict=await probe(root);

        const seen=Object.assign({blocks:0,lastUsed:0},state.usage[proxy.id]);

        if(verdict.status>=200&&verdict.status<400&&!verdict.challenged){

            seen.walled=false;

            good.push(proxy);

        }
        else if(verdict.challenged){

            seen.walled=true;

            walled.push(proxy);

        }
        else{

            // a timeout or a transport error is not a verdict on the address - it stays in the
            // pool and gets its chance during the crawl
            dead.push(proxy);

        }

        state.usage[proxy.id]=seen;

    }

    await setState(state);

    // put the browser back exactly as it was found
    if(before.enabled&&before.current) await apply(before.current);
    else await clearProxy();

    const state2=await getState();

    state2.enabled=before.enabled;
    state2.current=before.enabled?before.current:null;

    await setState(state2);

    return {
        ok:true,
        total:list.length,
        good:good.map(p=>p.host+" ("+[p.city,p.country].filter(Boolean).join(", ")+")"),
        walled:walled.length,
        dead:dead.length,
        root
    };

}

async function status(){

    const state=await getState();

    const cached=await chrome.storage.local.get(["webshareList","webshareListAt"]);

    const list=cached.webshareList||[];

    return {
        ok:true,
        enabled:state.enabled,
        label:describe(state.current,state.lastIp),
        country:state.current&&state.current.country||"",
        total:list.length,
        pool:usable(list,state).length,
        listAt:cached.webshareListAt||0,
        rotations:state.rotations
    };

}

//---------------------------------------------------
// wiring
//---------------------------------------------------

const HANDLERS={
    "proxy:enable":message=>enable(message.country),
    "proxy:rotate":message=>rotate(message.reason),
    "proxy:disable":()=>disable(),
    "proxy:audit":message=>audit(message.country),
    "proxy:status":()=>status(),
    "proxy:ping":async()=>{await heartbeat();return {ok:true};}
};

chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{

    const handler=message&&HANDLERS[message.type];

    if(!handler) return false;

    serialize(()=>handler(message))
        .then(sendResponse)
        .catch(e=>sendResponse({ok:false,error:e&&e.message||String(e)}));

    return true;

});

chrome.alarms.onAlarm.addListener(alarm=>{

    if(alarm.name!=="proxy-auto-off") return;

    console.warn(LOG,`no crawl activity for ${AUTO_OFF_MINUTES} minutes - clearing the proxy`);

    serialize(()=>disable());

});

// a reload of the extension leaves the old PAC in place, pointing at a worker that no longer knows
// the credentials -> start from a clean, unproxied browser every time
chrome.runtime.onStartup.addListener(()=>serialize(()=>disable()));
chrome.runtime.onInstalled.addListener(()=>serialize(()=>disable()));
