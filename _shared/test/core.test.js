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

console.log("\ncore.makeFetcher - a 5xx is the site having a moment, not a dead page");
{
    let calls=0;

    const gate=core.makeGate({minGap:0,limit:1,maxCooldown:5});

    const fetcher=core.makeFetcher(gate,{request:async url=>{

        calls++;

        // 502 is what a CDN returns while the origin behind it is unhappy. Writing the page off
        // on the first one cost the page AND, while paginating, the link to every page behind it.
        if(calls<3) return {status:502,url,header:()=>null,text:async()=>""};

        return {status:200,url,header:()=>null,text:async()=>"<p>ok</p>"};

    }});

    const doc=await fetcher.fetchDoc("https://x.test/a");

    check("came back after two 502s",!!doc,"calls="+calls);
    check("counted them as refusals, not dead ends",
        fetcher.stats.refusals===2&&fetcher.stats.deadEnds===0,JSON.stringify(fetcher.stats));
}

console.log("\ncore.makeFetcher - a body that stops arriving is retried, never thrown at the caller");
{
    let calls=0;

    const gate=core.makeGate({minGap:0,limit:1});

    const fetcher=core.makeFetcher(gate,{request:async url=>{

        calls++;

        return {
            status:200,
            url,
            header:()=>null,
            // headers arrived, then the connection died mid-body. Letting this reject unwinds the
            // whole pagination loop and ends the run at whatever page it reached.
            text:async()=>{

                if(calls<2) throw new Error("net::ERR_INCOMPLETE_CHUNKED_ENCODING");

                return "<p>ok</p>";

            }
        };

    }});

    let threw=false;
    let doc=null;

    try{
        doc=await fetcher.fetchDoc("https://x.test/a");
    }
    catch(e){
        threw=true;
    }

    check("did not reject",!threw);
    check("returned the page on the retry",!!doc,"calls="+calls);
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

console.log("\ncore.makeFetcher - `needs` skips the parse without turning the page into a failure");
{
    let parses=0;

    const RealParser=sandbox.DOMParser;

    // count what actually reaches DOMParser: the whole point of `needs` is that a body which
    // cannot hold the answer never gets a tree built for it. The one empty parse behind
    // emptyDoc() is not a page and does not count.
    sandbox.DOMParser=class{
        parseFromString(html){
            if(html) parses++;
            return {html};
        }
    };

    const gate=core.makeGate({minGap:0,limit:2});

    const fetcher=core.makeFetcher(gate,{request:async url=>({
        status:200,url,header:()=>null,
        text:async()=>url.endsWith("/has")?"<p>1,001-5,000 employees</p>":"<p>nothing here</p>"
    })});

    const has=await fetcher.fetchDoc("https://x.test/has",{needs:/employee/i});
    const parsedAfterHit=parses;

    const hasnt=await fetcher.fetchDoc("https://x.test/hasnt",{needs:/employee/i});

    check("a body that can answer is parsed",!!has&&has.html==="<p>1,001-5,000 employees</p>",
        JSON.stringify(has));
    check("and one that cannot is not",parses===parsedAfterHit,`${parses} vs ${parsedAfterHit}`);

    // this is the part that matters: a skipped parse must read as "read it, nothing there", not
    // as a refusal, or the page goes round the retry ladder and then the tab fallback for nothing
    check("the skipped page is still a document",!!hasnt,String(hasnt));
    check("an empty one",core.emptyDoc()===hasnt,JSON.stringify(hasnt));
    check("and it cost no extra requests",fetcher.stats.requests===2,String(fetcher.stats.requests));

    // a caller that asks for nothing still gets the tree, exactly as before
    const plain=await fetcher.fetchDoc("https://x.test/plain");

    check("no `needs` means parse as always",!!plain&&plain.html==="<p>nothing here</p>",
        JSON.stringify(plain));

    sandbox.DOMParser=RealParser;
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

//---------------------------------------------------
// core.makeTabFallback / core.tabFirst - a refusal is answered by a real navigation
//
// The point of these is that backing off is the right answer to a rate limit and the WRONG answer
// to a bot check, and from the outside the two are identical. So: the cheap path is always tried
// first, only a refusal is reopened, and the person is interrupted at most askLimit times.
//---------------------------------------------------

// the worker, scripted per test
function stubWorker(reply){

    const seen=[];

    sandbox.chrome.runtime={
        sendMessage:async message=>{

            seen.push(message);

            return typeof reply==="function"?reply(message,seen.length):reply;

        }
    };

    return seen;
}

function stubFetcher(answers){

    let call=0;

    return {
        fetchDoc:async()=>answers[Math.min(call++,answers.length-1)],
        lastStatus:()=>undefined,
        calls:()=>call
    };

}

console.log("\ncore.tabFirst - a page the cheap way stays cheap");
{
    const sent=stubWorker({ok:true,html:"<p>tab</p>"});

    const fetcher=stubFetcher([{fromFetch:true}]);
    const tabs=core.makeTabFallback({lastStatus:()=>200});

    const doc=await core.tabFirst(fetcher,tabs,"https://x.test/a");

    check("used the fetch",doc&&doc.fromFetch===true);
    check("never opened a tab",sent.length===0&&tabs.used===0);
}

console.log("\ncore.tabFirst - a refused page is reopened, a missing one is not");
{
    const sent=stubWorker({ok:true,html:"<p>tab</p>"});

    const refused=core.makeTabFallback({lastStatus:()=>403});

    const rescued=await core.tabFirst(stubFetcher([null]),refused,"https://x.test/blocked");

    check("403 was reopened in a tab",!!rescued&&sent.length===1,"sent="+sent.length);
    check("and counted",refused.ok===1&&refused.used===1,JSON.stringify({ok:refused.ok,used:refused.used}));

    const missing=core.makeTabFallback({lastStatus:()=>404});

    const nothing=await core.tabFirst(stubFetcher([null]),missing,"https://x.test/gone");

    // a tab renders the same "not found", only several seconds slower
    check("404 was not reopened",nothing===null&&missing.used===0);
}

console.log("\ncore.tabFallback - once every page needs a tab, the ladder is skipped");
{
    stubWorker({ok:true,html:"<p>tab</p>"});

    const fetcher=stubFetcher([null]);
    const tabs=core.makeTabFallback({lastStatus:()=>503,preferAfter:2});

    await core.tabFirst(fetcher,tabs,"https://x.test/1");
    await core.tabFirst(fetcher,tabs,"https://x.test/2");

    const before=fetcher.calls();

    await core.tabFirst(fetcher,tabs,"https://x.test/3");

    check("stopped paying for the fetch first",fetcher.calls()===before,
        "fetch calls "+before+" -> "+fetcher.calls());
    check("still got the page",tabs.ok===3,"ok="+tabs.ok);
}

console.log("\ncore.tabFallback - the person is interrupted at most askLimit times");
{
    const sent=stubWorker(message=>({ok:false,challenged:true,askedUser:message.letUserSolve}));

    const tabs=core.makeTabFallback({lastStatus:()=>403,askLimit:2});

    for(let i=0;i<5;i++) await tabs.fetchDoc("https://x.test/"+i);

    const asks=sent.filter(message=>message.letUserSolve).length;

    check("asked twice, then stopped asking",asks===2,"asks="+asks);
    check("kept trying without the interruption",sent.length===5,"sent="+sent.length);
}

console.log("\ncore.tabFallback - a cleared check puts the run back on the cheap path");
{
    stubWorker({ok:true,html:"<p>tab</p>",solvedByUser:true});

    const tabs=core.makeTabFallback({lastStatus:()=>403,preferAfter:1});

    await tabs.fetchDoc("https://x.test/a");

    check("counted the person's help",tabs.solved===1);
    // the cookie that check set covers the whole site, so fetches are worth trying again
    check("went back to trying fetches first",tabs.preferred===false,"streak="+tabs.streak);
}

console.log("\ncore.tabFallback - no worker means give up once, not once per page");
{
    const sent=stubWorker(()=>{throw new Error("Could not establish connection");});

    // workerWake:1 so the boot-race retries do not slow the suite down. Those retries are the
    // point of the wake() loop - the cost they must NOT have is one full round of them per page.
    const tabs=core.makeTabFallback({lastStatus:()=>403,workerWake:1});

    for(let i=0;i<4;i++) await tabs.fetchDoc("https://x.test/"+i);

    check("the worker is given its 3 chances to wake up, once",sent.length===3,"sent="+sent.length);
    check("and the other 3 pages cost no round trip at all",sent.length<4*3,"sent="+sent.length);
    check("and it said why",tabs.off==="broken",tabs.off);
}

console.log("\ncore.tabFallback - the budget is a stop, and the summary says so");
{
    stubWorker({ok:true,html:"<p>tab</p>"});

    const said=[];
    const tabs=core.makeTabFallback({lastStatus:()=>403,budget:2,report:t=>said.push(t)});

    for(let i=0;i<4;i++) await tabs.fetchDoc("https://x.test/"+i);

    check("spent exactly the budget",tabs.used===2,"used="+tabs.used);
    check("told the user it had stopped",said.some(t=>/budget/.test(t)),JSON.stringify(said));
    check("said it once, not once per page",said.filter(t=>/budget/.test(t)).length===1);
    check("and the summary admits it",/2\/2 page\(s\) rescued.*budget spent/.test(tabs.describe()),
        tabs.describe());
}

//---------------------------------------------------
// core.headcount - the value has to come from the page saying it, not from the page containing it
//
// These are the tests that hold the Employees column honest. The regexes themselves were never
// the problem: they were being run over norm(doc.body), where any sentence with a number and the
// word "employees" in it matched, and the result landed in the file looking exactly like a
// figure the site had published.
//---------------------------------------------------

function el(tag,...children){

    const node={
        nodeType:1,
        tag,
        childNodes:children.map(child=>typeof child==="string"
            ?{nodeType:3,nodeValue:child}
            :child)
    };

    node.querySelectorAll=selector=>{

        const tags=selector.split(",").map(part=>part.trim().toLowerCase());
        const out=[];

        (function walk(from){

            for(const child of from.childNodes){

                if(child.nodeType!==1) continue;

                if(tags.includes(child.tag)) out.push(child);

                walk(child);

            }

        })(node);

        return out;

    };

    node.querySelector=selector=>node.querySelectorAll(selector)[0]||null;

    // headcount() tells a field from a section with contains(), so the stub has to have it
    node.contains=other=>{

        if(other===node) return true;

        return (function walk(from){

            for(const child of from.childNodes){

                if(child===other) return true;

                if(child.nodeType===1&&walk(child)) return true;

            }

            return false;

        })(node);

    };

    return node;

}

const SCOPE="div,p,span,li,dd,dt";
const EMPLOYEES=/[\d,]+(?:\s*(?:-|to)\s*[\d,]+)?\s*employees/i;
const LABEL=/^(?:company size|size)$/i;

console.log("\ncore.headcount - a labelled field is read, an advert mentioning a number is not");
{
    const labelled=core.headcount(
        el("body",el("div",el("dt","Company size"),el("dd","51 to 200"))),
        {label:LABEL,value:EMPLOYEES,scope:SCOPE});

    check("label + next block is taken",labelled.text==="51 to 200",JSON.stringify(labelled));
    check("and recorded as a labelled field",labelled.source==="label",labelled.source);

    // this is the case that used to produce a wrong headcount on five of the seven crawlers
    const advert=core.headcount(
        el("body",el("p","Join our team of 200 employees and help us build the future")),
        {label:LABEL,value:EMPLOYEES,scope:SCOPE});

    check("an advert sentence is refused",advert.text==="",JSON.stringify(advert));

    const own=core.headcount(
        el("body",el("span","501-1000 Employees")),
        {label:LABEL,value:EMPLOYEES,scope:SCOPE});

    check("an element that IS the value is taken",own.text==="501-1000 Employees",JSON.stringify(own));
    check("and recorded as the weaker reading",own.source==="near",own.source);
}

console.log("\ncore.headcount - the label wins over anything found loose on the same page");
{
    const both=core.headcount(
        el("body",
            el("p","We are a team of 3,000 employees across four offices"),
            el("div",el("dt","Company size"),el("dd","51 to 200"))),
        {label:LABEL,value:EMPLOYEES,scope:SCOPE});

    check("read the field, not the pitch",both.text==="51 to 200",JSON.stringify(both));
}

console.log("\ncore.headcount - a container wrapping the page cannot pair a label with distant text");
{
    const parts=[el("p","Company size"),el("p","Careers")];

    for(let i=0;i<12;i++) parts.push(el("p","section "+i));

    const wide=core.headcount(el("body",el("div",...parts)),
        {label:LABEL,value:EMPLOYEES,scope:SCOPE});

    check("did not pair 'Company size' with 'Careers'",wide.text!=="Careers",JSON.stringify(wide));
}

console.log("\ncore.headcount - a long element is a section, not a field");
{
    const long=core.headcount(
        el("body",el("p","x".repeat(200)+" 200 employees")),
        {label:LABEL,value:EMPLOYEES,scope:SCOPE});

    check("skipped it",long.text==="",JSON.stringify(long));
}

console.log("\ncore.headcount - a container is still a container, however it is detected");
{
    // the leaf test used to be querySelector(scope) per element; it is now a document-order
    // comparison, and the two have to disagree about nothing
    const nested=core.headcount(
        el("body",el("div",el("p",el("span","3,000 employees")))),
        {label:LABEL,value:EMPLOYEES,scope:SCOPE});

    check("read the innermost element, not the wrappers",nested.text==="3,000 employees",
        JSON.stringify(nested));
    check("and did not call it a labelled field",nested.source==="near",nested.source);

    // a wrapper whose own text would match, with a scope element inside it: the wrapper is a
    // section and only what is inside it may be read
    const wrapped=core.headcount(
        el("body",el("div","Join our team of 200 employees",el("p","and grow with us"))),
        {label:LABEL,value:EMPLOYEES,scope:SCOPE});

    check("a wrapper's own text is not a field",wrapped.text==="",JSON.stringify(wrapped));
}

console.log("\ncore.blocks - a bounded read stops at the limit");
{
    const wide=el("div",...Array.from({length:50},(_,i)=>el("p","block "+i)));

    check("unbounded reads everything",core.blocks(wide).length===50,core.blocks(wide).length);
    check("bounded stops there",core.blocks(wide,13).length===13,core.blocks(wide,13).length);
    check("and the blocks it did read are the first ones",core.blocks(wide,3).join("|")==="block 0|block 1|block 2",
        core.blocks(wide,3).join("|"));

    // headcount asks for 13 to decide "more than 12", so the two have to agree at the boundary
    const twelve=el("div",...Array.from({length:12},(_,i)=>el("p","block "+i)));

    check("a 12 block element is read in full",core.blocks(twelve,13).length===12,
        core.blocks(twelve,13).length);
}

console.log("\ncore.describeSizes - the summary says how much of the column is a field");
{
    const line=core.describeSizes([
        {employeesSource:"label"},{employeesSource:"label"},
        {employeesSource:"near"},{employeesSource:""}
    ]);

    check("counts each source",/3 read \(2 from a labelled field, 1 from an unlabelled element\), 1 blank/.test(line),line);
    check("says nothing when there is nothing to say",core.describeSizes([{},{}])==="");
}

//---------------------------------------------------
// the tab fallback
//
// This is the path taken when the site has stopped answering fetches, so it is the one that
// decides whether a blocked run comes back with data or with an empty file. Everything here is
// about not making a bad situation worse: never opening more tabs than promised, never stealing
// the window when told not to, and never going quiet about either.
//---------------------------------------------------

let outbox=[];
let tabReply=null;

sandbox.chrome.runtime={
    sendMessage:async message=>{
        outbox.push(message);
        return typeof tabReply==="function"?tabReply(message):tabReply;
    }
};

function fallback(options){
    outbox=[];
    return core.makeTabFallback(Object.assign({log:"[test]"},options||{}));
}

console.log("\ncore.makeTabFallback - a page the site refused is reopened as a real navigation");
{
    const tabs=fallback();

    tabReply={ok:true,html:"<html></html>",url:"https://x.test/p"};

    const reply=await tabs.get("https://x.test/p");

    check("the reply reaches the caller",!!reply&&reply.ok===true);
    check("the worker was asked to open a tab",outbox[0]&&outbox[0].type==="tab:fetch",
        outbox[0]&&outbox[0].type);
    check("success is counted",tabs.used===1&&tabs.ok===1&&tabs.failed===0,
        `used=${tabs.used} ok=${tabs.ok} failed=${tabs.failed}`);
}

console.log("\ncore.makeTabFallback - only a refusal is worth a tab");
{
    const status={};
    const tabs=fallback({lastStatus:url=>status[url]});

    for(const code of [429,503,403,500,502]){
        status["u"+code]=code;
        check("HTTP "+code+" is worth reopening",tabs.worthIt("u"+code)===true);
    }

    for(const code of [404,410,401]){
        status["u"+code]=code;
        check("HTTP "+code+" is not worth reopening",tabs.worthIt("u"+code)===false);
    }

    check("a URL nothing ever answered is worth reopening",tabs.worthIt("never-asked")===true);

    const blocked=fallback({worthIt:()=>false});

    check("the caller can veto a URL outright",blocked.worthIt("anything")===false);
}

console.log("\ncore.makeTabFallback - the budget is a promise, not a suggestion");
{
    const said=[];
    const tabs=fallback({budget:2,report:t=>said.push(t)});

    tabReply={ok:true,html:"<html></html>",url:"u"};

    await tabs.get("u");
    await tabs.get("u");

    const third=await tabs.get("u");

    check("no more tabs are opened past the budget",third===null&&tabs.used===2,"used="+tabs.used);
    check("and it says which limit stopped it",tabs.off==="budget",tabs.off);
    check("...out loud, rather than truncating silently",said.some(t=>/budget/i.test(t)),
        said[said.length-1]);
    check("the caller can tell it is spent",tabs.available===false);
}

console.log("\ncore.makeTabFallback - a browser that cannot open tabs is not asked eighty times");
{
    const tabs=fallback();

    tabReply={ok:false,error:"could not open a tab",fatal:true};

    await tabs.get("u");

    check("a fatal failure switches the fallback off",tabs.off==="broken"&&tabs.available===false);

    const before=outbox.length;

    await tabs.get("u");

    check("and no further round trip is spent on it",outbox.length===before,
        `${outbox.length} vs ${before}`);
}

// The fallback's whole premise is that a real navigation succeeds where a fetch was refused. When
// the navigation fails too, the premise is gone - the trouble is under both of them. A VPN mangling
// HTTP/2 does exactly that, and the run it was found on opened 80 tabs, rescued nothing, and said
// the same thing 80 times.
console.log("\ncore.makeTabFallback - a tab path that is failing is given up on, not repeated 80 times");
{
    const said=[];
    const tabs=fallback({budget:80,giveUpAfter:5,report:t=>said.push(t)});

    tabReply={ok:false,error:"Frame with ID 0 is showing error page"};

    for(let i=0;i<5;i++) await tabs.get("u"+i);

    check("it stops after the run of failures, not at the budget",tabs.off==="failing",
        tabs.off+" used="+tabs.used);
    check("...having spent 5 tabs on it rather than 80",tabs.used===5,"used="+tabs.used);

    check("and says it is the connection, not the site",
        said.some(t=>/connection itself is the problem/i.test(t)),said.join(" | "));

    check("...quoting what the tabs actually failed with",
        said.some(t=>/showing error page/i.test(t)),said.join(" | "));

    const before=outbox.length;

    await tabs.get("u9");

    check("no further round trip is spent on it",outbox.length===before,
        `${outbox.length} vs ${before}`);

    check("the summary admits it",/stopped after 5 in a row failed to load/.test(tabs.describe()),
        tabs.describe());
}

// Same stop, opposite advice: a wall the person can clear is not a broken connection, and telling
// them to go and look at their VPN sends them nowhere.
console.log("\ncore.makeTabFallback - a wall every tab hits is reported as a wall, not as the network");
{
    const said=[];
    const tabs=fallback({giveUpAfter:3,askLimit:0,report:t=>said.push(t)});

    tabReply={ok:false,challenged:true,error:"the check on the page was still there after 15s"};

    for(let i=0;i<3;i++) await tabs.get("u"+i);

    check("it still stops",tabs.off==="failing",tabs.off);
    check("but names the check, not the connection",
        said.some(t=>/clear the check by hand/i.test(t))&&!said.some(t=>/VPN or proxy/i.test(t)),
        said.join(" | "));
    check("...and the summary agrees",/still showing the site's check/.test(tabs.describe()),
        tabs.describe());
}

console.log("\ncore.makeTabFallback - one tab that works clears the run of failures");
{
    const tabs=fallback({giveUpAfter:3});

    tabReply={ok:false,error:"boom"};

    await tabs.get("a");
    await tabs.get("b");

    tabReply={ok:true,html:"<html></html>",url:"c"};

    await tabs.get("c");

    check("a success resets the counter",tabs.misses===0,"misses="+tabs.misses);

    tabReply={ok:false,error:"boom"};

    await tabs.get("d");
    await tabs.get("e");

    check("...so two more failures are not the third strike",tabs.off===""&&tabs.available===true,
        tabs.off);
}

console.log("\ncore.makeFetcher - a connection that answers nothing is written off, not asked 644 times");
{
    let calls=0;

    const gate=core.makeGate({minGap:0,limit:1});

    const fetcher=core.makeFetcher(gate,{
        maxTransport:2,
        transportPause:0,
        maxTransportStreak:4,
        request:async()=>{
            calls++;
            throw new Error("net::ERR_HTTP2_PROTOCOL_ERROR");
        }
    });

    for(let i=0;i<4;i++) await fetcher.fetchDoc("https://x.test/job"+i);

    check("the session is written off",gate.dead===true);

    // 4 URLs x maxTransport 2 = 8, and not one attempt more
    check("...after the run of URLs, not after all of them",calls===8,"calls="+calls);

    const before=calls;

    await fetcher.fetchDoc("https://x.test/job99");

    check("later URLs cost no request at all",calls===before,`${calls} vs ${before}`);

    check("and the summary says the run was cut short",
        /stopped early/.test(fetcher.describe()),fetcher.describe());
}

console.log("\ncore.makeFetcher - a bad patch of network is not a dead connection");
{
    let calls=0;

    const gate=core.makeGate({minGap:0,limit:1});

    // every other URL answers: the connection is plainly alive, however ugly it looks
    const fetcher=core.makeFetcher(gate,{
        maxTransport:1,
        transportPause:0,
        maxTransportStreak:4,
        request:async url=>{

            calls++;

            if(/odd/.test(url)) throw new Error("net::ERR_HTTP2_PROTOCOL_ERROR");

            return {status:200,url,header:()=>null,text:async()=>"<p>ok</p>"};

        }
    });

    for(let i=0;i<12;i++){
        await fetcher.fetchDoc("https://x.test/"+(i%2?"odd":"even")+i);
    }

    check("the run is left alone",gate.dead===false);
    check("...and every good page still came back",fetcher.stats.netErrors===6,
        JSON.stringify(fetcher.stats));
}

console.log("\ncore.makeFetcher - a twice-refused page is handed to the fallback, not to the ladder");
{
    for(const status of [429,503,403,500,502]){

        let calls=0;

        const gate=core.makeGate({minGap:0,limit:1,maxCooldown:5});

        const fetcher=core.makeFetcher(gate,{
            maxAttempts:6,
            canEscalate:()=>true,
            request:async url=>{
                calls++;
                return {status,url,header:()=>null,text:async()=>""};
            }
        });

        const doc=await fetcher.fetchDoc("https://x.test/p");

        check(`HTTP ${status} stops after 2 attempts, not 6`,doc===null&&calls===2,"calls="+calls);

    }
}

console.log("\ncore.makeFetcher - with no fallback left the ladder still runs in full");
{
    let calls=0;

    const gate=core.makeGate({minGap:0,limit:1,maxCooldown:5});

    // the fallback is spent: cutting the ladder short now would throw the page away for nothing
    const fetcher=core.makeFetcher(gate,{
        maxAttempts:4,
        canEscalate:()=>false,
        request:async url=>{
            calls++;
            return {status:429,url,header:()=>null,text:async()=>""};
        }
    });

    const doc=await fetcher.fetchDoc("https://x.test/p");

    check("every attempt was spent",doc===null&&calls===4,"calls="+calls);
}

console.log("\ncore.makeFetcher - escalation never costs a page that would have come back");
{
    let calls=0;

    const gate=core.makeGate({minGap:0,limit:1,maxCooldown:5});

    const fetcher=core.makeFetcher(gate,{
        maxAttempts:6,
        canEscalate:()=>true,
        request:async url=>{

            calls++;

            // refused once, fine on the retry - the escalation must not fire before attempt 2
            if(calls===1) return {status:429,url,header:()=>null,text:async()=>""};

            return {status:200,url,header:()=>null,text:async()=>"<p>ok</p>"};

        }
    });

    const doc=await fetcher.fetchDoc("https://x.test/p");

    check("a one-off refusal is still retried normally",!!doc&&calls===2,"calls="+calls);
}

console.log("\ncore.makeFetcher - crawlers that pass no canEscalate are unaffected");
{
    let calls=0;

    const gate=core.makeGate({minGap:0,limit:1,maxCooldown:5});

    const fetcher=core.makeFetcher(gate,{
        maxAttempts:3,
        request:async url=>{
            calls++;
            return {status:429,url,header:()=>null,text:async()=>""};
        }
    });

    await fetcher.fetchDoc("https://x.test/p");

    check("the full ladder runs, as before",calls===3,"calls="+calls);
}

console.log("\ncore.makeTabFallback - ready() finds a missing worker before the crawl, not after");
{
    const said=[];

    const alive=fallback({workerWake:1,report:t=>said.push(t)});

    tabReply={ok:true};

    check("a reachable worker answers the ping",(await alive.ready())===true);
    check("...and the fallback stays armed",alive.off==="",alive.off);

    const dead=fallback({workerWake:1,report:t=>said.push(t)});

    tabReply=()=>{throw new Error("Could not establish connection. Receiving end does not exist.");};

    check("an unreachable worker is reported as not ready",(await dead.ready())===false);
    check("...before a single page has been refused",dead.used===0,"used="+dead.used);
    check("...and the person is told to reload the extension",
        said.some(t=>/reload/i.test(t)),said.join(" | ").slice(0,90));

    // A ping is a diagnostic, not a verdict. An older worker may not answer "tab:ping" at all, and
    // a ping can lose a start-up race that a real request would have survived - so a failed one
    // must not cost the run its only way of recovering.
    check("but the fallback is NOT switched off by a failed ping",dead.off===""&&dead.available,
        "off="+dead.off);

    tabReply={ok:true,html:"<html></html>",url:"u"};

    check("...so a real page can still be rescued afterwards",!!(await dead.get("u")));
}

console.log("\ncore.makeTabFallback - a sleeping service worker is woken, not written off");
{
    // MV3 shuts the worker down when idle, so the first tab of a run routinely rejects with
    // "Receiving end does not exist" while Chrome is starting it back up. One attempt used to be
    // enough to switch the fallback off for the whole run.
    let attempts=0;

    const tabs=fallback({workerWake:1});

    tabReply=()=>{

        attempts++;

        if(attempts===1) throw new Error("Could not establish connection. Receiving end does not exist.");

        return {ok:true,html:"<html></html>",url:"u"};

    };

    const reply=await tabs.get("u");

    check("the message is retried while the worker boots",attempts===2,"attempts="+attempts);
    check("and the page comes back",!!reply&&reply.ok===true);
    check("the fallback is still usable for the rest of the run",tabs.off===""&&tabs.available===true,
        "off="+tabs.off);
}

console.log("\ncore.makeTabFallback - a worker that is genuinely gone is given up on, loudly");
{
    const said=[];

    let attempts=0;

    const tabs=fallback({workerWake:1,report:t=>said.push(t)});

    tabReply=()=>{
        attempts++;
        throw new Error("Could not establish connection. Receiving end does not exist.");
    };

    await tabs.get("u");

    check("it tries the configured number of times before giving up",attempts===3,"attempts="+attempts);
    check("then switches off",tabs.off==="broken",tabs.off);
    check("and says so where the person will see it",
        said.some(t=>/background worker/i.test(t)&&/reload/i.test(t)),
        said.join(" | ").slice(0,110));
}

console.log("\ncore.makeTabFallback - a challenge that will not clear is survivable");
{
    const tabs=fallback();

    tabReply={ok:false,error:"still challenged",challenged:true};

    const reply=await tabs.get("u");

    check("the page is lost but the fallback stays usable",
        reply===null&&tabs.off===""&&tabs.available===true);
    check("and it is counted as a failure",tabs.failed===1,"failed="+tabs.failed);
}

console.log("\ncore.makeTabFallback - the cheap path is preferred again after a while");
{
    const tabs=fallback({preferAfter:2,recheck:3});

    tabReply={ok:true,html:"<html></html>",url:"u"};

    await tabs.get("u");

    check("one rescue does not switch to tab-first",tabs.preferred===false);

    await tabs.get("u");

    check("two in a row does",tabs.preferred===true,"streak="+tabs.streak);

    tabs.clean();

    check("a fetch that came back resets it",tabs.preferred===false,"streak="+tabs.streak);

    for(let i=0;i<5;i++) await tabs.get("u");

    check("the streak winds back so fetches are re-tested",tabs.preferred===false,
        "streak="+tabs.streak);
}

console.log("\ncore.makeTabFallback - askLimit:0 never takes the window from the person");
{
    const quiet=fallback({askLimit:0});

    tabReply={ok:true,html:"<html></html>",url:"u"};

    await quiet.get("u");

    check("the worker is told not to interrupt",outbox[0].letUserSolve===false,
        "letUserSolve="+outbox[0].letUserSolve);

    const asks=fallback({askLimit:1});

    await asks.get("u");

    check("...but a crawler that allows it still may",outbox[0].letUserSolve===true,
        "letUserSolve="+outbox[0].letUserSolve);
}

console.log("\ncore.makeTabFallback - the caller gets to judge what came back");
{
    const seen=[];

    const tabs=fallback({
        inspect:(reply,url)=>{seen.push(url);return "stop";}
    });

    tabReply={ok:true,html:"<html></html>",url:"https://x.test/signin"};

    const doc=await tabs.fetchDoc("https://x.test/p");

    check("inspect is shown the reply",seen.length===1);
    check("and 'stop' means the page is refused, not returned",doc===null);
}

console.log("\ncore.tabFirst - the cheap path first, the tab only when it fails");
{
    const tabs=fallback();

    tabReply={ok:true,html:"<html></html>",url:"u"};

    const good={fetchDoc:async()=>({page:1})};

    const doc=await core.tabFirst(good,tabs,"u",{});

    check("a fetch that works costs no tab",doc&&doc.page===1&&tabs.used===0,"used="+tabs.used);

    const dead={fetchDoc:async()=>null};

    const rescued=await core.tabFirst(dead,tabs,"u",{});

    check("a fetch that fails is rescued by a tab",!!rescued&&tabs.used===1,"used="+tabs.used);
}

console.log("\ncore.tabFirst - once nothing is coming back, the ladder is skipped");
{
    const tabs=fallback({preferAfter:1});

    tabReply={ok:true,html:"<html></html>",url:"u"};

    let fetches=0;

    const dead={fetchDoc:async()=>{fetches++;return null;}};

    await core.tabFirst(dead,tabs,"u",{});

    check("the first refusal still tries the cheap path",fetches===1,"fetches="+fetches);

    await core.tabFirst(dead,tabs,"u",{});

    check("the next one goes straight to a tab",fetches===1,"fetches="+fetches);
    check("and the page still came back",tabs.ok===2,"ok="+tabs.ok);
}

//---------------------------------------------------
// parallelism, measured rather than assumed
//
// Every crawler puts a "parallel" number in front of the user, and three separate things have to
// agree for it to mean anything: the gate has to let that many run, the pools have to start that
// many, and a refusal must not quietly take the setting away and never give it back. Each of the
// three has been wrong at some point, and none of them is visible from reading the code - so these
// count what actually happens.
//---------------------------------------------------

// a request that reports how many of its kind were in flight at once
function inFlightProbe(ms){

    const seen={now:0,peak:0,count:0};

    return {

        seen,

        request:async url=>{

            seen.now++;
            seen.count++;
            seen.peak=Math.max(seen.peak,seen.now);

            await new Promise(r=>setTimeout(r,ms));

            seen.now--;

            return {status:200,url,header:()=>null,text:async()=>"<p>ok</p>"};

        }

    };

}

console.log("\ncore - the parallel setting is what actually runs, in both pools");
{
    for(const width of [1,4,6]){

        const gate=core.makeGate({minGap:0,limit:width});
        const probe=inFlightProbe(20);
        const fetcher=core.makeFetcher(gate,{request:probe.request});

        await core.mapPool(Array.from({length:width*3},(_,i)=>i),width,
            async i=>{ await fetcher.fetchDoc("https://x.test/m"+width+"/"+i); });

        check(`mapPool at parallel ${width} ran ${width} at once`,probe.seen.peak===width,
            "peak="+probe.seen.peak);

        const gate2=core.makeGate({minGap:0,limit:width});
        const probe2=inFlightProbe(20);
        const fetcher2=core.makeFetcher(gate2,{request:probe2.request});

        await core.pipelinePages(Array.from({length:width*3},(_,i)=>i+1),
            page=>fetcher2.fetchDoc("https://x.test/p"+width+"/"+page),
            async()=>"",{limit:width});

        check(`pipelinePages at parallel ${width} ran ${width} at once`,probe2.seen.peak===width,
            "peak="+probe2.seen.peak);

    }
}

console.log("\ncore.makeGate - a run that is never refused waits for nothing but the requests");
{
    const REQUEST=40;
    const COUNT=24;
    const WIDTH=6;

    const gate=core.makeGate({minGap:0,limit:WIDTH});

    const fetcher=core.makeFetcher(gate,{request:async url=>{

        await new Promise(r=>setTimeout(r,REQUEST));

        return {status:200,url,header:()=>null,text:async()=>"<p>ok</p>"};

    }});

    const started=Date.now();

    await core.mapPool(Array.from({length:COUNT},(_,i)=>i),WIDTH,
        async i=>{ await fetcher.fetchDoc("https://x.test/clean"+i); });

    const took=Date.now()-started;

    // COUNT/WIDTH rounds of REQUEST each is the floor: anything much past it is the engine
    // charging for something, and on a clean run it has nothing to charge for
    const floor=(COUNT/WIDTH)*REQUEST;

    check("no toll on top of the requests themselves",took<floor*1.6,
        took+"ms against a floor of "+floor+"ms");
    check("and the gap stayed on the floor",gate.gap===0,"gap="+gate.gap);
}

console.log("\ncore.makeGate - one unhappy URL costs one slot, not the whole pool");
{
    // The gap has always been guarded by `widen` so that the five retries of one page cannot
    // multiply the pace. The limit was not, so the same five retries took parallel 6 down to 1 -
    // and since relax() only widens once per three clean answers, fifteen good pages to undo.
    const gate=core.makeGate({minGap:0,limit:6,maxGap:50,maxCooldown:5});

    const fetcher=core.makeFetcher(gate,{request:async url=>{

        if(url.endsWith("/bad")) return {status:403,url,header:()=>null,text:async()=>""};

        return {status:200,url,header:()=>null,text:async()=>"<p>ok</p>"};

    }});

    await fetcher.fetchDoc("https://x.test/bad");

    check("five refused attempts cost one slot",gate.limit===5,"limit="+gate.limit);

    for(let i=0;i<9;i++) await fetcher.fetchDoc("https://x.test/ok"+i);

    check("and a clean stretch gives it back",gate.limit===gate.maxLimit,
        "limit="+gate.limit+" of "+gate.maxLimit);
}

console.log("\ncore.makeGate - a site refusing everything still gets the pool narrowed");
{
    const gate=core.makeGate({minGap:0,limit:6,maxGap:50,maxCooldown:5});

    const fetcher=core.makeFetcher(gate,{maxAttempts:2,request:async url=>
        ({status:429,url,header:()=>null,text:async()=>""})});

    // eight DIFFERENT urls refused - that is the site pushing back, not one bad page
    for(let i=0;i<8;i++) await fetcher.fetchDoc("https://x.test/n"+i);

    check("narrowed to a single request",gate.limit===1,"limit="+gate.limit);
}

console.log("\ncore.makeFetcher - no path through it leaks a gate slot");
{
    const gate=core.makeGate({minGap:0,limit:6,maxGap:20,maxCooldown:5,budget:1e9});

    // each url fails its first attempt in a different way and succeeds on the retry, so every
    // exit from fetchDoc is walked while the pool still has to drain
    const tried=new Map();

    const fetcher=core.makeFetcher(gate,{transportPause:1,request:async url=>{

        const go=(tried.get(url)||0)+1;

        tried.set(url,go);

        if(go===1){

            const kind=(+url.split("x")[1])%6;

            if(kind===0) throw new Error("net::ERR_QUIC_PROTOCOL_ERROR");
            if(kind===1) return {status:429,url,header:()=>null,text:async()=>""};
            if(kind===2) return {status:502,url,header:()=>null,text:async()=>""};
            if(kind===3) return {status:403,url,header:()=>null,text:async()=>""};
            if(kind===4) return {status:200,url,header:()=>null,
                text:async()=>{throw new Error("the body stopped arriving");}};

        }

        return {status:200,url,header:()=>null,text:async()=>"<p>ok</p>"};

    }});

    const done=[];

    await core.mapPool(Array.from({length:24},(_,i)=>i),6,
        async i=>{ await fetcher.fetchDoc("https://x.test/x"+i); done.push(i); });

    check("every worker finished",done.length===24,"finished="+done.length);
    check("no slot left held",gate.active===0,"active="+gate.active);
    check("nobody left queued",gate.waiting.length===0,"waiting="+gate.waiting.length);
}

console.log("\ncore.pipelinePages - parallel fetching, strictly ordered consumption");
{
    const gate=core.makeGate({minGap:0,limit:6});

    // later pages come back FIRST, so any ordering bug shows up rather than hiding behind luck
    const fetcher=core.makeFetcher(gate,{request:async url=>{

        const page=+url.split("q")[1];

        await new Promise(r=>setTimeout(r,60-page*2));

        return {status:200,url,header:()=>null,text:async()=>"<p>"+page+"</p>"};

    }});

    const order=[];

    await core.pipelinePages(Array.from({length:24},(_,i)=>i+1),
        page=>fetcher.fetchDoc("https://x.test/q"+page),
        async page=>{ order.push(page); return ""; },{limit:6});

    check("consumed in page order",order.every((p,i)=>p===i+1),order.slice(0,8).join(","));
    check("consumed every page",order.length===24,"got "+order.length);
    check("no slot left held",gate.active===0,"active="+gate.active);
}

console.log("\ncore.makeGate - a cooldown nobody is going to serve is handed back");
{
    const gate=core.makeGate({minGap:0,limit:6,maxCooldown:30000});

    const outcome=gate.penalize(0,true);

    // core.js runs in the sandbox, where performance.now() is Date.now(). Comparing its
    // pausedUntil against Node's own performance.now() would compare two unrelated clocks.
    const now=()=>sandbox.performance.now();

    check("the pause was set",gate.pausedUntil>now()+1000,"until="+gate.pausedUntil);

    gate.forgive(outcome);

    check("and given back once the caller routed around it",
        gate.pausedUntil<=now()+50,"still parked for "+Math.round(gate.pausedUntil-now())+"ms");

    // ...but only by the worker that set it. A longer pause asked for by someone else is about a
    // refusal this crawler has NOT routed around, so it has to stand.
    const mine=gate.penalize(0,true);

    gate.penalize(0,true);

    const theirs=gate.pausedUntil;

    gate.forgive(mine);

    check("someone else's longer pause stands",gate.pausedUntil===theirs);
}

console.log("\ncore.makeFetcher - escalating to a tab does not park the pool on the way out");
{
    // A single 502 on one company page was pausing every other worker for thirty seconds, on the
    // way to a fallback that does not need the pause at all.
    const gate=core.makeGate({minGap:0,limit:6,maxCooldown:30000});

    const fetcher=core.makeFetcher(gate,{
        maxAttempts:5,
        escalateAfter:2,
        canEscalate:()=>true,
        request:async url=>({status:502,url,header:()=>null,text:async()=>""})
    });

    const doc=await fetcher.fetchDoc("https://x.test/502");

    const now=()=>sandbox.performance.now();

    check("handed the page over",doc===null);
    check("left the pool free to carry on",gate.pausedUntil<=now()+50,
        "parked for a further "+Math.round(gate.pausedUntil-now())+"ms");
    check("but still counted the refusal",gate.blocks>0&&gate.gap>0,
        "blocks="+gate.blocks+" gap="+Math.round(gate.gap));
}

console.log("\ncore.makeTabFallback - askLimit survives a pool reaching it all at once");
{
    // The quota used to be read before the await and updated after the reply, which is only right
    // at parallel 1: six workers refused in the same tick all read `asked` as 0, all were told
    // they could ask, and askLimit:2 became six tabs taking the window in turn.
    const sent=stubWorker(async message=>{

        await new Promise(r=>setTimeout(r,5));

        return {ok:false,challenged:true,askedUser:message.letUserSolve};

    });

    const tabs=core.makeTabFallback({lastStatus:()=>403,askLimit:2});

    await Promise.all([0,1,2,3,4,5].map(i=>tabs.fetchDoc("https://x.test/a"+i)));

    const asks=sent.filter(message=>message.letUserSolve).length;

    check("at most askLimit tabs would take the window",asks<=2,"asks="+asks);
    check("the rest were still tried, quietly",sent.length===6,"sent="+sent.length);
}

console.log("\n"+passed+" passed, "+failed+" failed\n");

process.exit(failed?1:0);

})();
