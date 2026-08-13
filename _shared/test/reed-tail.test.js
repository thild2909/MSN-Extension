// Drives reed-crawler/content.js off the END of a Reed search, which is where a complete run
// started reporting itself as a broken one.
//
// The run this fixture reproduces, verbatim from its own summary:
//
//   Done in 23s: 194 companies from 645 jobs of the 667 Reed reports - 22 NOT READ over 27 page(s)
//   2 page(s) could not be read at all - those jobs are missing.
//   Reed stopped serving results part way through - that is a refusal, not the end of the list.
//   Reed's "Next" link could not be found on 3 page(s)
//   Requests: 5x HTTP 404
//
// 667 jobs is 27 pages of 25, and 27 pages were read - the walk had reached the end of the list
// and every one of those warnings is about pages that do not exist. Reed renders its "Next" link
// on the last page too, so the walk followed it to page 28, got a 404, counted forward to 29 and
// 30, got two more, called three failures in a row a refusal, then retried two of them on the way
// out: 5x HTTP 404, exactly. Nothing was missing and nothing refused anything.
//
// What this fixture pins down:
//
//   * the walk stops at the last page the RESULT COUNT allows, whatever the paginator renders
//   * a page number past the end is never requested, so the run ends with no 404s at all
//   * no page is reported lost, and no refusal is reported, on a run that read every page
//   * the gap between Reed's own count and the file is ACCOUNTED FOR rather than left as a bare
//     "22 NOT READ" - here two ads are served on two pages each, and the summary says so
//   * a card carrying no job id is still written to the file instead of vanishing silently
//   * a search that fits on ONE page does not follow that page's "Next" link either

const fs=require("fs");
const path=require("path");
const vm=require("vm");

const {parseCsv}=require("./csv.js");

const DIR=process.argv[2]||"./reed-crawler";

const ORIGIN="https://www.reed.co.uk";
const SEARCH=ORIGIN+"/jobs/software-developer-jobs?q=software+developer";

const {makeDocument}=require("./minidom.js");

const PAGE_SIZE=25;

// 67 jobs is three pages of 25 - the same shape as the real run's 667 over 27, small enough to
// read in a fixture. Set per scenario by run().
let TOTAL=67;

//---------------------------------------------------
// the fixture
//---------------------------------------------------

function card(job){

    // Reed's paid slots: the SAME ones on every page, outside the 25 organic results and not in
    // the result count. They are ordinary ads that also appear in the list somewhere, so every
    // copy after the first is a duplicate - two per page over 27 pages was 54 of one real run's
    // 80 duplicate cards, and it read like something going badly wrong.
    const badges=job.promoted
        ? '<div data-qa="badges-container"><span class="badge" data-qa="badge-0-promoted">Promoted</span></div>'
        : "";

    const posted=job.company
        ? `${job.posted} by <a href="/jobs/${job.slug}/p${job.pid}" class="index-module_profileUrl__1BKrL" data-element="recruiter">${job.company}</a>`
        : job.posted;

    // `noId` is the card Reed occasionally renders with neither data-id nor a linked title
    const article=job.noId
        ? `<article class="card index-module_jobCard__DaYuk" data-qa="job-card">`
        : `<article class="card index-module_jobCard__DaYuk" data-qa="job-card" data-id="job${job.id}">`;

    const heading=job.noId
        ? `<h2><span class="index-module_jobTitle__702ZU">${job.title}</span></h2>`
        : `<h2><a href="/jobs/${job.titleSlug}/${job.id}?source=searchResults" class="index-module_jobTitle__702ZU" data-id="${job.id}" title="${job.title}" data-qa="job-card-title">${job.title}</a></h2>`;

    return `<div data-card-id="${job.id}-SearchSection">${article}`
        +`<div class="index-module_jobCard__body__vWzBf card-body"><div class="row">`
        +`<div class="index-module_container__2Gt-v col-sm-12 col-md-7"><header>`
        +badges
        +heading
        +`<div data-qa="job-posted-by" class="index-module_postedBy__nBQbf">${posted}</div>`
        +`<ul class="index-module_jobMetadata__Hmbnh list-group" role="list" data-qa="job-metadata">`
        +`<li data-qa="job-metadata-salary" class="list-group-item" role="listitem ">${job.salary}</li>`
        +`<li data-qa="job-metadata-location" class="list-group-item" role="listitem ">${job.location}</li>`
        +`<li class="list-group-item" role="listitem ">Permanent, full-time</li>`
        +`</ul></header></div></div></div></article></div>`;

}

// Reed's paginator, and the whole point of this fixture: "Next" is rendered on the LAST page too.
// It is a plain <a> pointing at ?pageno=<last+1>, a page number the site answers 404.
function pager(page){

    const href=n=>`/jobs/software-developer-jobs?q=software+developer&amp;pageno=${n}`;

    const numbers=[1,2,3].filter(n=>n!==page)
        .map(n=>`<li class="page-item"><a href="${href(n)}" class="page-link" aria-label="Goto Page ${n}">${n}</a></li>`).join("");

    const from=(page-1)*PAGE_SIZE+1;
    const to=Math.min(page*PAGE_SIZE,TOTAL);

    return `<div class="card pagination_pagination__DChuV">`
        +`<header class="pagination_pagination__heading__hlCzI card-header" data-qa="pagination_heading">${from}<!-- --> - <!-- -->${to}<!-- --> of <!-- -->${TOTAL}<!-- --> jobs</header>`
        +`<div class="card-body"><nav class="" role="navigation" aria-label="pagination"><ul class="pagination">`
        +`<li class="page-item"><a href="${href(Math.max(1,page-1))}" class="page-link previous" aria-label="Previous page">Previous</a></li>`
        +`<li class="page-item active disabled"><span class="page-link" aria-label="Goto Page ${page}">${page}</span></li>`
        +numbers
        +`<li class="page-item"><a href="${href(page+1)}" class="page-link next" aria-label="Next page">Next</a></li>`
        +`</ul></nav></div></div>`;

}

function resultsPage(page,cards){

    return `<!DOCTYPE html><html><head><title>Software Developer Jobs</title></head><body>`
        +`<div class="layout_content__49Kn9"><div class="container-xxl">`
        +`<div class="row"><div class="col-sm-12"><h1 data-qa="searchHeading">${TOTAL} Software Developer Jobs</h1></div></div>`
        +`<div class="row"><main class="search-results_mainBlock__Rp2r_ order-2 col-sm-12">`
        +cards.map(card).join("")
        +pager(page)
        +`</main></div></div></div></body></html>`;

}

// One ad per company, so a row in the file is an ad and the counting is unambiguous.
function ad(n){

    return {
        id:String(57000000+n),
        title:"Software Engineer "+n,
        titleSlug:"software-engineer-"+n,
        company:"Recruiter "+n,
        slug:"recruiter-"+n,
        pid:String(10000+n),
        posted:"5 days ago",
        salary:"£50,000 per annum",
        location:"London"
    };

}

const PAGE1=[];
for(let n=1;n<=25;n++) PAGE1.push(ad(n));

// The list shifted while the walk was running: two new ads were posted, so the last two ads of
// page 1 were pushed down onto page 2 and are served twice. This is what a gap between Reed's own
// count and the file is actually made of, and the run above had 22 of them.
const PAGE2=[ad(24),ad(25)];
for(let n=26;n<=48;n++) PAGE2.push(ad(n));

const PAGE3=[];
for(let n=49;n<=64;n++) PAGE3.push(ad(n));

// ...and one card Reed rendered with neither a data-id nor a linked title. It is still an ad by a
// named recruiter and must not disappear without a word.
PAGE3.push(Object.assign(ad(65),{noId:true}));

//---------------------------------------------------
// the list that will not hold still
//
// This is the second thing the real run hit, and the one that actually cost coverage. A search is
// one list read 25 rows at a time, and Reed keeps posting to it while that happens. Here two ads
// land at the top after page 1 has already been read:
//
//   at t0   page 1 = [1..25]                       <- what the live tab showed
//   at t1   the list is [66,67,1..65]
//           page 2 = rows 26-50 = [24,25,26..48]   <- 24 and 25 repeat, 66 and 67 are above
//           page 3 = rows 51-67 = [49..65]
//
// Every page was read, in order, exactly once - and 66 and 67 were served to nobody. That is 65
// of 67, and the only thing that gets the other two is asking for page 1 again at the end.
//---------------------------------------------------

const SETTLED=[];
for(let n=1;n<=65;n++) SETTLED.push(ad(n));

const SHIFTED=[ad(66),ad(67)].concat(SETTLED);

function slice(list,n){

    const out=list.slice((n-1)*PAGE_SIZE,n*PAGE_SIZE);

    return out.length?out:null;

}

//---------------------------------------------------
// run it
//
// Each scenario gets its own sandbox: content.js sets a window flag to guard against being run
// twice on one tab, and two runs sharing a sandbox would trip it.
//
// `first` is what the live tab shows; `pageFor(n)` is what a fetch of ?pageno=n answers, null for
// a page number the site does not have.
//---------------------------------------------------

function run(scenario){

TOTAL=scenario.total;

const asked=[];
const statuses=[];
const alerts=[];
const errors=[];
const warnings=[];

let rows=null;

const doc=makeDocument(resultsPage(1,scenario.first));

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
    Date,Math,JSON,Promise,Set,Map,Array,Object,String,Number,RegExp,Error,isNaN,parseInt,parseFloat,
    Infinity,URL,URLSearchParams,
    Blob:class{constructor(parts){rows=parseCsv(parts.join(""));}},
    DOMParser:class{parseFromString(html){return makeDocument(html);}},
    fetch:async url=>{

        asked.push(url);

        const page=/[?&]pageno=(\d+)/.exec(url);
        const n=page?+page[1]:1;

        // Reed answers a page number past the end of the list with a 404, not with an empty page
        const served=scenario.pageFor(n);

        const status=served?200:404;

        statuses.push(status);

        return {
            status,
            ok:status===200,
            url,
            headers:{get:()=>null},
            text:async()=>served?resultsPage(n,served)
                :"<html><body><h1>Page not found</h1></body></html>"
        };

    },
    document:doc,
    location:{href:SEARCH,origin:ORIGIN,hostname:"www.reed.co.uk",
        search:"?q=software+developer",pathname:"/jobs/software-developer-jobs"},
    chrome:{
        storage:{
            local:{
                // profiles off: this fixture is about the walk, not the headcount
                get:async()=>({maxPages:0,profiles:false,concurrency:4}),
                set:async()=>{},
                remove:async()=>{}
            },
            session:{get:async()=>({}),set:async()=>{}}
        },
        runtime:{
            sendMessage:async()=>({ok:false,error:"no worker in the test"}),
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

return (async()=>{

    const until=Date.now()+20000;

    while(Date.now()<until&&!alerts.length) await new Promise(r=>setTimeout(r,25));

    await new Promise(r=>setTimeout(r,150));

    return {
        asked,statuses,alerts,errors,warnings,rows,
        summary:alerts.join("\n"),
        pagesAsked:asked.filter(url=>/pageno=/.test(url)).map(url=>+/pageno=(\d+)/.exec(url)[1])
    };

})();

}

//---------------------------------------------------
// assertions
//---------------------------------------------------

let failed=0;
let passed=0;

function check(name,condition,detail){

    if(condition){
        passed++;
        console.log("  pass  "+name);
        return;
    }

    failed++;

    console.log("  FAIL  "+name+(detail?"\n          "+detail:""));

}

const BROKEN=/ReferenceError|TypeError|is not defined|is not a function|before initialization|Cannot read/;

function shared(label,run,lastPage){

    if(!run.alerts.length){

        check(label+": the crawler reached its summary",false,
            run.errors.slice(-1).concat(run.warnings.slice(-1)).join(" | "));

        return false;

    }

    // SHOW_SUMMARY=1 prints what the run would have put in front of the user. The summary is the
    // whole subject of this fixture, so being able to read it is worth one env var.
    if(process.env.SHOW_SUMMARY) console.log("\n--- "+label+" ---\n"+run.summary+"\n");

    const broken=run.errors.concat(run.warnings).concat(run.alerts).filter(t=>BROKEN.test(t));

    check(label+": no ReferenceError/TypeError anywhere in the run",broken.length===0,broken[0]);

    check(label+": a file was written",Array.isArray(run.rows)&&run.rows.length>0);

    // the bug: Reed renders "Next" on the last page too, and the walk followed it off the end
    check(label+": no page number past the last page is ever requested",
        !run.pagesAsked.some(n=>n>lastPage),"asked for "+run.pagesAsked.join(", "));

    check(label+": the run ends with no 404 at all",
        !run.statuses.includes(404),
        run.statuses.filter(s=>s!==200).length+" non-200 response(s)");

    check(label+": a complete run does not report pages lost",
        !/could not be read at all/.test(run.summary),run.summary);

    check(label+": a complete run does not report a refusal",
        !/stopped serving results part way through/.test(run.summary),run.summary);

    check(label+": a complete run does not claim the Next link was missing",
        !/"Next" link could not be found/.test(run.summary),run.summary);

    return Array.isArray(run.rows)&&run.rows.length>0;

}

(async()=>{

    //---------------------------------------------------
    // three pages, the last of them still rendering "Next"
    //---------------------------------------------------

    const TAIL={1:PAGE1,2:PAGE2,3:PAGE3};

    const tail=await run({total:67,first:PAGE1,pageFor:n=>TAIL[n]||null});

    if(shared("3 pages",tail,3)){

        check("3 pages: pages 2 and 3 were both read",
            tail.pagesAsked.includes(2)&&tail.pagesAsked.includes(3),tail.pagesAsked.join(", "));

        // 25 + 23 new + 17 = 65 distinct ads, one company each
        check("3 pages: every distinct ad is in the file",tail.rows.length===65,
            tail.rows.length+" rows, last: "+tail.rows[tail.rows.length-1]["Company Name"]);

        check("3 pages: the card with no job id is written to the file too",
            tail.rows.some(row=>row["Company Name"]==="Recruiter 65"),
            tail.rows.map(r=>r["Company Name"]).slice(-3).join(" | "));

        // Reed counts 67, the file holds 65, and the two are the ads that were served twice.
        // Saying "2 NOT READ" and stopping there is what made a complete run unexplainable.
        check("3 pages: the gap against Reed's own count is explained, not just counted",
            /served twice|same ad|already read on an earlier page/i.test(tail.summary),tail.summary);

        check("3 pages: the summary names how many ads were served twice",
            /\b2 card\(s\) repeated an ad already read/.test(tail.summary),tail.summary);

    }

    //---------------------------------------------------
    // ...and the sharpest form of the same bug: a search that fits on one page. There is no page
    // 2 to ask for, and the paginator offers one anyway.
    //---------------------------------------------------

    const ONLY=PAGE1.slice(0,9);

    const single=await run({total:9,first:ONLY,pageFor:n=>n===1?ONLY:null});

    if(shared("1 page",single,1)){

        check("1 page: no second page is requested at all",
            single.pagesAsked.length===0,"asked for "+single.pagesAsked.join(", "));

        check("1 page: all 9 ads are in the file",single.rows.length===9,
            single.rows.length+" rows");

        check("1 page: nothing is reported as missing",
            !/NOT READ/.test(single.summary)&&/complete/.test(single.summary),single.summary);

    }

    //---------------------------------------------------
    // ...and the list moving under the walk, which is what actually cost the real run its ads
    //---------------------------------------------------

    const shift=await run({total:67,first:SETTLED.slice(0,PAGE_SIZE),pageFor:n=>slice(SHIFTED,n)});

    if(shared("shifting list",shift,3)){

        // page 1 is re-read at the end, so pages 2 and 3 are not the only fetches any more
        check("shifting list: page 1 is read again after the walk",
            shift.pagesAsked.includes(1),"asked for "+shift.pagesAsked.join(", "));

        check("shifting list: the two ads the walk was never served are recovered",
            shift.rows.length===67,shift.rows.length+" rows - missing: "
                +[66,67].filter(n=>!shift.rows.some(r=>r["Company Name"]==="Recruiter "+n))
                    .map(n=>"Recruiter "+n).join(", "));

        check("shifting list: the run reports itself complete",
            /- complete/.test(shift.summary)&&!/NOT READ/.test(shift.summary),shift.summary);

        check("shifting list: the summary says the second pass is what found them",
            /second pass went back for those and found 2/.test(shift.summary),shift.summary);

    }

    //---------------------------------------------------
    // Promoted slots: the same paid ads on every page, outside the result count. They must be
    // named as such rather than counted as ads lost to a shifting list - 54 of one real run's 80
    // duplicate cards were these, and they buried the 26 that mattered.
    //---------------------------------------------------

    const PROMO=[Object.assign(ad(99),{promoted:true})];

    const promoted=await run({
        total:50,
        first:PROMO.concat(SETTLED.slice(0,PAGE_SIZE)),
        pageFor:n=>n<=2?PROMO.concat(SETTLED.slice((n-1)*PAGE_SIZE,n*PAGE_SIZE)):null
    });

    if(shared("promoted slots",promoted,2)){

        check("promoted slots: the promoted ad is in the file exactly once",
            promoted.rows.filter(r=>r["Company Name"]==="Recruiter 99").length===1,
            promoted.rows.filter(r=>r["Company Name"]==="Recruiter 99").length+" rows for it");

        check("promoted slots: its repeat is named as a Promoted slot, not as a lost ad",
            /1 card\(s\) were Promoted slots/.test(promoted.summary),promoted.summary);

        check("promoted slots: it is NOT counted as an ad served on two pages",
            !/card\(s\) repeated an ad already read/.test(promoted.summary),promoted.summary);

    }

    console.log("\n"+passed+" passed, "+failed+" failed");

    process.exit(failed?1:0);

})();
