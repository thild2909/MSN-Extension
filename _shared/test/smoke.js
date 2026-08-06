// Runs each crawler's content.js against a stubbed browser so ReferenceErrors, bad wiring and
// crashes in the export path surface without loading the extension into Chrome.
//
// The DOM stub is deliberately generic: any selector that looks like a card selector yields fake
// cards, so each crawler gets past "nothing found" and walks its real pagination + export path.

const fs=require("fs");
const path=require("path");
const vm=require("vm");

const ROOT=process.argv[2];

function fakeEl(depth){

    const el={
        __el:true,
        textContent:"51 to 200 Employees 3 days ago Remote",
        nodeType:1,
        childNodes:[],
        classList:{contains:()=>false},
        disabled:false,
        parentElement:depth>0?null:null,
        getAttribute:name=>{
            if(name==="href") return "/company/acme?x=1";
            if(name==="datetime") return "2026-08-01T09:00:00+02:00";
            if(name==="data-sol-meta") return JSON.stringify({pageSize:20,pageNumber:1,totalJobCount:60});
            if(name==="aria-label") return "Go to page 2";
            if(name==="data-jk"||name==="data-job-id"||name==="data-jobid") return "job"+(depth||0);
            if(name==="id") return "job-item-123";
            if(name==="title") return "Software Engineer";
            if(name==="data-testid") return "pagination-button--0";
            if(name==="data-brandviews") return "eid=658";
            if(name==="aria-current") return null;
            return null;
        },
        setAttribute(){},
        querySelector:sel=>depth>3?null:fakeEl((depth||0)+1),
        querySelectorAll:sel=>depth>2?[]:[fakeEl((depth||0)+1)],
        click(){},
        scrollIntoView(){},
        remove(){},
        appendChild(){},
        style:{}
    };

    el.querySelectorAll=sel=>{

        if(depth>2) return listOf([]);

        return listOf([fakeEl((depth||0)+1)]);

    };

    return el;

}

function listOf(items){

    const arr=items.slice();

    arr.forEach=Array.prototype.forEach.bind(arr);

    return arr;

}

function makeDoc(){

    const doc={
        body:fakeEl(1),
        documentElement:fakeEl(1),
        querySelector:sel=>fakeEl(1),
        querySelectorAll:sel=>listOf([fakeEl(1),fakeEl(1)]),
        createElement:()=>fakeEl(1),
        addEventListener(){},
        location:{href:"https://example.com/jobs?q=engineer&page=1"}
    };

    return doc;

}

function run(dir){

    const alerts=[];
    const errors=[];
    const warnings=[];

    const doc=makeDoc();

    const storage={};

    const sandbox={
        console:{
            log:()=>{},
            warn:(...a)=>warnings.push(a.join(" ")),
            error:(...a)=>errors.push(a.map(x=>x&&x.stack||x).join(" "))
        },
        alert:msg=>alerts.push(String(msg)),
        performance:{now:()=>Date.now()},
        setTimeout:(fn,ms)=>{ if(!ms) setImmediate(fn); return 0; },
        clearTimeout:()=>{},
        Date,Math,JSON,Promise,Set,Map,Array,Object,String,Number,RegExp,Error,isNaN,parseInt,parseFloat,Infinity,
        URL,URLSearchParams,TextDecoder,TextEncoder,
        Blob:class{constructor(){}},
        DOMParser:class{parseFromString(){return makeDoc();}},
        fetch:async url=>({
            status:200,
            ok:true,
            url,
            headers:{get:()=>null},
            text:async()=>"<html></html>"
        }),
        document:doc,
        location:{href:"https://example.com/jobs?q=engineer&page=1",origin:"https://example.com",
            hostname:"example.com",search:"?q=engineer&page=1",pathname:"/jobs"},
        chrome:{
            storage:{
                local:{
                    get:async()=>({}),
                    set:async o=>Object.assign(storage,o),
                    remove:async()=>{}
                },
                session:{get:async()=>({}),set:async()=>{}}
            },
            runtime:{
                sendMessage:async()=>({ok:false,error:"stub"}),
                onMessage:{addListener(){}}
            }
        },
        XLSX:{
            utils:{
                json_to_sheet:()=>({}),
                book_new:()=>({}),
                book_append_sheet:()=>{}
            },
            write:()=>new Uint8Array(4)
        }
    };

    sandbox.addEventListener=()=>{};
    sandbox.removeEventListener=()=>{};
    sandbox.scrollBy=()=>{};
    sandbox.window=sandbox;
    sandbox.self=sandbox;
    sandbox.globalThis=sandbox;

    URL.createObjectURL=()=>"blob:stub";
    URL.revokeObjectURL=()=>{};
    sandbox.URL=Object.assign(function(u,b){return new URL(u,b);},URL);
    sandbox.URL=URL;

    const context=vm.createContext(sandbox);

    for(const file of ["core.js","content.js"]){

        const src=fs.readFileSync(path.join(ROOT,dir,file),"utf8");

        try{
            vm.runInContext(src,context,{filename:dir+"/"+file});
        }
        catch(e){
            return {dir,fatal:file+": "+(e&&e.stack||e)};
        }

    }

    return {dir,alerts,errors,warnings};

}

const dirs=fs.readdirSync(ROOT).filter(d=>d.endsWith("-crawler"));

let failed=0;

(async()=>{

    for(const dir of dirs){

        const result=run(dir);

        // the IIFE is async: let its microtasks and timers drain
        await new Promise(r=>setTimeout(r,400));

        if(result.fatal){
            failed++;
            console.log("FATAL  "+dir+"\n       "+result.fatal.split("\n").slice(0,4).join("\n       "));
            continue;
        }

        const refErrors=[]
            .concat(result.errors.filter(t=>/ReferenceError|TypeError|is not defined|is not a function/.test(t)))
            .concat(result.alerts.filter(t=>/is not defined|is not a function|Cannot read/.test(t)));

        if(refErrors.length){
            failed++;
            console.log("BROKEN "+dir);
            refErrors.slice(0,3).forEach(t=>console.log("       "+t.split("\n")[0]));
        }
        else{
            console.log("OK     "+dir+"   ("+result.alerts.length+" alert(s): "
                +(result.alerts[0]||"none").split("\n")[0].slice(0,90)+")");
        }

    }

    process.exit(failed?1:0);

})();
