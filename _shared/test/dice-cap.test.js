// Drives dice-crawler/content.js against REAL Dice markup, parsed for real (see minidom.js).
//
// Dice styles the whole page with Tailwind utilities - the paragraph holding a job's location and
// its posting date is `class="mb-0 text-sm font-normal text-zinc-600"` and nothing else - so the
// crawler cannot read a single class name. Everything comes off data-testid, role and aria-*, and
// the markup below is Dice's own with only the class attributes, the SVG icons and the logo images
// trimmed out. What this proves:
//
//   * a card yields all six columns - company, location, position, posted date, work model
//   * BOTH list layouts are read. The "Group by company" toggle is client-side state that never
//     reaches the server, so the live tab can be showing the grouped layout (one listitem per
//     company, N grouped-job-entry divs inside it, company name only in the header) while every
//     fetched page is the ungrouped one. Reading only the layout in front of you loses the other.
//   * the detail pane's "Similar Jobs" strip stays OUT of the file. It carries role="list" AND
//     aria-label="Job search results" - the same two attributes as the real list - and its cards
//     are job-cards too, so anything not scoped to the results list pulls jobs from a different
//     search into every page of the export.
//   * Dice's location vocabulary is turned into the Remote/Onsite column without a single extra
//     request: "Hybrid in Austin, Texas", "Remote", "Remote or Jacksonville, Florida", a plain
//     city, and "No location provided" - which must produce nothing rather than a guess.
//   * THE CEILING. Dice serves 25 result pages per search and no more, whatever the result count
//     says. ?page=26 upwards come back 200, with a full list of 30 jobs, and the pager still reads
//     "Page 25" - they are page 25's jobs again. A walk that trusts the advertised total ("11,850
//     results" -> 395 pages) keeps asking, keeps being served, keeps adding nothing, and writes a
//     file that reads like a complete run when it holds 750 of 11,850 jobs. The walk has to notice
//     the repeat, stop, and say so.
//
// Run: node _shared/test/dice-cap.test.js ./dice-crawler

const fs=require("fs");
const path=require("path");
const vm=require("vm");

const {makeDocument}=require("./minidom.js");

const DIR=process.argv[2]||"./dice-crawler";

const ORIGIN="https://www.dice.com";
const SEARCH=ORIGIN+"/jobs?q=devops";

// how many pages of real, distinct results the fake Dice has before it starts repeating itself
const REAL_PAGES=4;

// what the search claims, so the crawler works out ~34 pages and walks past REAL_PAGES
const TOTAL=1000;

const asked=[];

//---------------------------------------------------
// the fixture: Dice's own markup, class attributes and SVG/logo images trimmed
//---------------------------------------------------

// every location shape Dice writes, checked against six real result pages
const PLACES=[
    {where:"Hybrid in Austin, Texas",location:"Austin, Texas",mode:"Hybrid"},
    {where:"Remote",location:"Remote",mode:"Remote"},
    {where:"Remote or Jacksonville, Florida",location:"Jacksonville, Florida",mode:"Remote"},
    {where:"Chicago, Illinois",location:"Chicago, Illinois",mode:"Onsite"},
    {where:"No location provided",location:"",mode:""}
];

function job(page,index){

    const n=page+"-"+index;
    const place=PLACES[index%PLACES.length];

    // two employers per page: the first posts three ads and is written a different way on each of
    // them, so the grouping is exercised rather than assumed
    const first=index<3;

    return {
        id:"id"+n,
        guid:"guid-"+n,
        title:"DevOps Engineer "+n,
        company:first?["Company "+page,"Company "+page+" LLC","company  "+page][index]
            :"Other "+page+" Inc",
        profile:(first?"aaaaaaaa-bbbb-cccc-dddd-":"eeeeeeee-ffff-0000-1111-")+page,
        where:place.where,
        // the first employer's newest ad is "Today", the second's is "3d ago"
        posted:index===0?"Today":index+"d ago"
    };

}

// one job in the UNGROUPED layout: <div role="listitem"> holding a single job-card
function ungrouped(j){

    const profile="/company-profile/"+j.profile+"?companyname="+encodeURIComponent(j.company);

    return `<div role="listitem"><div><div><div data-id="${j.id}" data-job-guid="${j.guid}" `
        +`data-testid="job-card" role="article"><div><a tabindex="-1" `
        +`aria-label="View Details for ${j.title} (${j.id})" data-testid="job-search-job-card-link" `
        +`href="/job-detail/${j.guid}"> </a><div><a data-rac="" aria-label="Company Logo" `
        +`href="${profile}" target="_blank" rel="noopener noreferrer" tabindex="0"><div><div>`
        +`</div></div></a><div><div><a data-testid="job-search-job-detail-link" data-rac="" `
        +`aria-label="${j.title}" href="/job-detail/${j.guid}" tabindex="0">${j.title}</a></div>`
        +`<a data-rac="" href="${profile}" target="_blank" tabindex="0">`
        +`<p data-testid="job-card-company-name">${j.company}</p></a>`
        +`<p>${j.where} • ${j.posted}</p>`
        +`<div><div aria-labelledby="employmentType-label"><p id="employmentType-label">Full-time`
        +`</p></div><div aria-labelledby="salary-label"><p id="salary-label">$175000</p></div>`
        +`</div></div></div></div></div></div></div></div>`;

}

// the GROUPED layout: one listitem per company, its name in the header only, N entries below
function grouped(company,profileId,list){

    const profile="/company-profile/"+profileId+"?companyname="+encodeURIComponent(company);

    const entries=list.map(j=>

        `<div><div data-id="${j.id}" data-job-guid="${j.guid}" data-testid="grouped-job-entry" `
        +`role="article"><a tabindex="-1" aria-label="View Details for ${j.title} (${j.id})" `
        +`data-testid="grouped-job-entry-link" href="/job-detail/${j.guid}"> </a><div>`
        +`<a data-testid="grouped-job-entry-title" data-rac="" aria-label="${j.title}" `
        +`href="/job-detail/${j.guid}" tabindex="0">${j.title}</a></div>`
        +`<p>${j.where} • ${j.posted}</p>`
        +`<div><div aria-labelledby="employmentType-label"><p id="employmentType-label">Contract`
        +`</p></div></div></div></div>`

    ).join("");

    return `<div role="listitem"><div><div><div><div></div></div>`
        +`<a data-rac="" href="${profile}" target="_blank" tabindex="0">${company}</a></div>`
        +`<div>${entries}</div></div></div>`;

}

// The fixture is written by hand and one missing </div> nests every listitem inside the first,
// which the crawler then reads as "one company posted everything" - and that quietly satisfies
// most of the checks below rather than failing any of them. It cost an hour once; it costs four
// lines to make it impossible.
function balanced(html){
    return (html.match(/<div\b/g)||[]).length===(html.match(/<\/div>/g)||[]).length;
}

// Dice's ceiling: every page past REAL_PAGES is served the last real page's jobs again
function servedPage(page){
    return page>REAL_PAGES?REAL_PAGES:page;
}

// `layout` is what the LIVE tab happens to be showing; fetched pages are always ungrouped, because
// the Group by company toggle is client-side state and never reaches the server
function pageHtml(page,layout){

    const served=servedPage(page);

    const jobs=[0,1,2,3,4].map(index=>job(served,index));

    const cards=layout==="grouped"
        ? grouped(jobs[0].company,jobs[0].profile,jobs.slice(0,3))
            +grouped(jobs[3].company,jobs[3].profile,jobs.slice(3))
        : jobs.map(ungrouped).join("");

    // the detail pane's own cards: same role, same aria-label, jobs from a different search
    const similar=[0,1,2,3].map(index=>ungrouped(Object.assign(job(900+page,index),{
        id:"similar-"+page+"-"+index,
        guid:"similar-guid-"+page+"-"+index,
        title:"Similar Job "+page+"-"+index,
        company:"Similar Co "+page+"-"+index
    }))).join("");

    return `<html><body><div><p>${TOTAL} results (12 new)</p></div>`
        +`<div data-testid="job-search-split-view-card-list-scroll"><div>`
        +`<div role="list" aria-label="Job search results">${cards}</div></div>`
        +`<nav role="navigation" aria-label="Pagination"><section aria-label="Page ${Math.min(page,16)} of 16">`
        +`<div aria-current="true">${page}</div><span>of</span><span>16</span></section></nav></div>`
        +`<aside><div><div role="list" aria-label="Job search results">${similar}</div></div></aside>`
        +`</body></html>`;

}

//---------------------------------------------------
// the sandbox
//---------------------------------------------------

const alerts=[];
const errors=[];
const warnings=[];

let rows=null;

// the tab is showing the grouped layout, which is what the user's own screenshot of Dice looks
// like once "Group by company" has ever been switched on
const live=makeDocument(pageHtml(1,"grouped"),"Dice");

live.location={href:SEARCH};

const sandbox={
    console:{
        log:()=>{},
        warn:(...a)=>warnings.push(a.join(" ")),
        error:(...a)=>errors.push(a.map(x=>x&&x.stack||x).join(" "))
    },
    alert:msg=>alerts.push(String(msg)),
    performance:{now:()=>Date.now()},
    setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms||0,3)),
    clearTimeout:id=>clearTimeout(id),
    setInterval:(fn,ms)=>setInterval(fn,Math.min(ms||0,3)),
    clearInterval:id=>clearInterval(id),
    MutationObserver:class{observe(){}disconnect(){}takeRecords(){return [];}},
    Date,Math,JSON,Promise,Set,Map,Array,Object,String,Number,RegExp,Error,isNaN,parseInt,parseFloat,Infinity,
    URL,URLSearchParams,
    Blob:class{constructor(){}},

    DOMParser:class{
        parseFromString(html){
            return makeDocument(html,"Dice");
        }
    },

    document:live,
    location:{href:SEARCH,origin:ORIGIN,hostname:"www.dice.com",search:"?q=devops",pathname:"/jobs"},

    fetch:async url=>{

        const page=+new URL(url).searchParams.get("page")||1;

        asked.push(page);

        return {
            status:200,
            ok:true,
            url,
            headers:{get:()=>null},
            text:async()=>pageHtml(page,"ungrouped")
        };

    },

    chrome:{
        storage:{
            local:{get:async()=>({}),set:async()=>{},remove:async()=>{}},
            session:{get:async()=>({}),set:async()=>{}}
        },
        runtime:{
            sendMessage:async()=>({ok:false,error:"no worker in this harness"}),
            onMessage:{addListener(){}}
        }
    },

    XLSX:{
        utils:{
            json_to_sheet:written=>{rows=written;return {};},
            book_new:()=>({}),
            book_append_sheet:()=>{}
        },
        write:()=>new Uint8Array(4)
    }
};

sandbox.addEventListener=()=>{};
sandbox.removeEventListener=()=>{};
sandbox.window=sandbox;
sandbox.self=sandbox;
sandbox.globalThis=sandbox;

URL.createObjectURL=()=>"blob:stub";
URL.revokeObjectURL=()=>{};

const context=vm.createContext(sandbox);

for(const file of ["core.js","content.js"]){
    vm.runInContext(fs.readFileSync(path.join(DIR,file),"utf8"),context,{filename:file});
}

//---------------------------------------------------
// what has to be true when it stops
//---------------------------------------------------

let passed=0;
let failed=0;

function check(name,condition,detail){

    if(condition){
        passed++;
        console.log("  pass  "+name);
        return;
    }

    failed++;

    console.log("  FAIL  "+name+(detail?"\n        "+detail:""));

}

(async()=>{

    const until=Date.now()+20000;

    while(Date.now()<until&&!alerts.length) await new Promise(r=>setTimeout(r,50));

    await new Promise(r=>setTimeout(r,150));

    const summary=alerts[0]||"";

    check("the fixture markup is balanced",
        balanced(pageHtml(1,"ungrouped"))&&balanced(pageHtml(1,"grouped")));

    check("the crawler reached its summary",alerts.length>0);
    check("a file was written",!!rows);

    rows=rows||[];

    const positions=rows.reduce((n,row)=>n+(row.Positions?row.Positions.split(" | ").length:0),0);

    // 5 jobs per page over REAL_PAGES distinct pages, and not one more: every page after that is
    // the same 5 again, and the aside's 4 belong to a different search
    check("every job on every real page reached the file, and nothing else did",
        positions===REAL_PAGES*5,
        `${positions} position(s) in the file, expected ${REAL_PAGES*5} - more means the`
        +" Similar Jobs strip leaked in, fewer means a layout was not read or the walk stopped early");

    check("no job from the detail pane's Similar Jobs strip reached the file",
        !rows.some(row=>/Similar/.test(row["Company Name"]+row.Positions)));

    // page 1 is the grouped layout and pages 2+ the ungrouped one; both have to be read
    const titles=rows.map(row=>row.Positions).join(" | ");

    check("the grouped layout on the live tab was read",/DevOps Engineer 1-0/.test(titles));
    check("the ungrouped layout on the fetched pages was read",/DevOps Engineer 2-0/.test(titles));

    // "Company 1", "Company 1 LLC" and "company  1" are one employer written three ways, and used
    // to become three rows each holding a slice of the positions
    check("three spellings of one company are one row",
        rows.length===REAL_PAGES*2,
        `${rows.length} row(s), expected ${REAL_PAGES*2} (2 employers x ${REAL_PAGES} pages)`);

    check("the company that posted three ads carries all three in one cell",
        rows.some(row=>row.Positions.split(" | ").length===3),
        rows.map(row=>row.Positions.split(" | ").length).join(", "));

    const modes=rows.map(row=>row["Remote/Onsite"]).join(", ");

    check("Hybrid is read out of the location field",/Hybrid/.test(modes));
    check("Remote is read out of the location field",/Remote/.test(modes));
    check("a plain city is Onsite",/Onsite/.test(modes));

    // "No location provided" must produce neither a location nor a guessed work model
    check("a job with no location declared gets no invented place or work model",
        !/No location provided/.test(rows.map(row=>row.Location+row["Remote/Onsite"]).join(" ")));

    // "Hybrid in Austin, Texas" is a work model plus a place, and the place belongs in the column
    check("the city inside \"Hybrid in <city>\" is kept as the location",
        rows.some(row=>/Austin, Texas/.test(row.Location))
        &&!rows.some(row=>/Hybrid in/.test(row.Location)));

    // the first employer's ads are Today / 1d / 2d, the second's are 3d / 4d - so a column full of
    // "Today" would mean the newest was picked by luck, and "2d ago" that it was not picked at all
    check("the newest of a company's listings is the one the Recruitment time column reports",
        rows.filter(row=>row["Recruitment time"]==="Today").length===REAL_PAGES
        &&rows.filter(row=>row["Recruitment time"]==="3d ago").length===REAL_PAGES,
        rows.map(row=>row["Recruitment time"]).join(" / "));

    // Dice publishes no headcount anywhere reachable; an invented one would be far worse than none
    check("Employees is blank rather than guessed",rows.every(row=>!row.Employees));

    // Walking into the ceiling has to be reported, or the file reads as a complete run
    check("the summary says the search was cut short by Dice's page ceiling",
        /as deep as it goes|as deep as Dice serves/.test(summary));

    check("the summary says what to do about it",/Narrow the search/.test(summary));

    check("the summary states how many of the advertised jobs were never read",
        /NOT READ/.test(summary));

    // one wasted request past the last real page is the price of noticing; a dozen is a bug
    const past=asked.filter(page=>page>REAL_PAGES).length;

    check("the walk stops at the repeat instead of paying for every page to the cap",
        past<=2,`asked for ${past} page(s) past the end of the real results: ${asked.join(", ")}`);

    const broken=errors.concat(warnings).concat(alerts)
        .filter(t=>/ReferenceError|TypeError|is not defined|is not a function|before initialization/.test(t));

    check("nothing threw",broken.length===0,broken.slice(0,3).map(t=>t.split("\n")[0]).join("\n        "));

    console.log(`\n${passed} passed, ${failed} failed`);

    process.exit(failed?1:0);

})();
