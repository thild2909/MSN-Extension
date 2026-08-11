// Runs each crawler's content.js against a stubbed browser so ReferenceErrors, bad wiring and
// crashes in the export path surface without loading the extension into Chrome.
//
// The DOM stub is deliberately generic: any selector that looks like a card selector yields fake
// cards, so each crawler gets past "nothing found" and walks its real pagination + export path.

const fs=require("fs");
const path=require("path");
const vm=require("vm");

const ROOT=process.argv[2];

// how long one crawler gets to run against the stub before it is called stalled
const RUN_LIMIT=20000;

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
            // Carries what every crawler wants out of a link at once: a /company/ path, and the
            // 32 hex character uuid MyCareersFuture takes its job id from. Without the uuid, MCF
            // skipped every card, reported "No jobs found" and returned - so its whole detail
            // phase, its grouping and its export path were never run here.
            if(name==="href") return "/company/acme/job-0123456789abcdef0123456789abcdef?x=1";
            if(name==="datetime") return "2026-08-01T09:00:00+02:00";
            if(name==="data-sol-meta") return JSON.stringify({pageSize:20,pageNumber:1,totalJobCount:60});
            if(name==="aria-label") return "Go to page 2";
            if(name==="data-jk"||name==="data-job-id"||name==="data-jobid") return "job"+(depth||0);
            // Dice identifies a card by data-id / data-job-guid. Without them every card was
            // dropped, the crawler reported "No job cards found" and returned - so its grouping
            // and its whole export path went unrun here, which is exactly what this file is for.
            if(name==="data-id"||name==="data-job-guid") return "job"+(depth||0);
            if(name==="id") return "job-item-123";
            if(name==="title") return "Software Engineer";
            if(name==="data-testid") return "pagination-button--0";
            if(name==="data-brandviews") return "eid=658";
            if(name==="aria-current") return null;
            return null;
        },
        setAttribute(){},
        // every fakeEl is minted fresh, so no two of them are ever related
        contains:()=>false,
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

        // Delays are squashed, not dropped. Returning 0 and never running the callback meant any
        // crawler that waits for something - Glassdoor's whole "Show more jobs" loop - simply
        // stopped here and its export path was never reached, so it passed by not running.
        setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms||0,3)),
        clearTimeout:id=>clearTimeout(id),
        setInterval:(fn,ms)=>setInterval(fn,Math.min(ms||0,3)),
        clearInterval:id=>clearInterval(id),

        // The stub DOM never mutates, which is the honest simulation: the crawler has to fall
        // back to its own timeout and decide the list has ended, rather than hanging.
        MutationObserver:class{
            constructor(){}
            observe(){}
            disconnect(){}
            takeRecords(){return [];}
        },
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

// _shared/core.js and _shared/tabs.js are the source of truth and every crawler carries a copy,
// because a Chrome extension can only load files inside its own folder. Nothing enforced that they
// stayed in step, so a fix could land in one crawler and quietly miss the other six - which is
// exactly how the Indeed copy drifted into its own generation of the fetcher. Check it here, where
// it costs nothing, rather than finding out from a crawl.
//
// tabs.js is only expected where a worker is declared - hasWorker(dir) below, not a hard-coded
// list, so a crawler that grows one (ctgoodjobs did, for its paginator) is covered without an edit.
(function checkSharedCopies(){

    for(const file of ["core.js","tabs.js"]){

        const master=path.join(ROOT,"_shared",file);

        if(!fs.existsSync(master)) continue;

        const truth=fs.readFileSync(master,"utf8");

        for(const dir of dirs){

            const copy=path.join(ROOT,dir,file);

            if(!fs.existsSync(copy)){

                // core.js is required everywhere; tabs.js only where a worker is declared
                if(file==="core.js"||hasWorker(dir)){
                    failed++;
                    console.log("STALE  "+dir+"/"+file+" is missing");
                }

                continue;

            }

            if(fs.readFileSync(copy,"utf8")!==truth){
                failed++;
                console.log("STALE  "+dir+"/"+file+" differs from _shared/"+file
                    +" - re-copy it (see _shared/README.md)");
            }

        }

    }

})();

// A worker that content.js talks to but the manifest never registers is the quietest possible
// failure: chrome.runtime.sendMessage simply never answers, the tab fallback marks itself broken
// on the first refusal, and the run looks like an ordinary bad day on the site.
(function checkWorkerWiring(){

    for(const dir of dirs){

        const worker=path.join(ROOT,dir,"background.js");

        if(!fs.existsSync(worker)) continue;

        const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,dir,"manifest.json"),"utf8"));

        if(!manifest.background||manifest.background.service_worker!=="background.js"){
            failed++;
            console.log("UNWIRED "+dir+" has background.js but no background.service_worker in its manifest");
        }

        if(fs.readFileSync(worker,"utf8").includes('importScripts("tabs.js")')
            &&!(manifest.permissions||[]).includes("tabs")){
            failed++;
            console.log("UNWIRED "+dir+' uses the tab fallback but its manifest lacks the "tabs" permission');
        }

    }

})();

function hasWorker(dir){
    return fs.existsSync(path.join(ROOT,dir,"background.js"));
}

//---------------------------------------------------
// a clean run pays nothing
//
// The gate spaces request STARTS by `minGap`, so a floor above zero is not merely a delay - it
// caps how many requests can overlap, at one page's load time divided by the gap. Indeed shipped
// with 120ms and its "parallel 8" ran three at a time, finishing in exactly the time "parallel 3"
// took: everything above 3 in its popup was decoration, and nobody could see that from the code.
//
// The rule is the one the engine's own comment states: nothing is paid until the site actually
// pushes back. The first refusal still jumps the gap to max(250, gap) x 1.7 straight away.
//---------------------------------------------------

(function checkNoIdleToll(){

    for(const dir of dirs){

        const file=path.join(ROOT,dir,"content.js");

        if(!fs.existsSync(file)) continue;

        const src=fs.readFileSync(file,"utf8");

        for(const call of src.matchAll(/makeGate\(\{([^}]*)\}/g)){

            const found=/minGap\s*:\s*([A-Za-z_$][\w$]*|\d+)/.exec(call[1]);

            if(!found){
                failed++;
                console.log("TOLL   "+dir+" calls makeGate without saying minGap - it defaults to 0, "
                    +"but say so, because this is the number that decides how fast a clean run goes");
                continue;
            }

            let value=found[1];

            // Indeed passes a named constant; resolve it rather than waving it through
            if(!/^\d+$/.test(value)){

                const decl=new RegExp("^\\s*const "+value+"=(\\d+);","m").exec(src);

                if(!decl){
                    failed++;
                    console.log("TOLL   "+dir+" passes minGap:"+value+" and this check cannot resolve it");
                    continue;
                }

                value=decl[1];

            }

            if(+value!==0){
                failed++;
                console.log("TOLL   "+dir+" pays "+value+"ms on every request even when nothing is "
                    +"refused, which also caps parallelism at pageTime/"+value+"ms");
            }

        }

    }

})();

//---------------------------------------------------
// const/let used before the line that creates it
//
// Every crawler is one long async IIFE with a `try` in the middle that does the whole crawl, and
// helper functions after it. A `function` declaration hoists, so putting a helper at the bottom is
// fine - but a `const` next to it does NOT, and the try block runs long before the file reaches
// that line. Referencing it throws "Cannot access X before initialization" the first time the
// helper runs, which on a per-company helper is once per company.
//
// This has now happened four times (`DELAY`, `batchMs`, `sameSite`, `overviews`), and the runtime
// smoke run only catches it when the stub DOM happens to reach that exact branch. Reading it
// straight off the source catches it every time and costs nothing.
//---------------------------------------------------

(function checkDeadZone(){

    for(const dir of dirs){

        const file=path.join(ROOT,dir,"content.js");

        if(!fs.existsSync(file)) continue;

        const src=fs.readFileSync(file,"utf8");

        // where the crawl itself starts - everything before it has already been initialised
        const tryAt=src.indexOf("\n    try{");

        if(tryAt<0) continue;

        const lines=src.split("\n");

        // strings and comments are not references, and this only has to be right about names
        const strip=text=>text
            .replace(/\/\*[\s\S]*?\*\//g,"")
            .replace(/(^|[^:])\/\/.*$/gm,"$1")
            .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g,"``")
            .replace(/"(?:\\.|[^"\\])*"/g,'""')
            .replace(/'(?:\\.|[^'\\])*'/g,"''");

        const afterTry=strip(src.slice(tryAt));

        // top-level declarations only: four spaces of indent, the IIFE's own body
        for(const match of afterTry.matchAll(/^ {4}(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm)){

            const name=match[1];

            const pattern=new RegExp("\\b"+name+"\\b","g");

            // Any use at all, not just uses textually inside the try. The helper functions below
            // the try are hoisted and get called from inside it, so a const they close over is
            // read long before the line that creates it - which is exactly how `overviews` got
            // through: nothing named it inside the try, only overviewOf() did, and the try called
            // overviewOf(). One reference beyond the declaration itself is enough to be unsafe.
            const uses=(afterTry.match(pattern)||[]).length;

            if(uses<2) continue;

            failed++;

            const line=lines.findIndex(text=>new RegExp("^ {4}(?:const|let)\\s+"+name+"\\s*=").test(text))+1;

            console.log("DEADZONE "+dir+"/content.js:"+line+" `"+name+"` is used inside the try "
                +"block but declared after it - move it above the try");

        }

    }

})();

// The worker turns each host_permission into a regex and refuses to open anything else. Both
// directions matter and both have been wrong: too strict once refused glassdoor.com itself (the
// one host the crawler is always on), and too loose would let "sg.indeed.com.evil.com" through.
// Checked against every crawler's REAL manifest, so adding a country domain is covered too.
(function checkHostPatterns(){

    const worker=path.join(ROOT,"_shared","tabs.js");

    if(!fs.existsSync(worker)) return;

    const src=fs.readFileSync(worker,"utf8");

    function permitterFor(hosts){

        const sandbox={
            console:{log:()=>{},warn:()=>{}},
            setTimeout,clearTimeout,RegExp,Date,Promise,Math,JSON,
            chrome:{
                runtime:{getManifest:()=>({host_permissions:hosts}),onMessage:{addListener(){}}},
                tabs:{},scripting:{},windows:{}
            }
        };

        vm.createContext(sandbox);
        vm.runInContext(src,sandbox,{filename:"tabs.js"});

        return sandbox.permitted;

    }

    for(const dir of dirs){

        if(!hasWorker(dir)) continue;

        const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,dir,"manifest.json"),"utf8"));
        const hosts=manifest.host_permissions||[];
        const permitted=permitterFor(hosts);

        for(const pattern of hosts){

            // the host the pattern names, with the "*." prefix (if any) dropped
            const host=pattern.replace(/^https:\/\//,"").replace(/\/\*$/,"").replace(/^\*\./,"");

            const cases=[
                ["https://"+host+"/anything",true],
                ["http://"+host+"/anything",false],
                ["https://"+host+".evil.example/x",false],
                ["https://evil.example/?u=https://"+host+"/",false]
            ];

            for(const [url,want] of cases){

                if(permitted(url)!==want){
                    failed++;
                    console.log("HOSTS  "+dir+": tabs.js "+(want?"refuses":"would open")+" "+url
                        +"  (from "+pattern+")");
                }

            }

        }

    }

})();

(async()=>{

    for(const dir of dirs){

        const result=run(dir);

        // Wait for the crawler to REACH ITS END rather than for a fixed 400ms.
        //
        // Every crawler finishes by alerting its summary, so that is the signal. A flat wait meant
        // whichever crawler happened to be slower than it - ctgoodjobs, which sits out a 4 second
        // panel timeout per company - was cut off part way and reported as a pass on the strength
        // of having produced no errors yet. Nothing past the point it was cut off had any cover at
        // all, which is exactly where a bug hides.
        const until=Date.now()+RUN_LIMIT;

        while(Date.now()<until&&!result.alerts.length&&!result.fatal){
            await new Promise(r=>setTimeout(r,50));
        }

        // an alert fires before the last of the logging, so let the tail land
        await new Promise(r=>setTimeout(r,150));

        if(!result.alerts.length&&!result.fatal){
            failed++;
            console.log("STALLED "+dir+" never reached its summary within "+(RUN_LIMIT/1000)+"s"
                +(result.warnings.length?" - last: "+result.warnings[result.warnings.length-1].slice(0,90):""));
            continue;
        }

        if(result.fatal){
            failed++;
            console.log("FATAL  "+dir+"\n       "+result.fatal.split("\n").slice(0,4).join("\n       "));
            continue;
        }

        // A crash inside a mapPool worker never reaches console.error: the pool catches it on
        // purpose, so that one bad company cannot end the run, and reports it with console.warn.
        // Scanning only errors and alerts therefore missed an entire class - a ReferenceError
        // thrown by every single worker showed up here as a clean pass, because the crawler
        // dutifully carried on and wrote a file with the column empty.
        const BROKEN=/ReferenceError|TypeError|is not defined|is not a function|before initialization|Cannot read/;

        const refErrors=[]
            .concat(result.errors.filter(t=>BROKEN.test(t)))
            .concat(result.warnings.filter(t=>BROKEN.test(t)))
            .concat(result.alerts.filter(t=>BROKEN.test(t)));

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
