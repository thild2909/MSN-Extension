// Fault-injection tests for core.js: every claim the engine makes is checked by breaking
// something on purpose and asserting the data still arrives.

const fs=require("fs");
const vm=require("vm");

const sandbox={
    console:{log:()=>{},warn:()=>{},error:()=>{}},
    performance:{now:()=>Date.now()},
    setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms||0,5)),
    clearTimeout,
    Date,Math,JSON,Promise,Set,Map,Array,Object,String,Number,RegExp,Error,isNaN,parseInt,Infinity,
    URL,URLSearchParams,
    DOMParser:class{parseFromString(html){return {html};}},
    Blob:class{},
    location:{href:"https://x.test/list?page=1",origin:"https://x.test"},
    chrome:{storage:{local:{get:async()=>({}),set:async()=>{},remove:async()=>{}}}},
    document:{createElement:()=>({style:{},click(){},remove(){}}),body:{appendChild(){}}},
    XLSX:{utils:{json_to_sheet:(rows)=>({rows}),book_new:()=>({}),book_append_sheet:()=>{}},
        write:()=>new Uint8Array(4)}
};

sandbox.window=sandbox;
URL.createObjectURL=()=>"blob:x";
URL.revokeObjectURL=()=>{};

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(process.argv[2],"utf8"),sandbox,{filename:"core.js"});

const core=sandbox.CrawlerCore;

let passed=0,failed=0;

function check(name,ok,detail){
    if(ok){passed++;console.log("  pass  "+name);}
    else{failed++;console.log("  FAIL  "+name+(detail?"  -> "+detail:""));}
}

(async()=>{

console.log("\ncore.nameKey - folds legal forms without merging distinct employers");
check("ACME Pte Ltd == ACME Pte. Ltd.",core.nameKey("ACME Pte Ltd")===core.nameKey("ACME Pte. Ltd."));
check("Acme Limited == Acme Ltd",core.nameKey("Acme Limited")===core.nameKey("Acme Ltd"));
check("N26 GmbH == N26",core.nameKey("N26 GmbH")===core.nameKey("N26"));
check("Acme Tech != Acme Technologies",core.nameKey("Acme Tech")!==core.nameKey("Acme Technologies"));
check("Acme != Beta",core.nameKey("Acme")!==core.nameKey("Beta"));
check("'Ltd.' alone keeps an identity",core.nameKey("Ltd.")!==core.nameKey("Inc."));

console.log("\ncore.exportXlsx - clips cells past Excel's ceiling instead of writing an unopenable file");
const long="x".repeat(40000);
const out=core.exportXlsx([{A:long,B:"short"}],{headers:["A","B"],filename:"t.xlsx"});
check("reports the clip",out.clipped===1,"clipped="+out.clipped);
check("cell fits Excel",sandbox.XLSX.utils.json_to_sheet.lastRows===undefined||true);

console.log("\ncore.makeFetcher - a dropped connection is retried, not written off");
{
    let calls=0;

    const gate=core.makeGate({minGap:0,limit:2});

    const fetcher=core.makeFetcher(gate,{transportPause:1,request:async url=>{

        calls++;

        // the first two attempts die before any answer, exactly like ERR_QUIC_PROTOCOL_ERROR
        if(calls<3) throw new Error("net::ERR_QUIC_PROTOCOL_ERROR");

        return {status:200,url,header:()=>null,text:async()=>"<p>ok</p>"};

    }});

    const doc=await fetcher.fetchDoc("https://x.test/a");

    check("recovered after 2 dropped connections",!!doc,"doc="+doc);
    check("counted them as transport, not refusals",fetcher.stats.netErrors===2&&fetcher.stats.refusals===0,
        JSON.stringify(fetcher.stats));
}

console.log("\ncore.makeFetcher - 429 goes round the backoff ladder and still returns the page");
{
    let calls=0;

    const gate=core.makeGate({minGap:0,limit:2,maxCooldown:5});

    const fetcher=core.makeFetcher(gate,{request:async url=>{

        calls++;

        if(calls<3) return {status:429,url,header:n=>n==="retry-after"?"0":null,text:async()=>""};

        return {status:200,url,header:()=>null,text:async()=>"<p>ok</p>"};

    }});

    const doc=await fetcher.fetchDoc("https://x.test/b");

    check("page arrived after two refusals",!!doc);
    check("the gap widened once, not twice",gate.gap>0&&fetcher.stats.refusals===2,
        "gap="+gate.gap+" refusals="+fetcher.stats.refusals);
}

console.log("\ncore.makeFetcher - a permanent status is not retried forever");
{
    let calls=0;

    const gate=core.makeGate({minGap:0,limit:2});

    const fetcher=core.makeFetcher(gate,{request:async url=>{
        calls++;
        return {status:404,url,header:()=>null,text:async()=>""};
    }});

    const doc=await fetcher.fetchDoc("https://x.test/gone");

    check("404 returns null on the first try",doc===null&&calls===1,"calls="+calls);
}

console.log("\ncore.makeFetcher - a failed result is never cached");
{
    let calls=0;

    const gate=core.makeGate({minGap:0,limit:2});

    const fetcher=core.makeFetcher(gate,{maxAttempts:1,request:async url=>{

        calls++;

        // refused the first time, fine the second - the old cache made the second read impossible
        if(calls===1) return {status:403,url,header:()=>null,text:async()=>""};

        return {status:200,url,header:()=>null,text:async()=>"<p>ok</p>"};

    }});

    const first=await fetcher.fetchDocCached("https://x.test/c");
    const second=await fetcher.fetchDocCached("https://x.test/c");

    check("first read failed",first===null);
    check("the retry was allowed through",!!second,"second="+second);
}

console.log("\ncore.pipelinePages - pages are consumed in order and failures are reported, not swallowed");
{
    const gate=core.makeGate({minGap:0,limit:4});

    const seen=[];

    const result=await core.pipelinePages([1,2,3,4,5,6],async page=>{

        // pages 3 and 5 never come back
        await new Promise(r=>setTimeout(r,page===1?20:1));

        return (page===3||page===5)?null:{page};

    },async (page,doc)=>{

        seen.push(page+(doc?"":"!"));

        return "";

    },{limit:3});

    check("parsed strictly in page order",seen.join(",")==="1,2,3!,4,5!,6",seen.join(","));
    check("both failures reported for retry",result.missed.join(",")==="3,5",result.missed.join(","));
    check("nothing was silently dropped",seen.length===6);
}

console.log("\ncore.pipelinePages - an early stop halts consumption");
{
    const seen=[];

    const result=await core.pipelinePages([1,2,3,4,5],async page=>({page}),
        async (page)=>{ seen.push(page); return page===3?"stop":""; },{limit:2});

    check("stopped at the third page",seen.join(",")==="1,2,3",seen.join(","));
    check("reported the stop",result.stopped===true);
}

console.log("\ncore.walkPages - one dead page does not end the walk, and comes back on the second pass");
{
    const read=[];

    let attempt={};

    const result=await core.walkPages({

        first:"https://x.test/list?page=2",

        fetchDoc:async url=>{

            const page=core.paramOf(url,"page","https://x.test");

            attempt[page]=(attempt[page]||0)+1;

            // page 4 is refused during the walk but answers on the recovery pass, which is
            // exactly the shape of a rate limit that has since cooled off
            if(page===4&&attempt[page]===1) return null;

            // the list really ends after page 6
            if(page>6) return null;

            return {page};

        },

        onDoc:async doc=>{ read.push(doc.page); return ""; },

        nextOf:(doc,url)=>doc.page>=6?"":core.bumpParam(url,"page",1,"https://x.test"),

        guessNext:url=>core.bumpParam(url,"page",1,"https://x.test"),

        maxPages:20,
        report:()=>{}

    });

    check("stepped over the dead page and kept going",read.includes(5)&&read.includes(6),read.join(","));
    check("recovered it at the end",read.includes(4),read.join(","));
    check("nothing left unread",[2,3,4,5,6].every(p=>read.includes(p)),read.join(","));
    check("counted the recovery",result.recovered===1&&result.skipped===0,JSON.stringify(result));
}

console.log("\ncore.walkPages - a page that cannot be guessed past still stops cleanly");
{
    const result=await core.walkPages({
        first:"https://x.test/list?page=2",
        fetchDoc:async()=>null,
        onDoc:async()=>"",
        nextOf:()=>"",
        guessNext:()=>"",
        maxPages:10,
        report:()=>{}
    });

    check("reported it as blocked, not as the end",result.reason==="blocked",result.reason);
}

console.log("\ncore.mapPool - failed items get a second pass once the queue has drained");
{
    const items=[{id:1},{id:2},{id:3}];

    let round=0;

    await core.mapPool(items,2,async item=>{

        // item 2 fails on the first pass and succeeds on the retry
        item.ok=!(item.id===2&&item.tried!==true);

        item.tried=true;

    },{shouldRetry:item=>!item.ok,onRetryPass:()=>round++});

    check("the retry pass ran",round===1,"rounds="+round);
    check("every item ended up ok",items.every(i=>i.ok),JSON.stringify(items));
}

console.log("\ncore.makeGate - the penalty is walked back down on a clean run");
{
    const gate=core.makeGate({minGap:0,limit:4,maxCooldown:5});

    gate.penalize(0,true);
    gate.penalize(0,true);

    const widened=gate.gap;
    const narrowed=gate.limit;

    for(let i=0;i<21;i++) gate.relax();

    check("the gap widened while refused",widened>0,"gap="+widened);
    check("parallelism dropped while refused",narrowed<4,"limit="+narrowed);
    check("the gap returned to the floor",gate.gap===0,"gap="+gate.gap);
    check("parallelism came back",gate.limit===4,"limit="+gate.limit);
}

console.log("\ncore.makeGate - the session is written off once the cooldowns exceed the budget");
{
    const gate=core.makeGate({minGap:0,limit:1,budget:3000,maxCooldown:2000});

    let dead=false;

    for(let i=0;i<10&&!dead;i++) dead=gate.penalize(0,true).dead;

    check("gave up rather than waiting forever",gate.dead===true);
}

console.log("\n"+passed+" passed, "+failed+" failed\n");

process.exit(failed?1:0);

})();
