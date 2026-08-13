// Drives foundit-crawler/content.js against REAL foundit markup and a REAL foundit search payload,
// parsed for real (see minidom.js). The fixture is in foundit-fixture.js: whole job cards exactly
// as foundit wrote them, the panels foundit slips between them, the pager, and the search payload
// re-shipped as genuine self.__next_f.push([1,"..."]) chunks cut at arbitrary points. Only the SVG
// icons and the payload fields nothing reads (descriptions, skill-synonym lists) were dropped.
//
// foundit is the odd one out in this folder, and every one of these checks exists because of it:
//
//   * ITS SEARCH PAGE COMES IN TWO SHAPES. /search/data-engineer-jobs is server-rendered with 20
//     cards in the HTML; /search/data-engineer-jobs?query=data+engineer is a shimmer skeleton whose
//     list the browser fetches afterwards. The second is the URL a person ends up on and copies,
//     and it is empty to a fetch - so the tab is read as it stands and every page after it is
//     fetched from the first shape.
//
//   * THE SHEET'S TWO BEST COLUMNS ARE NOT IN THE MARKUP. A server-rendered card carries no company
//     id (the career link is filled in by the browser) and no posting date at all. Both are in the
//     RSC payload at the bottom of the document, split across ~340 push() calls with job records
//     straddling the cuts. Reading the cards alone silently costs the Recruitment time column and
//     splits employers across rows; so the payload is the primary reader here and the cards are the
//     fallback - and BOTH have to work, because a page rescued through a tab comes back as markup
//     with no payload behind it.
//
//   * A PAGE PAST THE END IS A 307, NOT A 404. foundit redirects it to page 1, so the request
//     succeeds and the list looks real. A walk that trusts "465 results -> 24 pages" against a
//     search that has stopped serving keeps being answered and keeps adding nothing.
//
// Run: node _shared/test/foundit-pages.test.js ./foundit-crawler

const fs=require("fs");
const path=require("path");
const vm=require("vm");

const {parseCsv}=require("./csv.js");

const {makeDocument}=require("./minidom.js");

const FIXTURE=require("./foundit-fixture.js");

const DIR=process.argv[2]||"./foundit-crawler";

const ORIGIN="https://www.foundit.my";
const SEARCH="/search/data-engineer-jobs";

// what the fixture's own payload says, and what the count line on the live page says
const TOTAL=465;

// cards per fixture page - the file must end up with exactly this many Positions entries
const CARDS={1:11,2:3,3:5};

// jobs that exist ONLY on the open tab, so they are the proof it was read at all
const LIVE_ONLY=2;

//---------------------------------------------------
// the browser-rendered shape of the page: what the open tab looks like when its URL carries a
// query string. Two real cards out of one, trimmed of their icons.
//
// The second one is deliberately a job that is on NO fetched page: it is the only proof that the
// open tab was read at all, since everything else on screen also arrives with page 1.
//---------------------------------------------------

function liveCard(index,jobUrl,title,career,company,where,experience,posted){

    return `<div data-index="${index}" class="flex w-full flex-col gap-3 md:!gap-6"><div `
        +`data-index="${index}"><div class="jobCardWrapper flex w-full flex-col gap-1"><div `
        +`class="flex flex-col gap-4 rounded-2xl border-opacity-50 p-4 relative w-auto cursor-pointer `
        +`border border-solid border-jobCardBorder bg-surface-primary-normal shadow-job-card `
        +`md:!w-[570px]"><div class="flex h-full gap-2"><div class="ml-5 mt-0.5"><div><div class="">`
        +`</div></div></div><div class="flex h-full w-full flex-col gap-3"><div class="flex `
        +`min-h-max justify-between gap-2"><div class="flex items-center gap-2"><div class="flex `
        +`flex-col gap-1 break-words"><h2 class="jobCardTitle text-darkKnight-700 line-clamp-2 `
        +`text-ellipsis break-all text-base font-bold md:!line-clamp-1" title="${title}">`
        +`<a href="${jobUrl}" aria-label="${title}"><span>${title}</span></a></h2>`
        +`<span class="jobCardCompany line-clamp-1 text-ellipsis text-sm font-normal">`
        +`<a href="${career}" target="_blank" class="text-darkKnight-500 cursor-pointer">`
        +`<span>${company}</span></a></span></div></div></div><div class="border-darkKnight-100 `
        +`relative flex h-full grow flex-col gap-3"><div class="text-darkKnight-700 flex `
        +`items-center gap-2 text-xs"><div class="jobCardExperience flex h-4 items-center gap-1 `
        +`text-sm"><label>${experience}</label></div><div class="jobCardLocation flex h-4 `
        +`items-center gap-1 text-sm"><span>${where}</span></div></div></div></div></div>`
        +`<div class="md:!pl-7 ml-2 flex h-8 w-full items-center justify-between"><div class="flex `
        +`w-fit"><div class="flex items-center gap-[2px]"><label class="text-fontColor-content-`
        +`tertiary text-xxs">${posted}</label></div></div></div></div></div></div>`;

}

// `total` is what the count line claims, which is how the walk works out where the list ends:
// 465 -> 24 pages, and the fixture stops long before that; 45 -> 3 pages, which is exactly the
// three the fixture has, so the LAST page can be made to fail.
const liveList=total=>'<div id="middleSection" class="search-result-wrapper mx-4 flex w-auto flex-col">'
    +'<div class="mb-1 ml-1 flex w-full text-xs font-normal leading-4 text-content-tertiary">'
    +'<div class="flex w-full px-3"><div class="flex w-full capitalize">'
    +'<div class="searchPageResultsCount flex w-full gap-[3px] truncate">Showing '
    +'<span class="font-medium text-[#17142A]">'+total+' results</span> For '
    +"<h1>Data Engineer Jobs</h1></div></div></div></div>"
    +'<div class="mt-1 flex flex-col gap-4">'

    // also on fetched page 1 - it must not be counted twice
    +liveCard(0,ORIGIN+"/job/senior-data-engineer-plaza-premium-group-malaysia-62308220",
        "Senior Data Engineer","/search/plaza-premium-group-675550-jobs-career",
        "Plaza Premium Group","Malaysia, Kuala Lumpur","5-7 yrs","Posted a day ago")

    // on no fetched page: the open tab is the only place this job exists
    +liveCard(1,ORIGIN+"/job/data-engineer-senior-data-engineer-infinite-computer-solutions-pte-ltd-kuala-lumpur-60853272",
        "Data Engineer/Senior Data Engineer","/search/infinite-computer-solutions-pte-ltd-424603-jobs-career",
        "Infinite Computer Solutions Pte Ltd","Kuala Lumpur","4-11 yrs","Posted 12 days ago")

    // the employer page 1 calls "mr diy international", written the other way foundit writes it.
    // Folding the names does NOT bring these together - "mr d i y international" against "mr diy
    // international" - so the only thing that can is the id in the career link, which exists on
    // this shape of the page and on no fetched one.
    +liveCard(2,ORIGIN+"/job/senior-data-engineer-mr-diy-international-malaysia-62111222",
        "Senior Data Engineer","/search/mr-diy-international-1122449-jobs-career",
        "MR D.I.Y. International","Malaysia","5-8 yrs","Posted 2 days ago")

    +"</div></div>";

const LIVE=liveList(TOTAL);

// the same tab, on a search whose 45 results are exactly the three pages the fixture has
const LIVE_SHORT=liveList(45);

//---------------------------------------------------
// the harness
//---------------------------------------------------

function pageOf(url){

    const match=new URL(url,ORIGIN).pathname.match(/-(\d{1,4})$/);

    return match?+match[1]:1;

}

// `serve` decides what each page number answers with, so one harness covers a search that ends
// tidily and one that runs off the end into foundit's redirect
function run(options){

    const state={alerts:[],errors:[],warnings:[],asked:[],rows:null};

    const live=makeDocument(options.live,"foundit");

    const href=ORIGIN+SEARCH+"?query=data%20engineer&queryDerived=true";

    live.location={href};

    const sandbox={
        console:{
            log:()=>{},
            warn:(...a)=>state.warnings.push(a.join(" ")),
            error:(...a)=>state.errors.push(a.map(x=>x&&x.stack||x).join(" "))
        },
        alert:msg=>state.alerts.push(String(msg)),
        performance:{now:()=>Date.now()},
        setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms||0,3)),
        clearTimeout:id=>clearTimeout(id),
        setInterval:(fn,ms)=>setInterval(fn,Math.min(ms||0,3)),
        clearInterval:id=>clearInterval(id),
        MutationObserver:class{observe(){}disconnect(){}takeRecords(){return [];}},
        Date,Math,JSON,Promise,Set,Map,Array,Object,String,Number,RegExp,Error,isNaN,parseInt,parseFloat,Infinity,
        URL,URLSearchParams,
        Blob:class{constructor(parts){state.rows=parseCsv(parts.join(""));}},

        DOMParser:class{
            parseFromString(html){
                return makeDocument(html,"foundit");
            }
        },

        document:live,
        location:{href,origin:ORIGIN,hostname:"www.foundit.my",
            search:"?query=data%20engineer&queryDerived=true",pathname:SEARCH},

        fetch:async url=>{

            const page=pageOf(url);

            state.asked.push(page);

            const status=options.refuse&&options.refuse(page)?503:200;

            return {
                status,
                ok:status===200,
                url,
                headers:{get:()=>null},
                text:async()=>status===200?options.serve(page):"<html><body>Service Unavailable</body></html>"
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

    return state;

}

async function settle(state){

    const until=Date.now()+20000;

    while(Date.now()<until&&!state.alerts.length) await new Promise(r=>setTimeout(r,50));

    await new Promise(r=>setTimeout(r,150));

    state.rows=state.rows||[];
    state.summary=state.alerts[0]||"";

    state.positions=state.rows.reduce((n,row)=>
        n+(row.Positions?row.Positions.split(" | ").length:0),0);

    return state;

}

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

// a page as a tab would hand it back: the rendered list, and none of the scripts behind it
function withoutPayload(html){
    return html.replace(/<script>[\s\S]*?<\/script>/g,"");
}

(async()=>{

    //---------------------------------------------------
    // 1. a search that ends where it should
    //
    // Page 2 is served the way a page rescued through a tab comes back - markup, no payload - so
    // the run covers both readers at once and the summary has to admit which jobs lost their dates.
    //---------------------------------------------------

    console.log("\na search read to the end, pages 2 and 3 rescued through a tab:\n");

    // Pages 2 and 3 come back the way a tab hands a page over: the rendered list and nothing else.
    // That leaves the pager's disabled "Next" as the ONLY thing on the last page that says it is
    // the last page - the payload's missing next cursor is not there to say it as well.
    const tidy=await settle(run({
        live:LIVE,
        serve:page=>page===1?FIXTURE.page1
            :page===2?withoutPayload(FIXTURE.page2)
            :withoutPayload(FIXTURE.page24)
    }));

    check("the crawler reached its summary",tidy.alerts.length>0);
    check("a file was written",tidy.rows.length>0);

    // 11 + 3 + 5 on the fetched pages, plus the one job that only exists on the open tab. More
    // means the panels foundit slips between the cards were read as jobs, or a page was counted
    // twice; fewer means a selector missed or the walk stopped early.
    check("every card on every page is one entry in the file, and nothing else is",
        tidy.positions===CARDS[1]+CARDS[2]+CARDS[3]+LIVE_ONLY,
        `${tidy.positions} position(s), expected ${CARDS[1]+CARDS[2]+CARDS[3]+LIVE_ONLY}`);

    check("the panels between the cards did not become jobs",
        !tidy.rows.some(row=>/register for free|revamp your resume/i.test(row["Company Name"]+row.Positions))
        &&!tidy.rows.some(row=>row.Positions.split(" | ").every(p=>p==="(untitled)")),
        tidy.rows.map(row=>row["Company Name"]).join(" | "));

    // the open tab is the ONLY place this job appears, so its absence means the browser-rendered
    // shape of the page was never read
    check("the open tab was read even though its URL is the browser-rendered one",
        tidy.rows.some(row=>/Infinite Computer Solutions/.test(row["Company Name"])),
        tidy.rows.map(row=>row["Company Name"]).join(" | "));

    // ...and its date and its place came off the card itself, because that shape of the page has
    // no payload behind it to take either from
    check("a job read off a card alone still has its date and its location",
        tidy.rows.some(row=>/Infinite Computer/.test(row["Company Name"])
            &&/12 days ago/.test(row["Recruitment time"])
            &&row.Location==="Kuala Lumpur"),
        JSON.stringify(tidy.rows.filter(row=>/Infinite/.test(row["Company Name"]))));

    // every card in the fixture has a title, so an "(untitled)" entry means the card reader lost
    // one - which does not crash a run, it writes a placeholder into the sheet
    check("no job reached the file without its title",
        !/\(untitled\)/.test(tidy.rows.map(row=>row.Positions).join(" | ")),
        tidy.rows.filter(row=>/untitled/.test(row.Positions)).map(row=>row["Company Name"]).join(" | "));

    // The job on page 1 is also on the open tab. Two entries for it means the dedupe reads the
    // tab and the fetched page as two different ads.
    const plaza=tidy.rows.filter(row=>/Plaza Premium/.test(row["Company Name"]));

    check("a job on the open tab AND on page 1 is one entry, not two",
        plaza.length===1&&plaza[0].Positions.split(" | ").length===1,
        JSON.stringify(plaza));

    // A server-rendered card carries no date at all - only the payload does. An empty column here
    // means the chunk join or the balanced slice stopped working.
    const dated=tidy.rows.filter(row=>row["Recruitment time"]).length;

    check("the posting dates were lifted out of the search payload",
        dated>=8,`${dated} of ${tidy.rows.length} row(s) have a recruitment time`);

    check("the dates are phrased the way foundit phrases them",
        tidy.rows.every(row=>!row["Recruitment time"]||/^Posted /.test(row["Recruitment time"])),
        tidy.rows.map(row=>row["Recruitment time"]).filter(Boolean).slice(0,5).join(" / "));

    // the payload writes locations as [{country},{city,country}] and the card renders them in that
    // order - "Malaysia, Kuala Lumpur", not "Kuala Lumpur" and not "Malaysia, Malaysia"
    check("locations are read the way the card writes them",
        tidy.rows.some(row=>row.Location==="Malaysia, Kuala Lumpur"),
        tidy.rows.map(row=>row.Location).slice(0,6).join(" / "));

    // "CSI Interfusion" (id 952362) and "CSI Interfusion Sdn Bhd" (id 343367) are two different
    // employers on foundit. Folding the names would merge them; the ids are what keeps them apart.
    const csi=tidy.rows.filter(row=>/CSI Interfusion/.test(row["Company Name"]));

    check("two employers whose names fold together stay two rows when their ids differ",
        csi.length===2,csi.map(row=>row["Company Name"]).join(" | "));

    // The other half of the same rule. "MR D.I.Y. International" on the open tab and "mr diy
    // international" on page 1 are one employer, and folding the names does not say so - only the
    // id in the tab's career link does, and no fetched card carries one.
    const diy=tidy.rows.filter(row=>/mr d/i.test(row["Company Name"]));

    check("one employer written two ways is one row when only the open tab carried its id",
        diy.length===1&&diy[0].Positions.split(" | ").length===2,
        diy.map(row=>row["Company Name"]+" ["+row.Positions+"]").join(" | "));

    // the tab-rescued page has no ids behind it, so its employers group by folded name - which is
    // the path that has to keep working when the payload is gone
    check("the page with no payload behind it still contributed its jobs",
        tidy.positions>=CARDS[1]+CARDS[2],
        `${tidy.positions} position(s)`);

    check("the summary says which jobs were read off the cards alone",
        /read off the cards alone/.test(tidy.summary),tidy.summary);

    // foundit publishes neither, anywhere. An invented value would be worse than an empty cell.
    check("Employees is blank rather than guessed",tidy.rows.every(row=>!row.Employees));

    check("the summary says why Employees and Remote/Onsite are empty",
        /foundit publishes neither/.test(tidy.summary),tidy.summary);

    // The result count says 24 pages. The pager and the payload both say page 3 is the last one,
    // and they are right - so the walk must stop there without asking for a fourth.
    check("the last page is recognised without walking to the page the result count implies",
        Math.max(...tidy.asked)<=3,`asked for pages ${tidy.asked.join(", ")}`);

    // Reed's lesson, which foundit could repeat: a complete run must not describe itself as broken
    check("a run that reached the end is not reported as a refusal",
        !/stopped serving results|could not be read at all/.test(tidy.summary),tidy.summary);

    check("the summary states how many of the advertised jobs were never read",
        /NOT READ/.test(tidy.summary),tidy.summary);

    //---------------------------------------------------
    // 2. a search that runs off the end
    //
    // foundit answers a page past the last one with a 307 back to page 1, so the request succeeds
    // and comes back full of jobs. Nothing about the response says "past the end".
    //---------------------------------------------------

    console.log("\na search walked off the end, where foundit redirects to page 1:\n");

    const over=await settle(run({
        live:LIVE,
        serve:page=>page===1?FIXTURE.page1
            :page===2?FIXTURE.page2
            :FIXTURE.page1
    }));

    check("the crawler reached its summary",over.alerts.length>0);

    check("the redirected page did not add page 1's jobs a second time",
        over.positions===CARDS[1]+CARDS[2]+LIVE_ONLY,
        `${over.positions} position(s), expected ${CARDS[1]+CARDS[2]+LIVE_ONLY}`);

    check("the walk stops at the repeat instead of paying for every page to the count",
        Math.max(...over.asked)<=4,`asked for pages ${over.asked.join(", ")}`);

    check("the summary says the search was cut short by foundit re-sending a page",
        /already served/.test(over.summary),over.summary);

    //---------------------------------------------------
    // 3. a page in the middle that never comes back
    //
    // The whole point of the walk's guessNext: one refused page at page 2 of 3 must not take
    // everything behind it with it. And the file must not describe itself as complete afterwards -
    // a truncated run that reads like a finished one is the most expensive kind of failure here.
    //---------------------------------------------------

    console.log("\na search with a page that never comes back:\n");

    const gap=await settle(run({
        live:LIVE_SHORT,
        refuse:page=>page===2,
        serve:page=>page===1?FIXTURE.page1:FIXTURE.page24
    }));

    check("the crawler reached its summary",gap.alerts.length>0);

    check("the page behind the refused one was still read",
        gap.positions>=CARDS[1]+CARDS[3]+LIVE_ONLY,
        `${gap.positions} position(s) from ${gap.rows.length} row(s)`);

    check("the refused page is reported rather than passed off as the end of the list",
        /could not be read at all|stopped serving results/.test(gap.summary),gap.summary);

    //---------------------------------------------------
    // 4. the LAST page is the one that never comes back
    //
    // The sharpest form of it, and the one a walk gets wrong quietly: the page that failed is the
    // one the walk was going to finish on, so there is nothing after it to notice anything is
    // missing. Reporting it as the end of the list would hand back a truncated file that reads
    // exactly like a complete one.
    //---------------------------------------------------

    console.log("\na search whose LAST page never comes back:\n");

    const tail=await settle(run({
        live:LIVE_SHORT,
        refuse:page=>page===3,
        serve:page=>page===1?FIXTURE.page1:FIXTURE.page2
    }));

    check("the crawler reached its summary",tail.alerts.length>0);

    check("a run that lost its last page does not report itself as finished",
        /stopped serving results|could not be read at all/.test(tail.summary),tail.summary);

    check("everything read before the last page is still in the file",
        tail.positions===CARDS[1]+CARDS[2]+LIVE_ONLY,
        `${tail.positions} position(s), expected ${CARDS[1]+CARDS[2]+LIVE_ONLY}`);

    //---------------------------------------------------

    const broken=[].concat(tidy.errors,tidy.warnings,tidy.alerts,over.errors,over.warnings,over.alerts,
        gap.errors,gap.warnings,gap.alerts,tail.errors,tail.warnings,tail.alerts)
        .filter(text=>/ReferenceError|TypeError|is not defined|is not a function|before initialization|Cannot read/.test(text));

    console.log("");

    check("nothing threw",broken.length===0,broken.slice(0,3).map(t=>t.split("\n")[0]).join("\n        "));

    console.log(`\n${passed} passed, ${failed} failed\n`);

    process.exit(failed?1:0);

})();
