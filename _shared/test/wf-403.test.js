// Runs wellfound-company-crawler/content.js against the failure that was reported: every company
// detail page answers 403.
//
// The list page is readable (it is the tab the crawler was started on), so the run has its
// companies - what it cannot get is the profile behind each card, which is where Location and
// Employees come from. A 403 is the one status a real navigation answers differently, so every one
// of those companies must be reopened in a background tab.
//
// The COUNT is the point of this fixture, which is why it is not three companies. Eight refusals
// trip the crawler's 403 breaker, and from then on no plain request is sent at all - so every
// company left depends on the tab fallback, whose budget defaulted to a flat 80. Against the
// pre-fix content.js the first 80 companies come back from a tab and the remaining 70 get NEITHER
// a request nor a tab: they land in the file with Location and Employees blank, and the console
// says nothing at all about why the tabs stopped. Scaled to the 855 company search this was
// reported on, that is 775 companies.

const fs=require("fs");
const path=require("path");
const vm=require("vm");

const DIR=process.argv[2]||"./wellfound-company-crawler";

const ORIGIN="https://wellfound.com";
const LIST=ORIGIN+"/role/l/software-engineer";

// comfortably past both the breaker (8) and the old flat tab budget (80)
const COMPANIES=Array.from({length:150},(_,i)=>"company-"+i);

// content.js's own FORBIDDEN_LIMIT - consecutive 403s that mean "blocked", not "slow down"
const FORBIDDEN_LIMIT=8;

// every URL the crawler asked the worker to open, in order
const tabFetches=[];

// every URL fetch() was asked for, and what it answered
const fetches=[];

//---------------------------------------------------
// a DOM small enough to read
//---------------------------------------------------

function el(props){

    return Object.assign({
        nodeType:1,
        tagName:"DIV",
        textContent:"",
        childNodes:[],
        parentElement:null,
        classList:{contains:()=>false},
        getAttribute:()=>null,
        setAttribute(){},
        querySelector:()=>null,
        querySelectorAll:()=>list([]),
        contains:()=>false,
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

// core.blocks walks childNodes and only reads TEXT nodes, so a leaf needs a real one
function leaf(text,props){

    return el(Object.assign({
        textContent:text,
        childNodes:[{nodeType:3,nodeValue:text,childNodes:[]}]
    },props||{}));

}

//---------------------------------------------------
// the list page: one page, three company cards, one job each
//---------------------------------------------------

function cardFor(slug){

    const name="Company "+slug;

    const anchor=leaf(name,{tagName:"A",getAttribute:n=>n==="href"?"/company/"+slug:null});
    const heading=leaf(name,{tagName:"H2"});
    const job=leaf("Software Engineer",
        {tagName:"A",getAttribute:n=>n==="href"?"/jobs/900-software-engineer-"+slug:null});

    return el({
        getAttribute:n=>n==="data-testid"?"startup-header":null,
        querySelector:sel=>{

            if(sel==='a[href^="/company/"]') return anchor;
            if(sel==="h2") return heading;

            return null;

        },
        querySelectorAll:sel=>{

            // JOB_LINK
            if(/\/jobs\//.test(sel)) return list([job]);

            return list([]);

        }
    });

}

const cards=COMPANIES.map(cardFor);

const listDoc={
    body:leaf("results"),
    documentElement:el({}),
    querySelector:sel=>{

        // no pagination nav -> the crawler reads the open page only, which keeps this fixture
        // about the company pages rather than about paging
        return null;

    },
    querySelectorAll:sel=>{

        if(sel==='[data-testid="startup-header"]') return list(cards);

        return list([]);

    },
    createElement:()=>el({appendChild(){},style:{}}),
    addEventListener(){}
};

//---------------------------------------------------
// the company profile, as it comes back from a real navigation
//---------------------------------------------------

function companyDoc(){

    const pairs=[
        leaf("Location",{tagName:"DD"}),
        leaf("Berlin",{tagName:"DT"}),
        leaf("Company size",{tagName:"DD"}),
        leaf("51-200 employees",{tagName:"DT"})
    ];

    const dl=el({tagName:"DL",querySelectorAll:sel=>list(sel==="dt, dd"?pairs:[])});

    return {
        body:leaf("A company profile"),
        documentElement:el({}),
        querySelector:()=>null,
        querySelectorAll:sel=>list(sel==="dl"?[dl]:[]),
        createElement:()=>el({}),
        addEventListener(){}
    };

}

//---------------------------------------------------
// the sandbox
//---------------------------------------------------

const alerts=[];
const reports=[];
const warnings=[];

// a clock of its own: the gate parks the pool for seconds at a time and the fixture already
// knows the answer
let clock=0;

const sandbox={
    console:{
        log:()=>{},
        warn:(...a)=>warnings.push(a.map(x=>x&&x.stack||x).join(" ")),
        error:(...a)=>alerts.push("ERROR "+a.map(x=>x&&x.stack||x).join(" "))
    },
    alert:msg=>alerts.push(String(msg)),
    performance:{now:()=>(clock+=200)},
    setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms||0,1)),
    clearTimeout,setInterval,clearInterval,
    Date,Math,JSON,Promise,Set,Map,Array,Object,String,Number,RegExp,Error,
    isNaN,parseInt,parseFloat,Infinity,
    URL,URLSearchParams,
    Blob:class{constructor(){}},

    DOMParser:class{
        parseFromString(html){
            return /^COMPANY:/.test(html)?companyDoc():listDoc;
        }
    },

    // the whole point of the fixture: the cheap path is refused for every profile
    fetch:async url=>{

        const forbidden=/\/company\//.test(url);

        fetches.push((forbidden?"403 ":"200 ")+url);

        return {
            status:forbidden?403:200,
            ok:!forbidden,
            url,
            headers:{get:()=>null},
            text:async()=>forbidden?"<html>Forbidden</html>":"<html></html>"
        };

    },

    document:listDoc,

    location:{href:LIST,origin:ORIGIN,hostname:"wellfound.com",search:"",
        pathname:"/role/l/software-engineer"},

    chrome:{
        storage:{local:{
            get:async()=>({}),
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

                    // a REAL navigation renders, which is the whole point of the fallback
                    return {ok:true,html:"COMPANY:"+m.url,url:m.url};

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
    const total=COMPANIES.length;
    const refused=fetches.filter(f=>f.startsWith("403")).length;

    const missed=COMPANIES.filter(slug=>!tabFetches.includes(ORIGIN+"/company/"+slug));

    console.log("\nwellfound content.js - a 403 on every company page is answered by a tab\n");

    check("the run finished",/Done in/.test(summary),summary.slice(0,400)||"(nothing was alerted)");

    // the whole report: the tabs stopped part way and the rest of the run got nothing
    check("every company was reopened in a tab",!missed.length,
        missed.length+" of "+total+" never got a tab (first: "+missed.slice(0,5).join(", ")+")"
            +" - "+tabFetches.length+" tab(s) opened in total");

    check("...and none was opened twice",tabFetches.length===new Set(tabFetches).size,
        (tabFetches.length-new Set(tabFetches).size)+" duplicate tab(s)");

    check("the summary counts the rescue",
        new RegExp("Tabs: "+total+"/"+total+" page\\(s\\) rescued").test(summary),summary);

    check("the profile data the tab carried reached the file",
        new RegExp("Filled:\\s+"+total+" location").test(summary),summary);

    check("...including the headcount that only the profile has",
        new RegExp("Employees: "+total+" read").test(summary),summary);

    check("no company was written off as a failure",
        new RegExp("Exported:\\s+"+total+" row\\(s\\), 0 skipped by size, 0 request error\\(s\\)")
            .test(summary),summary);

    // the breaker has to keep the run off a path that is answering 403 to everything...
    check("the breaker stopped paying for refused requests",refused<total,
        refused+" refused fetches for "+total+" companies");

    // ...without latching for the rest of it: a block that lifts has to be noticed
    check("...but still re-tested the cheap path as the run went on",refused>FORBIDDEN_LIMIT*2,
        refused+" refused fetches - the breaker never let another request through");

    check("nothing threw",!alerts.some(a=>a.startsWith("ERROR")),
        alerts.filter(a=>a.startsWith("ERROR")).join("\n"));

    console.log(`\n${passed} passed, ${failed} failed`);

    process.exit(failed?1:0);

})();
