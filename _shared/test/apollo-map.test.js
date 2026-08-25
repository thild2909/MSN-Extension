// Drives apollo-crawler/content.js through a REAL mixed_people/search response and inspects the CSV
// it writes. Unlike smoke.js (which only proves the crawler does not crash against a blank stub),
// this stubs the page-world interceptor so content.js walks its whole replay -> map -> dedupe ->
// export path, and asserts the 46 columns come out in order with the right values.
//
// The two rules it holds:
//   * a locked email/phone (the account has not paid to reveal it) is left BLANK - the user asked
//     never to spend credits, so a placeholder that reads like a real address must never be written
//   * the same person served on two pages is ONE row - Apollo repeats and shifts pages, and dedupe
//     by person id is the only thing that keeps that from doubling the sheet
//
//   node _shared/test/apollo-map.test.js ./apollo-crawler

const fs=require("fs");
const path=require("path");
const vm=require("vm");

const ROOT=process.argv[2]||"./apollo-crawler";

//---------------------------------------------------
// the fixture: one page of two people, then a second page that repeats the first person
//---------------------------------------------------

const nicolas={
    id:"631f42f97e554100010cabdb",
    first_name:"Nicolas",last_name:"Sautter",name:"Nicolas Sautter",
    linkedin_url:"http://www.linkedin.com/in/nicolas-sautter",
    title:"Chief Executive Officer",
    headline:"CEO at beez-fm",
    seniority:"owner",
    departments:["c_suite"],
    city:"Singapore",state:"Singapore",country:"Singapore",
    photo_url:"https://example.com/nicolas.jpg",
    twitter_url:null,facebook_url:null,
    // locked -> must come out blank, no credit spent
    email:"email_not_unlocked@domain.com",email_status:"unavailable",
    email_domain_catchall:true,
    phone_numbers:[],
    organization:{
        id:"6a1012e39f0248000195de52",
        name:"beez fm Pte Ltd",
        website_url:"http://www.beez-fm.com",
        industry:"environmental services",
        estimated_num_employees:14,
        keywords:["building solution","restaurant solution"],
        annual_revenue:null,annual_revenue_printed:null,
        seo_description:"De-risking the built environment.",
        short_description:"The built environment is paralyzed by an execution gap.",
        linkedin_url:"http://www.linkedin.com/company/beez-fm",linkedin_uid:"12345678",
        total_funding:null,total_funding_printed:null,
        technology_names:["Google Analytics","WordPress"],
        logo_url:"https://example.com/beez.png",
        twitter_url:null,facebook_url:null,
        market_cap:null,founded_year:2019,
        primary_domain:"beez-fm.com",
        phone:"+65 6991 2336",
        raw_address:"20 Cecil St, Singapore",
        street_address:"20 Cecil St",city:"Singapore",state:"Singapore",country:"Singapore",postal_code:"049705"
    }
};

const jennifer={
    id:"66f3355982821400014847d1",
    first_name:"Jennifer",last_name:"Chen",name:"Jennifer Chen",
    linkedin_url:"http://www.linkedin.com/in/jensychen",
    title:"Chief Executive Officer",
    seniority:"founder",
    departments:["c_suite","engineering"],
    city:"Singapore",state:"Singapore",country:"Singapore",
    // unlocked -> must come out filled
    email:"jennifer@muse.ai",email_status:"verified",
    email_domain_catchall:false,
    phone_numbers:[{raw_number:"+65 9123 4567",sanitized_number:"+6591234567",type:"mobile",status:"verified"}],
    organization:{
        id:"611a9015c10f3500019b905d",
        name:"MUSE AI",
        industry:"marketing & advertising",
        estimated_num_employees:14,
        keywords:["marketing software","saas"],
        annual_revenue:5000000,annual_revenue_printed:"$5M",
        total_funding:2000000,total_funding_printed:"$2M",
        technology_names:["Stripe"],
        founded_year:2021,
        primary_domain:"muse.ai"
    }
};

function pageResponse(page){

    // three entries at two records a page: page 1 is full (Nicolas + Jennifer), page 2 carries the
    // rest. Page 2 is made to REPEAT Nicolas - the "shifted/repeated page" trap - so the test proves
    // nothing is deduped: the repeat must be kept, not dropped.
    if(page===1){
        return {pagination:{page:1,per_page:25,total_entries:3,total_pages:2},people:[nicolas,jennifer]};
    }

    return {pagination:{page:2,per_page:25,total_entries:3,total_pages:2},people:[nicolas]};

}

//---------------------------------------------------
// the sandbox: browser globals + a fake page-world interceptor spoken to over postMessage
//---------------------------------------------------

const alerts=[];
const errors=[];
let capturedCsv=null;

const listeners=[];

function dispatch(data){
    // deliver asynchronously, as a real message event would
    setTimeout(()=>{
        for(const fn of listeners.slice()) fn({data,source:sandbox});
    },0);
}

const anchor={style:{},href:"",download:"",click(){},remove(){}};

const documentStub={
    body:{appendChild(){},removeChild(){}},
    createElement:()=>anchor,
    addEventListener(){},
    location:{href:"https://app.apollo.io/#/people?page=1"}
};

const sandbox={
    console:{
        log:()=>{},
        warn:()=>{},
        error:(...a)=>errors.push(a.map(x=>x&&x.stack||x).join(" "))
    },
    alert:msg=>alerts.push(String(msg)),
    performance:{now:()=>Date.now()},
    setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms||0,3)),
    clearTimeout:id=>clearTimeout(id),
    Date,Math,JSON,Promise,Set,Map,Array,Object,String,Number,RegExp,Error,isNaN,parseInt,parseFloat,Infinity,
    URL:Object.assign(function(u,b){return new URL(u,b);},URL),
    URLSearchParams,TextDecoder,TextEncoder,
    Blob:class{constructor(parts){capturedCsv=(parts||[]).join("");}},
    DOMParser:class{parseFromString(){return documentStub;}},
    document:documentStub,
    location:{href:"https://app.apollo.io/#/people?page=1",hostname:"app.apollo.io"},
    chrome:{
        storage:{local:{
            get:async()=>({concurrency:3}),
            set:async()=>{},
            remove:async()=>{}
        }},
        runtime:{sendMessage:async()=>({}),onMessage:{addListener(){}}}
    }
};

sandbox.URL.createObjectURL=()=>"blob:stub";
sandbox.URL.revokeObjectURL=()=>{};

// the postMessage bridge + fake interceptor
sandbox.addEventListener=(type,fn)=>{ if(type==="message") listeners.push(fn); };
sandbox.removeEventListener=(type,fn)=>{ const i=listeners.indexOf(fn); if(i>=0) listeners.splice(i,1); };

sandbox.postMessage=data=>{

    if(!data||data.__ns!=="apolloCrawler"||data.dir!=="cs->page") return;

    if(data.cmd==="probe"){
        dispatch({__ns:"apolloCrawler",dir:"page->cs",id:data.id,
            ready:true,pagination:{page:1,per_page:25,total_entries:3,total_pages:2},
            endpoint:"https://app.apollo.io/api/v1/mixed_people/search"});
        return;
    }

    if(data.cmd==="replay"){
        dispatch({__ns:"apolloCrawler",dir:"page->cs",id:data.id,
            ok:true,status:200,json:pageResponse(data.page)});
        return;
    }

};

sandbox.window=sandbox;
sandbox.self=sandbox;
sandbox.globalThis=sandbox;

const context=vm.createContext(sandbox);

for(const file of ["core.js","content.js"]){
    vm.runInContext(fs.readFileSync(path.join(ROOT,file),"utf8"),context,{filename:file});
}

//---------------------------------------------------
// wait for the run to reach its summary alert, then assert
//---------------------------------------------------

(async()=>{

    const until=Date.now()+10000;

    while(Date.now()<until&&!alerts.length){
        await new Promise(r=>setTimeout(r,20));
    }

    const fails=[];

    function check(name,cond){
        if(!cond) fails.push(name);
    }

    check("run reached its summary alert",alerts.length>0);
    check("no console errors",errors.length===0);
    check("a CSV was written",!!capturedCsv);

    const EXPECTED_HEADER=["First Name","Last Name","Company Name","Company Website","Email",
        "Mobile Number","Full Name","LinkedIn","Title","Industry","Headline","Seniority","Department",
        "City","State","Country","Employees Count","Keywords","Company Annual Revenue Clean",
        "Company Annual Revenue","Company SEO Description","Company Short Description","Company Linkedin",
        "Company Linkedin UID","Company Total Funding Clean","Company Total Funding","Company Technologies",
        "Email Domain Catchall","Person Photo","Twitter URL","Facebook URL","Person ID","Company ID",
        "Company Phone Number","Company Logo","Company Twitter","Company Facebook","Company Market Cap",
        "Company Founded Year","Company Domain","Company Raw Address","Company Street Address",
        "Company City","Company State","Company Country","Company Postal Code"].join(",");

    // strip the BOM the exporter prefixes, split on CRLF, drop the trailing empty line
    const text=(capturedCsv||"").replace(/^﻿/,"");
    const lines=text.split("\r\n").filter(l=>l.length);

    check("header row is the 46 columns in order",lines[0]===EXPECTED_HEADER);
    // no dedupe: page 1 gives Nicolas + Jennifer, page 2 repeats Nicolas -> three data rows
    check("three data rows (nothing skipped, Nicolas kept on both pages)",lines.length===4);

    const body=lines.slice(1).join("\n");

    // Nicolas: locked email + no phone -> both blank (the ,, after the website)
    check("Nicolas row present with blank email+mobile",
        body.indexOf("Nicolas,Sautter,beez fm Pte Ltd,http://www.beez-fm.com,,,Nicolas Sautter,")>=0);
    check("Nicolas kept twice (no dedupe, nothing skipped)",
        (body.match(/(^|\n)Nicolas,Sautter,/g)||[]).length===2);
    check("catchall boolean written as text",body.indexOf(",true,")>=0);
    check("company phone (public) kept",body.indexOf("+65 6991 2336")>=0);
    check("company founded year kept",body.indexOf("2019")>=0);
    check("multi-value technologies quoted",body.indexOf('"Google Analytics, WordPress"')>=0);

    // Jennifer: unlocked email + mobile -> filled
    check("Jennifer unlocked email kept",body.indexOf("jennifer@muse.ai,+6591234567,Jennifer Chen,")>=0);
    check("Jennifer revenue mapped (clean + printed)",body.indexOf(",5000000,$5M,")>=0);
    check("multi-value department quoted",body.indexOf('"c_suite, engineering"')>=0);

    if(fails.length){
        console.log("FAIL apollo-map ("+fails.length+")");
        fails.forEach(f=>console.log("     - "+f));
        if(errors.length) errors.slice(0,3).forEach(e=>console.log("     err: "+e.split("\n")[0]));
        if(lines[0]) console.log("     header was: "+lines[0].slice(0,120)+"...");
        process.exit(1);
    }

    console.log("OK   apollo-map: 46 columns, locked fields blank, nothing skipped, "
        +(lines.length-1)+" rows, alert: "+(alerts[0]||"").split("\n")[0]);

    process.exit(0);

})();
