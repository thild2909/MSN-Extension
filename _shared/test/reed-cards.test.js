// Drives reed-crawler/content.js against REAL Reed markup, parsed for real.
//
// The other fixtures here hand-build a DOM out of stub objects, which is enough to test control
// flow - but it cannot test a single selector, because the stub answers whatever it is asked. On
// Reed that is exactly where the risk is: every class name is hashed per build
// (index-module_jobCard__DaYuk), so the crawler reads the page entirely through data-qa attributes
// and the shape of the markup around them. If one of those names is wrong the run does not crash,
// it writes a file with an empty column.
//
// So this file carries a small HTML parser and enough of a selector engine to answer the queries
// content.js actually makes, and the fixture below is Reed's own markup with the SVG icons and the
// advertising containers trimmed out. What it proves:
//
//   * a card yields all six columns - company, location, position, posted date, work model
//   * the three places Reed writes the recruiter are all read, including the card that has only
//     the "Posted by" line and no logo at all
//   * "5 days ago by ITOL Recruit" is split, so the recruiter does not end up in the date column
//   * the two metadata rows Reed gives no data-qa (contract type, "Work from home") are told apart
//   * two ads from one recruiter written differently ("Matchtech " with a trailing space) fold
//     into one row, and the newest of their dates is the one that lands in the file
//   * the paginator is followed to page 2 and the walk stops on the first page with no cards
//   * Employees comes off the profile page when it is published there, and stays blank otherwise

const fs=require("fs");
const path=require("path");
const vm=require("vm");

const DIR=process.argv[2]||"./reed-crawler";

const ORIGIN="https://www.reed.co.uk";
const SEARCH=ORIGIN+"/jobs/software-developer-jobs?q=software+developer";


//---------------------------------------------------
// the HTML parser and selector engine live in minidom.js, so this fixture and dice-cap.test.js
// read their site's real markup through the same one
//---------------------------------------------------

const {Node,makeDocument}=require("./minidom.js");

//---------------------------------------------------
// the fixture: Reed's own markup, SVG icons and advert containers trimmed
//---------------------------------------------------

function card(job){

    const badges=job.promoted?'<div data-qa="badges-container"><span class="badge" data-qa="badge-0-promoted">Promoted</span></div>':"";

    // Reed writes the recruiter in three different ways depending on whether it has a logo, and
    // all three are in this fixture on purpose
    const logo=job.logo==="image"
        ? `<div class="index-module_logoWrapper__bbiw3"><div><a href="/jobs/${job.slug}/p${job.pid}" data-qa="company-logo-link" title="Jobs from ${job.company}"><img alt="${job.company} jobs" data-qa="company-logo-image" src="https://resources.reed.co.uk/x.png"></a></div></div>`
        :job.logo==="text"
        ? `<div class="index-module_logoWrapper__bbiw3"><div><span class="company-logo_postedByText__NRBTl">Posted by <a href="/jobs/${job.slug}/p${job.pid}" data-company="${job.company}" data-qa="company-name-link">${job.company}</a></span></div></div>`
        :"";

    const wfh=job.wfh?'<li class="index-module_jobMetadata__item__xWXZK list-group-item" role="listitem "><svg viewBox="0 0 16 16" role="img" aria-label="Home"><use xlink:href="#svg-remote" x="0" y="0"></use></svg>Work from home</li>':"";

    return `<div data-card-id="${job.id}-SearchSection"><article class="card index-module_jobCard__DaYuk result-job-card_jobCard__FMaiT" data-qa="job-card" data-id="job${job.id}">`
        +`<span class="index-module_hiddenContent__uFo8T">Job hidden.<button class="btn btn-link" type="button" data-qa="UnhideJobBtn">Undo</button></span>`
        +`<div class="index-module_jobCard__body__vWzBf card-body">`
        +`<button class="index-module_jobTitleBtn__block__lbc49 btn btn-link" type="button" data-qa="job-title-btn-wrapper">${job.title}</button>`
        +`<div class="row"><div class="index-module_container__2Gt-v col-sm-12 col-md-7"><header>${badges}`
        +`<h2 class="index-module_jobResultHeading__title__r7Yqg"><a href="/jobs/${job.titleSlug}/${job.id}?source=searchResults&amp;q=software%20developer" class="index-module_jobTitle__702ZU" color="link" data-id="${job.id}" title="${job.title}" data-qa="job-card-title" data-page-component="job_card" data-element="job_title">${job.title}</a></h2>`
        // `noProfile` is the third real shape: the recruiter is named, but in plain text with no
        // /p<id> anywhere on the card. Reed renders this whenever the agency has no profile page
        // set up on that ad - which is why an employer can arrive WITH an id on one card and
        // WITHOUT on the next, the case core.companyKeys exists for.
        +`<div data-qa="job-posted-by" class="index-module_postedBy__nBQbf">${!job.company
            ? job.posted
            : job.noProfile
            ? `${job.posted} by ${job.company}`
            : `${job.posted} by <a href="/jobs/${job.slug}/p${job.pid}" class="index-module_profileUrl__1BKrL gtmJobListingPostedBy" data-element="recruiter">${job.company}</a>`}</div>`
        +`<ul class="index-module_jobMetadata__Hmbnh list-group list-group-horizontal" role="list" data-qa="job-metadata">`
        +`<li data-qa="job-metadata-salary" class="index-module_jobMetadata__item__xWXZK list-group-item" role="listitem "><svg viewBox="0 0 16 16" role="img" aria-label="Salary"><use xlink:href="#svg-salary" x="0" y="0"></use></svg>${job.salary}</li>`
        +`<li data-qa="job-metadata-location" class="index-module_jobMetadata__item__xWXZK list-group-item" role="listitem "><svg viewBox="0 0 16 16" role="img" aria-label="Location"><use xlink:href="#svg-location" x="0" y="0"></use></svg>${job.location}</li>`
        +`<li class="index-module_jobMetadata__item__xWXZK list-group-item" role="listitem "><svg viewBox="0 0 16 16" role="img" aria-label="Clock"><use xlink:href="#svg-clock" x="0" y="0"></use></svg>${job.type||"Permanent, full-time"}</li>`
        +wfh
        +`</ul></header><button class="index-module_btnToggleJobDescription__Nva6- btn" type="button" data-qa="toggleDescriptionBtn">See more</button></div>`
        +`<aside class="index-module_asideBlock__dUhGU col-md-5"></aside>${logo}`
        +`<div class="index-module_jobResultsActions__1pdvB"></div></div></div></article></div>`;

}

function pager(page,last){

    const href=n=>`/jobs/software-developer-jobs?q=software+developer&amp;pageno=${n}`;

    const numbers=[2,3,4,5].map(n=>`<li class="page-item"><a href="${href(n)}" class="page-link" aria-label="Goto Page ${n}">${n}</a></li>`).join("");

    const next=page<last
        ? `<li class="page-item"><a href="${href(page+1)}" class="page-link next" aria-label="Next page">Next</a></li>`
        : "";

    return `<div class="card pagination_pagination__DChuV">`
        +`<header class="pagination_pagination__heading__hlCzI card-header" data-qa="pagination_heading">${(page-1)*25+1}<!-- --> - <!-- -->${page*25}<!-- --> of <!-- -->3,494<!-- --> jobs</header>`
        +`<div class="pagination_pagination__content__f7hf8 card-body"><nav class="" role="navigation" aria-label="pagination"><ul class="pagination">`
        +`<li class="page-item disabled"><a href="/jobs/software-developer-jobs?q=software+developer" class="page-link previous" aria-label="Previous page">Previous</a></li>`
        +`<li class="page-item active disabled"><span class="page-link" aria-label="Goto Page ${page}">${page}</span></li>`
        +numbers+next+`</ul></nav></div></div>`;

}

function resultsPage(page,last,cards){

    return `<!DOCTYPE html><html><head><title>Software Developer Jobs</title></head><body>`
        +`<div class="layout_content__49Kn9"><div class="container-xxl"><div class="search-results_headingContainer__TSH2n row">`
        +`<div class="col-sm-12"><h1 class="search-results_heading__IFGcn" data-qa="searchHeading">3,494 <a href="/jobs/software-developer-jobs?q=software+developer" title="Software Developer jobs">Software Developer</a> Jobs</h1></div></div>`
        +`<div class="row"><main class="search-results_mainBlock__Rp2r_ order-2 col-sm-12">`
        +cards.map(card).join("")
        +pager(page,last)
        +`</main></div></div></div></body></html>`;

}

const PAGE1=[
    {id:"57204881",title:"Trainee Software Developer",titleSlug:"trainee-software-developer",company:"ITOL Recruit",slug:"itol-recruit",pid:"57826",posted:"5 days ago",salary:"Training Course",location:"United Kingdom",logo:"text",promoted:true},
    {id:"57103204",title:"Software Engineer",titleSlug:"software-engineer",company:"Allan Webb",slug:"allan-webb",pid:"106589",posted:"21 July",salary:"Competitive salary",location:"Stonehouse, Gloucestershire",logo:"image"},
    {id:"57205630",title:"Software Engineer",titleSlug:"software-engineer",company:"Vermillion Analytics",slug:"vermillion-analytics",pid:"100633",posted:"5 days ago",salary:"£35,000 - £45,000 per annum",location:"London",logo:"text"},
    // the card Reed renders with no logo block at all: the recruiter exists only in "Posted by"
    {id:"57122279",title:"Software Engineer",titleSlug:"software-engineer",company:"AJ Bell",slug:"aj-bell-0",pid:"48440",posted:"14 July",salary:"Competitive salary",location:"Salford, Lancashire",logo:""},
    {id:"56715432",title:"Senior Software Engineer (f/m/d)",titleSlug:"senior-software-engineer-f-m-d",company:"Awin",slug:"awin-69909",pid:"69909",posted:"2 August",salary:"Competitive salary",location:"London",logo:""},
    {id:"56817566",title:"Senior Software Engineer (Java/Spring/AWS)",titleSlug:"senior-software-engineer-java-spring-aws",company:"Awin",slug:"awin-69909",pid:"69909",posted:"5 August",salary:"Competitive salary",location:"London",logo:""},
    {id:"57116684",title:"Software Developer – SaaS Provider",titleSlug:"software-developer--saas-provider",company:"Best4Business Group",slug:"best4business-limited",pid:"28008",posted:"13 July",salary:"Competitive salary",location:"Carlow, County Carlow",logo:"",wfh:true},
    {id:"57130247",title:"Software Engineer",titleSlug:"software-engineer",company:"Consula Group LTD",slug:"consula-group-ltd-112861",pid:"112861",posted:"16 July",salary:"£80,000 - £110,000 per annum",location:"Glasgow, Lanarkshire",logo:"image",wfh:true},
    // an ad Reed shows with a date and NO recruiter anywhere on the card - the date must not be
    // read as the company name, or one recruiter splits into a row per date it posted on
    {id:"57217935",title:"Software Engineer - Property Platform",titleSlug:"software-engineer-property-platform",company:"",slug:"",pid:"",posted:"Yesterday",salary:"Competitive salary",location:"Manchester, Lancashire",logo:""}
];

// Reed writes the same agency differently on different ads - "Matchtech " with a trailing space on
// the live site, and the legal name on another - while both link to profile 19617. The profile id
// is what has to hold them together, because the names alone would not.
const PAGE2=[
    {id:"57078290",title:"ADA Software Engineer",titleSlug:"ada-software-engineer",company:"Matchtech ",slug:"matchtech-19617",pid:"19617",posted:"1 July",salary:"£68 per hour",location:"Bristol, Avon",logo:"image"},
    {id:"57188553",title:"Software Developer - DV Cleared - Various Locations",titleSlug:"software-developer-dv-cleared-various-locations",company:"Matchtech Engineering Ltd",slug:"matchtech-19617",pid:"19617",posted:"5 August",salary:"£450 - £600 per day",location:"London",logo:""},

    // Two ads for the SAME role at one agency, and only the first of them carries a profile link.
    // Both halves of this pair are things the export used to get wrong:
    //   * the second card has no /p<id>, so keying each ad on its own filed it under the folded
    //     NAME while the first went to "id:90210" - one agency, two rows, a position each
    //   * both ads are titled "Software Engineer", and the Positions cell was built with a
    //     unique-push, so two live vacancies were written as one
    {id:"57190011",title:"Software Engineer",titleSlug:"software-engineer",company:"Nexa Systems",slug:"nexa-systems-90210",pid:"90210",posted:"2 days ago",salary:"£55,000 per annum",location:"Leeds, West Yorkshire",logo:"text"},
    {id:"57190012",title:"Software Engineer",titleSlug:"software-engineer",company:"Nexa Systems Ltd",slug:"",pid:"",posted:"6 days ago",salary:"£55,000 per annum",location:"Leeds, West Yorkshire",logo:"",noProfile:true}
];

// A profile page that publishes a size, next to one that does not. Both are real shapes: Reed's
// employer profiles carry an "About" table, and most agencies leave the size out of it.
function profilePage(size){

    return `<!DOCTYPE html><html><head><title>Profile</title></head><body><div class="profile_about__x1"><h2>About us</h2>`
        +(size?`<dl><dt>Company size</dt><dd>${size}</dd></dl>`:"<p>We place engineers across the UK.</p>")
        +`<p>We have placed more than 500 people into permanent roles since 1984.</p></div></body></html>`;

}

const PROFILES={
    "106589":profilePage("251 to 500 employees"),
    "69909":profilePage("1,001-5,000 employees"),
    "19617":profilePage(""),
    "90210":profilePage("11 to 50 employees")
};

//---------------------------------------------------
// run it
//---------------------------------------------------

const asked=[];
const alerts=[];
const errors=[];
const warnings=[];

let rows=null;

function bodyFor(url){

    const page=/[?&]pageno=(\d+)/.exec(url);

    if(page){

        const n=+page[1];

        if(n===2) return resultsPage(2,3,PAGE2);

        // past the end of the list: a page with no cards at all, which must stop the walk
        return resultsPage(n,3,[]);

    }

    const profile=/\/p(\d+)$/.exec(url.split("?")[0]);

    if(profile) return PROFILES[profile[1]]!==undefined?PROFILES[profile[1]]:profilePage("");

    return resultsPage(1,3,PAGE1);

}

const doc=makeDocument(resultsPage(1,3,PAGE1));

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
    Blob:class{constructor(){}},
    DOMParser:class{parseFromString(html){return makeDocument(html);}},
    fetch:async url=>{

        asked.push(url);

        return {
            status:200,
            ok:true,
            url,
            headers:{get:()=>null},
            text:async()=>bodyFor(url)
        };

    },
    document:doc,
    location:{href:SEARCH,origin:ORIGIN,hostname:"www.reed.co.uk",
        search:"?q=software+developer",pathname:"/jobs/software-developer-jobs"},
    chrome:{
        storage:{
            local:{
                get:async()=>({maxPages:0,profiles:true,concurrency:4}),
                set:async()=>{},
                remove:async()=>{}
            },
            session:{get:async()=>({}),set:async()=>{}}
        },
        runtime:{
            // no background worker in this fixture: every page must come back over fetch
            sendMessage:async()=>({ok:false,error:"no worker in the test"}),
            onMessage:{addListener(){}}
        }
    },
    XLSX:{
        utils:{
            json_to_sheet:data=>{
                rows=data;
                return {};
            },
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

function rowFor(name){
    return (rows||[]).find(row=>row["Company Name"]===name);
}

(async()=>{

    const until=Date.now()+20000;

    while(Date.now()<until&&!alerts.length) await new Promise(r=>setTimeout(r,25));

    await new Promise(r=>setTimeout(r,150));

    if(!alerts.length){

        console.log("  FAIL  the crawler never reached its summary");

        errors.slice(-3).forEach(text=>console.log("          error: "+text.split("\n").slice(0,3).join("\n          ")));
        warnings.slice(-3).forEach(text=>console.log("          warn:  "+text));

        process.exit(1);

    }

    const BROKEN=/ReferenceError|TypeError|is not defined|is not a function|before initialization|Cannot read/;

    const broken=errors.concat(warnings).concat(alerts).filter(t=>BROKEN.test(t));

    check("no ReferenceError/TypeError anywhere in the run",broken.length===0,broken[0]);

    check("a file was written",Array.isArray(rows)&&rows.length>0);

    if(!Array.isArray(rows)||!rows.length){
        console.log("\n0 passed, "+(failed||1)+" failed");
        process.exit(1);
    }

    check("the six columns are the ones asked for",
        JSON.stringify(Object.keys(rows[0]))===JSON.stringify(
            ["Company Name","Location","Positions","Recruitment time","Employees","Remote/Onsite"]),
        JSON.stringify(Object.keys(rows[0])));

    check("page 2 was fetched and read",asked.some(url=>/pageno=2/.test(url)),asked.join("\n          "));

    check("the walk stopped on the first page with no cards",!asked.some(url=>/pageno=[4-9]/.test(url)),
        asked.filter(url=>/pageno=/.test(url)).join(", "));

    // 9 ads on page 1 from 8 recruiters (Awin twice, one card with no recruiter at all), 4 on
    // page 2 from two (Matchtech twice, Nexa twice) -> 10 rows
    check("one row per recruiter, not per ad",rows.length===10,
        rows.length+" rows: "+rows.map(r=>r["Company Name"]).join(" | "));

    check("a date is never written into the Company Name column",
        !rows.some(row=>/^(?:yesterday|today|\d+ \w+ ago|\d{1,2} [A-Z][a-z]+)$/i.test(row["Company Name"])),
        rows.map(r=>r["Company Name"]).join(" | "));

    // first hit on page 1 first, last hit on page 2 last - so the sheet can be read straight down
    // against the site. Nexa is last because its cards are the last two on page 2.
    check("rows are in the order Reed shows them",
        rows[0]["Company Name"]==="ITOL Recruit"&&rows[rows.length-1]["Company Name"]==="Nexa Systems",
        rows.map(r=>r["Company Name"]).join(" | "));

    const itol=rowFor("ITOL Recruit");

    check("the recruiter is read from the 'Posted by' link",!!itol);

    check("the date is split off the recruiter's name",
        itol&&itol["Recruitment time"]==="5 days ago",
        itol&&JSON.stringify(itol["Recruitment time"]));

    check("location comes off the metadata row",
        itol&&itol["Location"]==="United Kingdom",itol&&itol["Location"]);

    check("the position is the job title",
        itol&&itol["Positions"]==="Trainee Software Developer",itol&&itol["Positions"]);

    check("a job with no work-from-home flag is Onsite",
        itol&&itol["Remote/Onsite"]==="Onsite",itol&&itol["Remote/Onsite"]);

    const ajbell=rowFor("AJ Bell");

    check("a card with no logo block at all still yields its recruiter",
        !!ajbell&&ajbell["Location"]==="Salford, Lancashire",
        ajbell&&JSON.stringify(ajbell));

    check("a date written as a day and month survives",
        ajbell&&ajbell["Recruitment time"]==="14 July",ajbell&&ajbell["Recruitment time"]);

    const awin=rowFor("Awin");

    check("two ads from one recruiter fold into one row with both positions",
        awin&&awin["Positions"]==="Senior Software Engineer (f/m/d) | Senior Software Engineer (Java/Spring/AWS)",
        awin&&awin["Positions"]);

    check("the NEWEST of a recruiter's dates is the one in the file",
        awin&&awin["Recruitment time"]==="5 August",awin&&awin["Recruitment time"]);

    check("a repeated location is written once",awin&&awin["Location"]==="London",awin&&awin["Location"]);

    const b4b=rowFor("Best4Business Group");

    // "Work from home" is a metadata row Reed gives no data-qa - it is told apart from the
    // contract type ("Permanent, full-time") by what it says
    check("the work-from-home row is recognised next to a town -> Hybrid",
        b4b&&b4b["Remote/Onsite"]==="Hybrid",b4b&&b4b["Remote/Onsite"]);

    const matchtech=rowFor("Matchtech")||rowFor("Matchtech ");

    check("two ads under different spellings of one profile id are one row",
        matchtech&&matchtech["Positions"].split(" | ").length===2,
        matchtech&&matchtech["Positions"]);

    check("its locations are both kept",
        matchtech&&matchtech["Location"]==="Bristol, Avon, London",matchtech&&matchtech["Location"]);

    check("Employees comes off the profile page when it is published there",
        rowFor("Allan Webb")&&rowFor("Allan Webb")["Employees"]==="251 to 500 employees",
        rowFor("Allan Webb")&&JSON.stringify(rowFor("Allan Webb")["Employees"]));

    check("a size written with a comma is read too",
        awin&&awin["Employees"]==="1,001-5,000 employees",awin&&JSON.stringify(awin["Employees"]));

    // the profile says "we have placed more than 500 people since 1984" and nothing else - a
    // body-wide regex reads that as a headcount, which is the one thing that must not happen
    check("advertising copy is NOT read as a headcount",
        matchtech&&!matchtech["Employees"],matchtech&&JSON.stringify(matchtech["Employees"]));

    check("every profile page was asked for exactly once",
        asked.filter(url=>/\/p19617$/.test(url)).length===1,
        asked.filter(url=>/\/p\d+$/.test(url)).join(", "));

    //---------------------------------------------------
    // every ad reaches the file, and one employer is one row however its cards were written
    //---------------------------------------------------

    const nexa=rowFor("Nexa Systems")||rowFor("Nexa Systems Ltd");

    check("an ad with a profile link and one without are ONE row",
        !!nexa&&!rows.some(row=>row!==nexa&&/^Nexa Systems/.test(row["Company Name"])),
        rows.map(r=>r["Company Name"]).join(" | "));

    // The one this file exists to pin down. Both Nexa ads are titled "Software Engineer" and both
    // are live vacancies; a Positions cell built with a unique-push wrote them as one, so the sheet
    // said the agency was hiring for a single role when it was hiring for two.
    check("two ads for the same role are two positions, not one",
        nexa&&nexa["Positions"]==="Software Engineer | Software Engineer",
        nexa&&JSON.stringify(nexa["Positions"]));

    // ...and the row still reaches the id-only data, which it can only do if the ad WITH the
    // profile link is the one that named it
    check("the row keeps the headcount from the card that had the profile link",
        nexa&&nexa["Employees"]==="11 to 50 employees",nexa&&JSON.stringify(nexa["Employees"]));

    // Across the whole sheet: every ad that was read is somewhere in a Positions cell. This is the
    // guarantee, stated once against the total rather than per company - 13 cards over two pages.
    const positions=rows.reduce((total,row)=>total+row["Positions"].split(" | ").filter(Boolean).length,0);

    check("every ad read is an entry in some Positions cell",positions===PAGE1.length+PAGE2.length,
        positions+" positions from "+(PAGE1.length+PAGE2.length)+" ads");

    // ...while the columns that describe the COMPANY stay a set. Nexa posted both ads in Leeds, and
    // "Leeds, West Yorkshire, Leeds, West Yorkshire" would be noise rather than data.
    check("a repeated location is still written once",
        nexa&&nexa["Location"]==="Leeds, West Yorkshire",nexa&&nexa["Location"]);

    console.log("\n"+passed+" passed, "+failed+" failed");

    process.exit(failed?1:0);

})();
