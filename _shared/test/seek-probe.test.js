// Runs seek-job-crawler/content.js against a search where NO company has a SEEK profile and no
// job ad publishes a headcount - the case the probe exists for. Asserts that it stops paying for
// lookups that are not answering, says so, and still writes every company to the file.

const fs=require("fs");
const path=require("path");
const vm=require("vm");

const DIR=process.argv[2];

const PAGE_SIZE=30;
const TOTAL=60;

let jobPageFetches=0;
let jobPageParses=0;

function text(t){
    return {nodeType:1,textContent:t,childNodes:[{nodeType:3,nodeValue:t}],
        querySelector:()=>null,querySelectorAll:()=>[],getAttribute:()=>null};
}

function card(i){

    const map={
        '[data-automation="jobTitle"]':text("Engineer "+i),
        '[data-automation="jobCompany"]':text("Company "+i),
        '[data-automation="jobLocation"]':text("Sydney NSW"),
        '[data-testid="work-arrangement"]':text("(Remote)")
    };

    const dateBox={...text("5d ago"),querySelector:sel=>sel==="span"?text("5d ago"):null};

    return {
        nodeType:1,
        textContent:"",
        childNodes:[],
        getAttribute:name=>name==="data-job-id"?"job"+i:null,
        querySelector:sel=>{

            // the whole point of this fixture: not one company has a profile link
            if(sel==='a[data-testid="job-card-company-logo-link"]') return null;
            if(sel==='[data-automation="jobListingDate"]') return dateBox;

            return map[sel]||null;

        },
        querySelectorAll:()=>[]
    };
}

function cardList(from){

    const list=[];

    for(let i=from;i<from+PAGE_SIZE;i++) list.push(card(i));

    list.forEach=Array.prototype.forEach.bind(list);

    return list;
}

const summary={
    getAttribute:name=>name==="data-sol-meta"
        ? JSON.stringify({pageSize:PAGE_SIZE,pageNumber:1,totalJobCount:TOTAL})
        : null
};

function resultsDoc(from){
    return {
        body:text(""),
        querySelector:sel=>sel==='[data-automation="searchResultSummary"]'?summary:null,
        querySelectorAll:sel=>sel==='article[data-testid="job-card"]'?cardList(from):[]
    };
}

// a job ad with no headcount anywhere in it - `needs` should keep it out of the parser entirely
const emptyish={
    body:text(""),
    querySelector:()=>null,
    querySelectorAll:()=>[]
};

const alerts=[];
const reports=[];

const sandbox={
    console:{log:()=>{},warn:()=>{},error:(...a)=>alerts.push("ERROR "+a.map(x=>x&&x.stack||x).join(" "))},
    alert:msg=>alerts.push(String(msg)),
    performance:{now:()=>Date.now()},
    setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms||0,3)),
    clearTimeout,setInterval,clearInterval,
    Date,Math,JSON,Promise,Set,Map,Array,Object,String,Number,RegExp,Error,isNaN,parseInt,parseFloat,Infinity,
    URL,URLSearchParams,
    Blob:class{constructor(){}},

    DOMParser:class{
        parseFromString(html){

            if(html.indexOf("PAGE2")>=0) return resultsDoc(PAGE_SIZE);

            if(html.indexOf("JOBAD")>=0) jobPageParses++;

            return emptyish;

        }
    },

    fetch:async url=>{

        const page2=url.indexOf("page=2")>=0;

        if(!page2) jobPageFetches++;

        return {
            status:200,ok:true,url,headers:{get:()=>null},
            text:async()=>page2
                ?"<html>PAGE2</html>"
                :"<html>JOBAD - a great place to work, apply now</html>"
        };

    },

    document:{
        ...resultsDoc(0),
        createElement:()=>({style:{},click(){},remove(){}}),
        body:{appendChild(){}}
    },

    location:{href:"https://au.seek.com.au/jobs?page=1",origin:"https://au.seek.com.au",
        hostname:"au.seek.com.au",search:"?page=1",pathname:"/jobs"},

    chrome:{
        storage:{local:{get:async()=>({concurrency:10}),set:async()=>{},remove:async()=>{}}},
        runtime:{sendMessage:async m=>{
            if(m&&m.text) reports.push(m.text);
            return {ok:false,error:"stub"};
        },onMessage:{addListener(){}}}
    }
};

sandbox.window=sandbox;
sandbox.self=sandbox;

URL.createObjectURL=()=>"blob:stub";
URL.revokeObjectURL=()=>{};

const context=vm.createContext(sandbox);

for(const file of ["core.js","content.js"]){
    vm.runInContext(fs.readFileSync(path.join(DIR,file),"utf8"),context,{filename:file});
}

let passed=0,failed=0;

function check(name,ok,detail){
    if(ok){passed++;console.log("  pass  "+name);}
    else{failed++;console.log("  FAIL  "+name+(detail?"  -> "+detail:""));}
}

setTimeout(()=>{

    const summaryText=alerts.join("\n");

    console.log("\nseek content.js - a lookup that is not answering is stopped, not repeated\n");

    check("the run finished",/Done in/.test(summaryText),summaryText.slice(0,300));

    check("every company still reached the file",/60 companies from 60 jobs/.test(summaryText),
        summaryText.slice(0,300));

    const dropped=/(\d+) job ad lookup\(s\) skipped/.exec(summaryText);

    check("it said out loud that it stopped",!!dropped,summaryText);

    if(dropped){

        const n=+dropped[1];

        check("and stopped well short of all 60",n>=20&&n<60,"skipped "+n);
        check("having spent only the sample on them",jobPageFetches===60-n,
            `${jobPageFetches} job ad fetches, ${n} skipped`);

    }

    // the other half of the saving: a body that cannot hold a headcount never reaches DOMParser
    check("and never built a tree for a body with no size in it",jobPageParses===0,
        String(jobPageParses));

    check("the timing breakdown is in the summary",/Time: [\d.]+s on 2 result page\(s\), [\d.]+s on \d+ company page\(s\)/.test(summaryText),
        summaryText);

    console.log(`\n${passed} passed, ${failed} failed`);

    process.exit(failed?1:0);

},3000);
