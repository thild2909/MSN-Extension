// Runs ctgoodjobs-crawler/content.js against the failure this fallback was built for: the live
// tab turns to page 2 and then the app stops answering its own page request, so the list never
// swaps again. That is what a 40 page search actually did - it stopped at page 28 and wrote a file
// missing a third of the results.
//
// The walk must NOT read that as the end of the list. It must reopen the remaining pages as real
// navigations in a background tab, collect them, and say in the summary that it did.

const fs=require("fs");
const path=require("path");
const vm=require("vm");

const DIR=process.argv[2]||"./ctgoodjobs-crawler";

const PAGES=5;
const PER_PAGE=3;

// the page the live paginator stops being able to reach - everything from here needs a tab
const REFUSED_FROM=3;

const ORIGIN="https://jobs.ctgoodjobs.hk";
const PATH="/software-engineer-jobs";

// what the live tab is currently showing
let livePage=1;

// every URL the crawler asked the worker to open, in order
const tabFetches=[];

//---------------------------------------------------
// a DOM small enough to read, big enough to walk
//---------------------------------------------------

function el(props){

    return Object.assign({
        nodeType:1,
        textContent:"",
        childNodes:[],
        classList:{contains:()=>false},
        getAttribute:()=>null,
        setAttribute(){},
        querySelector:()=>null,
        querySelectorAll:()=>list([]),
        click(){},
        style:{},
        appendChild(){},
        remove(){}
    },props||{});

}

function list(items){

    const arr=items.slice();

    arr.forEach=Array.prototype.forEach.bind(arr);

    return arr;

}

function text(t){
    return el({textContent:t});
}

// Every way the crawler asks for the job cards on a page.
//
// This stub matches selector STRINGS rather than parsing them, so it has to be told when one is
// rewritten. collectFrom asks for ".job-card" - it must see a card whose data-job-id is missing,
// rather than have the selector hide it and read the page as empty - while the paginator's own
// waits still ask for ".job-card[data-job-id]". Both mean "the job cards", so both answer here;
// pinning the stub to one literal made a legitimate selector change look like a crawler that had
// stopped finding anything at all.
function isCardSelector(sel){
    return sel===".job-card"||sel===".job-card[data-job-id]";
}

// one .job-card, laid out the way readCard reads it
function card(page,i){

    const n=(page-1)*PER_PAGE+i;

    const map={
        "a.jc-position":el({textContent:"Engineer "+n,getAttribute:name=>name==="href"?"/job/"+n:null}),
        "a.jc-position h2":text("Engineer "+n),
        "a.jc-company":el({textContent:"Company "+n,
            getAttribute:name=>name==="href"?"/company-jobs/000138"+n+"/company-"+n:null}),
        ".jc-info .col-12":text("Hong Kong"),
        ".jc-other div:not(.btn)":text("6d ago"),
        ".jc-other .btn":null
    };

    return el({
        getAttribute:name=>name==="data-job-id"?"job"+n:null,
        querySelector:sel=>map[sel]||null,
        querySelectorAll:sel=>list(sel===".jc-info .col-6"
            ? [text("3 - 5 yr(s)"),text("25k - 35k")]
            : [])
    });

}

function cardsOf(page){

    const out=[];

    for(let i=0;i<PER_PAGE;i++) out.push(card(page,i));

    return list(out);

}

//---------------------------------------------------
// the paginator
//
// Clicking "next" moves the list only while the app is still answering. Past REFUSED_FROM the
// click lands on the anchor and nothing happens at all - no error, no new cards - which is exactly
// what a 405 on the app's own page request looks like from the page.
//---------------------------------------------------

function pagerNav(){

    const next=el({
        getAttribute:name=>name==="aria-label"?"Go to next page":name==="href"?PATH+"?page=2":null,
        // the click lands, the app asks for the next page, and from REFUSED_FROM on it is answered
        // with a 405 - so nothing at all changes on screen
        click(){
            if(livePage+1<REFUSED_FROM) livePage++;
        }
    });

    const numbered=el({
        textContent:"2",
        getAttribute:name=>name==="aria-label"?"Go to page 2":name==="href"?PATH+"?page=2":null
    });

    const last=el({
        getAttribute:name=>name==="aria-label"?"Go to last page ("+PAGES+")"
            :name==="href"?PATH+"?page="+PAGES:null
    });

    const active=el({
        textContent:String(livePage),
        getAttribute:name=>name==="aria-current"?"page":null
    });

    return el({
        querySelector:sel=>{
            if(sel==='a[aria-current="page"]') return active;
            if(sel==='a[aria-label^="Go to next page"]') return next;
            if(sel==='a[aria-label^="Go to last page"]') return last;
            if(sel==='a[aria-label^="Go to first page"]') return null;
            return null;
        },
        querySelectorAll:sel=>list(sel==="a[href][aria-label]"?[numbered,last]:[])
    });

}

function docFor(page){

    return {
        body:el({}),
        documentElement:el({}),
        querySelector:sel=>{

            if(sel==="ul.page-control") return pagerNav();

            // clickPager reads the active page off the DOCUMENT, not off the nav it just clicked
            if(sel==='ul.page-control a[aria-current="page"]'){
                return pagerNav().querySelector('a[aria-current="page"]');
            }

            // firstCardId - the other half of what clickPager waits for
            if(isCardSelector(sel)) return cardsOf(page)[0]||null;

            if(sel===".no-of-jobs") return text(String(PAGES*PER_PAGE)+" jobs");

            return null;

        },
        querySelectorAll:sel=>list(isCardSelector(sel)?cardsOf(page):[]),
        createElement:()=>el({}),
        addEventListener(){}
    };

}

//---------------------------------------------------
// the sandbox
//---------------------------------------------------

const alerts=[];
const reports=[];

// A clock that runs on its own, not on the wall. clickPager waits PAGE_TIMEOUT=15000ms for a page
// that is never coming, three times over - twelve real minutes of test for a fixture that already
// knows the answer. Advancing 200ms per reading gets there in a fraction of a second and changes
// nothing about which branch the crawler takes.
let clock=0;

const liveDoc={
    get body(){return el({appendChild(){}});},
    querySelector:sel=>docFor(livePage).querySelector(sel),
    querySelectorAll:sel=>docFor(livePage).querySelectorAll(sel),
    createElement:()=>el({}),
    addEventListener(){}
};

const sandbox={
    console:{
        log:()=>{},
        warn:()=>{},
        error:(...a)=>alerts.push("ERROR "+a.map(x=>x&&x.stack||x).join(" "))
    },
    alert:msg=>alerts.push(String(msg)),
    performance:{now:()=>(clock+=200)},
    setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms||0,1)),
    clearTimeout,setInterval,clearInterval,
    Date,Math,JSON,Promise,Set,Map,Array,Object,String,Number,RegExp,Error,isNaN,parseInt,parseFloat,Infinity,
    URL,URLSearchParams,
    Blob:class{constructor(){}},

    // the worker hands back rendered HTML; here the "html" is just a page marker
    DOMParser:class{
        parseFromString(html){

            const m=/^PAGE:(\d+)$/.exec(html);

            return m?docFor(+m[1]):docFor(0);

        }
    },

    document:liveDoc,

    location:{href:ORIGIN+PATH+"?page=1",origin:ORIGIN,hostname:"jobs.ctgoodjobs.hk",
        search:"?page=1",pathname:PATH},

    chrome:{
        storage:{local:{
            // the work model is read by clicking the results panel, which has nothing to do with
            // the path under test - turn it off so the fixture stays about pagination
            get:async()=>({readModel:false}),
            set:async()=>{},
            remove:async()=>{}
        }},
        runtime:{
            sendMessage:async m=>{

                if(!m) return {ok:false,error:"stub"};

                if(m.text!==undefined){
                    reports.push(m.text);
                    return {ok:true};
                }

                if(m.type==="tab:ping") return {ok:true};

                if(m.type==="tab:fetch"){

                    tabFetches.push(m.url);

                    const page=+new URL(m.url).searchParams.get("page")||0;

                    // a REAL navigation renders, which is the whole point of the fallback
                    return {ok:true,html:"PAGE:"+page,url:m.url};

                }

                return {ok:false,error:"stub"};

            },
            onMessage:{addListener(){}}
        }
    }
};

sandbox.window=sandbox;
sandbox.self=sandbox;
sandbox.addEventListener=()=>{};

URL.createObjectURL=()=>"blob:stub";
URL.revokeObjectURL=()=>{};

const context=vm.createContext(sandbox);

for(const file of ["core.js","content.js"]){
    vm.runInContext(fs.readFileSync(path.join(DIR,file),"utf8"),context,{filename:file});
}

//---------------------------------------------------
// what has to be true
//---------------------------------------------------

let passed=0,failed=0;

function check(name,ok,detail){
    if(ok){passed++;console.log("  pass  "+name);}
    else{failed++;console.log("  FAIL  "+name+(detail?"  -> "+detail:""));}
}

const DEADLINE=Date.now()+60000;

(function waitForRun(){

    if(!alerts.length&&Date.now()<DEADLINE) return setTimeout(waitForRun,50);

    const summary=alerts.join("\n");
    const progress=reports.join("\n");

    console.log("\nctgoodjobs content.js - a paginator that stops turning is not the end of the list\n");

    check("the run finished",/Done in/.test(summary),summary.slice(0,400)||"(nothing was alerted)");

    // 5 pages x 3 cards. Before the fallback this stopped at page 2 and wrote 6.
    check("every page reached the file",/from 15 jobs/.test(summary),summary.slice(0,400));

    check("...and the search is reported complete",/of 15 on the platform - complete/.test(summary),
        summary.slice(0,400));

    check("the refused pages were reopened, in order",
        tabFetches.join(",")===[3,4,5].map(p=>ORIGIN+PATH+"?page="+p).join(","),
        tabFetches.join(",")||"(no tab was ever opened)");

    check("the live tab was not asked for a page it could not turn to",
        !tabFetches.some(u=>/page=[12]$/.test(u)),tabFetches.join(","));

    check("each rescued page said so as it went",
        (progress.match(/\(read in a background tab\)/g)||[]).length===3,progress);

    check("the summary explains why those companies have no work model",
        /3 page\(s\) would not turn in this tab and were reopened in a background tab/.test(summary),
        summary);

    check("...and counts the rescue",/Tabs: 3\/3 page\(s\) rescued/.test(summary),summary);

    check("nothing threw",!alerts.some(a=>a.startsWith("ERROR")),
        alerts.filter(a=>a.startsWith("ERROR")).join("\n"));

    console.log(`\n${passed} passed, ${failed} failed`);

    process.exit(failed?1:0);

})();
