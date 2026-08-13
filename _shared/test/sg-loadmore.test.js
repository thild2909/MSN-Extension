// Drives startups-gallery-crawler/content.js against REAL startups.gallery markup, parsed for
// real, through the same HTML parser and selector engine as the Reed and Dice fixtures.
//
// startups.gallery is a Framer site, which means every class name in it is hashed per build:
// "framer-1m313x7" is this deploy's funding row and next deploy's something else. So the crawler
// reads the page through Framer's design-time names (data-framer-name), through hrefs, and
// through <time datetime>. A wrong one there does not crash a run - it writes an empty column.
//
// What this file proves:
//
//   * the feed has NO page URL. ?page=2 and ?skip=50 both answer 200 with the same first rows, so
//     the ONLY paginator is the Load More button and the walk has to press it for real
//   * ...and element.click() does NOT press it. The control is a framer-motion component, which
//     arms its tap on `pointerdown` and completes it on `pointerup`; click() fires neither, so the
//     handler never runs, nothing loads, and the walk reads a working feed as an exhausted one.
//     The fixture's button behaves exactly that way - it answers a pointer press and ignores a
//     bare click() - so a crawler that only knows how to call click() comes away with batch 1.
//   * Framer renders one copy of that button per breakpoint and hides all but one with CSS.
//     Pressing the first match presses an invisible one: it fires, nothing loads, and the walk
//     reads that as the end of the feed. Here the hidden copy is wired to do nothing, so a
//     crawler that picks it comes away with batch 1 and no more.
//   * Framer re-renders the WHOLE list rather than appending to it, so after two presses the DOM
//     holds every row seen so far. Every row is therefore read three times and must appear once.
//   * one company page per COMPANY, one row per ROUND - a company that raised twice is two rows
//     in the file and one request here
//   * the round's own stage wins over the company page's, which is the company's CURRENT stage:
//     an older round would otherwise be relabelled with whatever has been raised since
//   * the trap that makes this site different from the others in this folder: the footer is the
//     site's entire category and investor directory - every city, every stage, every fund -
//     linking to the SAME routes as the header pills. A crawler that reads "a[href*=/investors/]"
//     files all sixteen funds under whichever company it is looking at.
//   * Employees is a bare "11-50" under an icon, with no label and no link, so it is read as
//     "the cell in the pill row that is not inside a pill"
//   * about half the investor logos carry alt="Logo of Accel" and the rest carry nothing but a
//     slug, so the names the FEED spells out are what the rest are resolved through
//   * a company page that is refused still leaves its rounds in the file, with the round's own
//     columns filled

const fs=require("fs");
const path=require("path");
const vm=require("vm");

const {parseCsv}=require("./csv.js");
const {parse,makeDocument}=require("./minidom.js");

const DIR=process.argv[2]||"./startups-gallery-crawler";

const ORIGIN="https://startups.gallery";
const FEED=ORIGIN+"/news";

//---------------------------------------------------
// the fixture: startups.gallery's own markup, with the SVG icons, the inline stylesheet and the
// per-breakpoint duplicates trimmed to one each
//---------------------------------------------------

// the two class names Framer emits that are NOT per-build hashes, and the only two read here
const TEXT="framer-text";

function postRow(round){

    const investor=round.lead
        ? `<div class="framer-13t15z7"><div class="framer-z09p7c"><div class="framer-a3zmz"><!--$--><div class="ssr-variant"><div class="framer-zlob3k-container"><!--$-->`
            +`<a class="framer-mL0qv framer-xnfu6x framer-v-1uju214" data-framer-name="Company Name" href="./investors/${round.leadSlug}" style="background-color: rgb(255, 255, 255);">`
            +`<div class="framer-5wsthv" data-framer-component-type="RichTextContainer"><p dir="auto" class="${TEXT}">${round.lead}</p></div>`
            +`<div class="framer-1a9ibyf"><div data-framer-background-image-wrapper="true"><img decoding="auto" loading="lazy" width="200" height="200" src="https://framerusercontent.com/images/x.jpeg?width=200&amp;height=200" alt="Logo of ${round.lead}"></div></div>`
            +`</a><!--/$--></div></div><!--/$--></div></div></div>`
        : "";

    // the press link - note the two attribute orders the real page uses, data-framer-name before
    // href on some rows and after it on others
    const source=round.source
        ? `<!--$--><div class="ssr-variant"><div class="framer-o3znkh-container"><!--$-->`
            +(round.nameLast
                ? `<a class="framer-mL0qv framer-xnfu6x framer-v-xnfu6x" href="${round.source}" target="_blank" rel="nofollow" style="background-color: rgba(0, 0, 0, 0);" data-framer-name="Source">`
                : `<a class="framer-mL0qv framer-xnfu6x framer-v-xnfu6x" data-framer-name="Source" href="${round.source}" target="_blank" rel="nofollow" style="background-color: rgba(0, 0, 0, 0);">`)
            +`<div class="framer-5wsthv" data-framer-component-type="RichTextContainer"><p class="${TEXT} framer-styles-preset-1xfyfcj" data-styles-preset="dPbpH5WDT">Source</p></div>`
            +`<div data-framer-component-type="SVG" data-framer-name="graphic" class="framer-146kxpw" aria-hidden="true"><div class="svgContainer"><svg viewBox="0 0 24 24"><use href="#svg1521736815_315"></use></svg></div></div>`
            +`</a><!--/$--></div></div><!--/$-->`
        : "";

    return `<div class="framer-1m313x7" data-border="true" data-framer-name="Post">`
        +`<div class="framer-1qw7qul"><!--$--><div class="ssr-variant"><div class="framer-w5ptv6-container"><!--$-->`
        +`<a class="framer-mL0qv framer-xnfu6x framer-v-1uju214" data-framer-name="Company Name" href="./companies/${round.slug}" style="background-color: rgb(255, 255, 255); border-radius: 8px;">`
        +`<div class="framer-5wsthv" data-framer-component-type="RichTextContainer"><p dir="auto" class="${TEXT}">${round.company}</p></div>`
        +`<div class="framer-1a9ibyf"><div data-framer-background-image-wrapper="true"><img decoding="auto" loading="lazy" width="200" height="200" src="https://framerusercontent.com/images/y.webp?width=200&amp;height=200" alt=""></div></div>`
        +`</a><!--/$--></div></div><!--/$--></div>`
        +`<div class="framer-am87vl" data-framer-name="Amount" data-framer-component-type="RichTextContainer">`
        +`<p class="${TEXT} framer-styles-preset-1xfyfcj" data-styles-preset="dPbpH5WDT" dir="auto">${round.amount} &#183; ${round.stage}</p></div>`
        +`<div class="framer-1qjtltc" data-framer-name="Date" data-framer-component-type="RichTextContainer">`
        +`<p class="${TEXT} framer-styles-preset-1xfyfcj" data-styles-preset="dPbpH5WDT" dir="auto"><time datetime="${round.iso}T00:00:00.000Z">${round.shown}</time></p></div>`
        +investor+source
        +`</div>`;

}

// the column headings above the list. They carry data-framer-name="Company" - the SAME name the
// company chip on a row carries - which is why nothing here is read by that name.
const TRACKER_HEADER=`<div class="framer-x3jkxt" data-framer-name="Header">`
    +`<div class="framer-1mxc9ie"><div class="framer-8vyfqy" data-framer-name="Company" data-framer-component-type="RichTextContainer"><p class="${TEXT}">Company</p></div></div>`
    +`<div class="framer-7sj92r" data-framer-name="Company" data-framer-component-type="RichTextContainer"><p class="${TEXT}">Round</p></div>`
    +`<div class="framer-ww8ohn" data-framer-name="Company" data-framer-component-type="RichTextContainer"><p class="${TEXT}">Date</p></div>`
    +`<div class="framer-8g66u8"><div class="framer-1vaq1bv" data-framer-name="Company" data-framer-component-type="RichTextContainer"><p class="${TEXT}">Lead Investor</p></div></div>`
    +`<div class="framer-9dbfz7"><div class="framer-8rxqgk" data-framer-name="Company" data-framer-component-type="RichTextContainer"><p class="${TEXT}">Press</p></div></div>`
    +`</div>`;

// Framer ships one copy of the button per breakpoint and hides all but one with CSS. Both are in
// the document; only one is laid out.
function loadMore(variant){

    return `<div class="ssr-variant ${variant}"><div class="framer-12iag7o-container">`
        +`<div class="framer-jWIZC framer-121ine6 framer-v-121ine6" data-framer-name="Default" data-highlight="true" tabindex="0" style="background-color: rgb(255, 255, 255);">`
        +`<div class="framer-y46b7u" data-framer-component-type="RichTextContainer"><p class="${TEXT}">Load More</p></div>`
        +`<div data-framer-component-type="SVG" data-framer-name="Graphic" class="framer-puvyj1" aria-hidden="true"></div>`
        +`</div></div></div>`;

}

function feedPage(rows){

    return `<!DOCTYPE html><html><head><title>Funding News | startups.gallery</title></head><body>`
        +`<div class="framer-1gkl1dp" id="content"><div class="framer-tvx2cr" data-framer-name="Tracker">`
        +TRACKER_HEADER
        +`<div class="framer-1r7rp0" id="post-list">`+rows.map(postRow).join("")+`</div>`
        +`</div>`
        +loadMore("hidden-1lskyst hidden-12ix1d4")
        +loadMore("hidden-1a393w3")
        +`</div></body></html>`;

}

//---------------------------------------------------
// a company page
//
// ~390KB in the wild, three quarters of it the inline stylesheet in <head> and the directory in
// the footer. Both are here, shrunk but in the right places, because the crawler cuts the page
// down to the part between them before parsing it - and the cut is what keeps the directory from
// being read as this company's investors.
//---------------------------------------------------

const CITIES=["san-francisco","new-york","london","berlin","stockholm","sydney","los-angeles",
    "austin","boston","seattle","paris","toronto"];

const STAGES=["bootstrapped","pre-seed","seed","series-a","series-b","series-c","series-d","venture"];

const FUNDS=["parkway-vc","will-ventures","coreline-ventures","redalpine","sixth-street",
    "prime-movers-lab","halo-fund","aramco-ventures","smash-capital","natural-capital",
    "dell-technologies-capital","hyperion","sofina","andreessen-horowitz","greenoaks","accel"];

// the footer: the site's whole directory, as INLINE text links inside paragraphs. Same routes as
// the header pills, different markup - and "framer-text" is the only thing that tells them apart.
const DIRECTORY=`<div class="framer-1e2eqhy" data-framer-name="Footer">`
    +CITIES.map(city=>`<div class="framer-zygxu7"><p class="${TEXT} framer-styles-preset-a72926" data-styles-preset="DjNtiQGpQ" dir="auto"><!--$-->`
        +`<a class="${TEXT} framer-styles-preset-t60wry" data-styles-preset="O5Ewq_fU7" href="../categories/locations/cities/${city}">${city}</a><!--/$--></p></div>`).join("")
    +STAGES.map(stage=>`<div class="framer-zygxu7"><p class="${TEXT} framer-styles-preset-a72926" dir="auto"><!--$-->`
        +`<a class="${TEXT} framer-styles-preset-t60wry" href="../categories/stages/${stage}">${stage}</a><!--/$--></p></div>`).join("")
    +FUNDS.map(fund=>`<div class="framer-zygxu7"><p class="${TEXT} framer-styles-preset-a72926" dir="auto"><!--$-->`
        +`<a class="${TEXT} framer-styles-preset-t60wry" href="../investors/${fund}">${fund}</a><!--/$--></p></div>`).join("")
    +`</div>`;

function pill(route,text){

    return `<a class="framer-1nfw4m2 framer-1c6p87d" href="../categories/${route}">`
        +`<div class="framer-rf9ls7"><div data-framer-background-image-wrapper="true"></div></div>`
        +`<div class="framer-iz95ne" data-framer-component-type="RichTextContainer"><p dir="auto" class="${TEXT}">${text}</p></div>`
        +`</a><div class="framer-1hanyi1" data-framer-component-type="RichTextContainer"><h2 class="${TEXT}">&#183;</h2></div>`;

}

function investorLogo(investor){

    // about half the logos carry an alt; the rest carry nothing but the slug in the href
    const alt=investor.alt?` alt="Logo of ${investor.alt}"`:` alt`;

    return `<!--$--><a class="framer-1abqydb framer-1c6p87d" href="../investors/${investor.slug}">`
        +`<div class="framer-1vecohl" id="${investor.slug}-1vecohl"><div data-framer-background-image-wrapper="true">`
        +`<img decoding="async" width="1200" height="1200" src="https://framerusercontent.com/images/z.png?width=1200"${alt}></div></div>`
        +`</a><!--/$-->`;

}

function companyPage(company){

    const raised=`Raised ${company.amount} ${company.stage} on ${company.raisedOn}`;

    // the "Raised ..." line is rendered once per breakpoint, so it is in the document twice - and
    // the description is what comes after the LAST of them
    const amountBlock=`<div class="framer-1ohvi0i" data-framer-name="Amount Raised" data-framer-component-type="RichTextContainer">`
        +`<p class="${TEXT}">${raised}</p></div>`
        +`<div class="framer-1ohvi0i" data-framer-name="Amount Raised" data-framer-component-type="RichTextContainer">`
        +`<p class="${TEXT}">${raised}</p></div>`;

    const description=company.description
        ? `<div class="framer-fh2t8k" data-framer-component-type="RichTextContainer"><p dir="auto" class="${TEXT}">${company.description}</p></div>`
        : "";

    // the jobs feed. Everything the crawler reads is above it, which is where the cut lands - on
    // the fetched path. A page rescued in a tab is parsed whole, and then all of this is in the
    // document with the header.
    const feed=`<div class="framer-9zuf32" id="feed-1">`
        +`<a class="framer-a765ql framer-1c6p87d" href="https://jobs.ashbyhq.com/${company.slug}/1" target="_blank">`
        +`<div class="framer-bu8f75"><p class="${TEXT}">Technical Storyteller</p>`
        // the trap inside the trap: a job card carries a location too, and it is not the company's
        +`<p class="${TEXT}">New York City &#183; Posted on Jul 31, 2026</p>`
        // ...and a pay band, which is a bare number range in its own cell - the SAME shape as the
        // employees pill, because the employees pill has no label either
        +`<p class="${TEXT}">150–220</p></div></a>`
        +`</div>`;

    // a company that publishes no headcount has no cell at all, not an empty one
    const employees=company.employees
        ? `<div class="framer-177i4yn"><div class="framer-an4j7i"><div data-framer-background-image-wrapper="true"></div></div>`
            +`<div class="framer-19httlr" data-framer-component-type="RichTextContainer"><p dir="auto" class="${TEXT}">${company.employees}</p></div></div>`
        : "";

    return `<!DOCTYPE html><html><head>`
        +`<meta charset="utf-8">`
        +`<meta name="description" content="${company.name}: ${company.tagline} Find top early-stage startups backed by leading investors. Find startup jobs and funding news.">`
        +`<meta property="og:title" content="${company.name} | startups.gallery">`
        +`<title>${company.name} | startups.gallery</title>`
        // the inline stylesheet: a third of the real page, and above the cut
        +`<style>${":root{--token-a:rgb(1,2,3)}".repeat(40)}</style>`
        +`</head><body>`
        +`<div class="framer-1co0ci0" data-framer-name="Main"><div class="framer-1s3xhqk" data-framer-name="Content">`
        +`<h1 class="${TEXT}">${company.name}</h1>`
        +`<div class="framer-1muutbx"><p class="${TEXT}">Backed by </p>`
        +`<div class="framer-wz19p5">`+company.investors.map(investorLogo).join("")+`</div></div>`
        +`<div class="framer-1kk4hy8" data-framer-name="Buttons">`
        +`<a class="framer-1e8Cc framer-8wc9x1" data-framer-name="Button / Primary / 14px" data-highlight="true" href="${company.website}" target="_blank" rel="nofollow" tabindex="0">`
        +`<div class="framer-3f7ceu" data-framer-component-type="RichTextContainer"><p class="${TEXT}">Visit Website</p></div></a>`
        +`<a class="framer-1e8Cc framer-8wc9x1" data-framer-name="Button / White / 14px" data-highlight="true" href="https://jobs.ashbyhq.com/${company.slug}" target="_blank" rel="nofollow" tabindex="0">`
        +`<div class="framer-3f7ceu" data-framer-component-type="RichTextContainer"><p class="${TEXT}">View Jobs</p></div></a>`
        +`</div>`
        +amountBlock
        +description
        // the pill row: four linked pills and then the employees cell, which has no label, no
        // link and nothing but an icon next to it
        +`<div class="framer-1co0ci">`
        +pill(`locations/cities/${company.citySlug}`,company.location)
        +pill(`stages/${company.stageSlug}`,`${company.amount} ${company.stage}`)
        +pill(`industries/${company.industrySlug}`,company.industry)
        +pill(`work-type/${company.workSlug}`,company.work)
        +employees
        +`</div>`
        +feed
        +`</div></div>`
        +DIRECTORY
        +`</body></html>`;

}

//---------------------------------------------------
// the data: real rows off startups.gallery/news, and the real company pages behind them
//---------------------------------------------------

const BATCH1=[
    {company:"Blacksmith",slug:"blacksmith",amount:"$45M",stage:"Series B",iso:"2026-08-12",shown:"Aug 12, 2026",
        lead:"Peak XV",leadSlug:"peak-xv",source:"https://techcrunch.com/2026/08/12/blacksmiths-valuation-jumps-10x-to-550m/"},
    {company:"Lovable",slug:"lovable",amount:"$400M",stage:"Series C",iso:"2026-08-12",shown:"Aug 12, 2026",
        lead:"Menlo Ventures",leadSlug:"menlo-ventures",source:"https://lovable.dev/blog/series-c",nameLast:true},
    {company:"Alloy Robotics",slug:"alloy-robotics",amount:"$11.5M",stage:"Seed",iso:"2026-08-11",shown:"Aug 11, 2026",
        lead:"Square Peg",leadSlug:"square-peg",source:"https://www.usealloy.ai/post/every-robot-run"},
    {company:"River AI",slug:"river-ai",amount:"$1.1B",stage:"Seed",iso:"2026-08-11",shown:"Aug 11, 2026",
        lead:"General Catalyst",leadSlug:"general-catalyst",source:"https://runtimewire.com/article/river-ai-raises-1-1-billion"},
    // the row with no press link at all - it still has to reach the file
    {company:"Osmo Studio",slug:"osmo-studio",amount:"$5M",stage:"Seed",iso:"2026-08-05",shown:"Aug 5, 2026",
        lead:"Bain Capital Ventures",leadSlug:"bain-capital-ventures",source:""}
];

const BATCH2=[
    {company:"Valar Atomics",slug:"valar-atomics",amount:"$1B",stage:"Series B",iso:"2026-08-03",shown:"Aug 3, 2026",
        lead:"Sequoia",leadSlug:"sequoia-capital",source:"https://www.linkedin.com/posts/valar-atomics_announcing"},
    // The SAME company, an earlier round. One company page, two rows - and this row must keep
    // "Series B", not be relabelled with the Series C the company page now shows.
    {company:"Lovable",slug:"lovable",amount:"$200M",stage:"Series B",iso:"2026-02-20",shown:"Feb 20, 2026",
        lead:"Accel",leadSlug:"accel",source:"https://lovable.dev/blog/series-b"},
    {company:"Fish Audio",slug:"fish-audio",amount:"$52M",stage:"Seed",iso:"2026-07-28",shown:"Jul 28, 2026",
        lead:"Coreline Ventures",leadSlug:"coreline-ventures",source:"https://techcrunch.com/2026/07/28/fish-audio-raises-50m-seed/"},
    {company:"telli",slug:"telli",amount:"$15M",stage:"Seed",iso:"2026-07-28",shown:"Jul 28, 2026",
        lead:"redalpine",leadSlug:"redalpine",source:"https://www.linkedin.com/posts/finnzurmuehlen_we-just-raised-15m"}
];

const BATCH3=[
    // the company whose page is refused and cannot be rescued either - the round still has to
    // reach the file
    {company:"Ambrook",slug:"ambrook",amount:"$30M",stage:"Series B",iso:"2026-08-04",shown:"Aug 4, 2026",
        lead:"Lachy Groom",leadSlug:"lachy-groom",source:"https://www.upstartsmedia.com/p/ambrook-raises-30m-series-b"},
    // ...and the one that IS rescued, in a tab. A tab hands back the rendered document WHOLE -
    // the slice never runs on it - so this is the page where the footer directory is really in
    // the DOM, and the only thing keeping sixteen funds out of its Investors cell is that the
    // directory's links are inline text and the header's are not.
    {company:"Senra Systems",slug:"senra-systems",amount:"$65M",stage:"Series B",iso:"2026-07-15",shown:"Jul 15, 2026",
        lead:"Lowercarbon Capital",leadSlug:"lowercarbon-capital",source:"https://finance.yahoo.com/technology/articles/senra-systems-65-million"},
    // ...and one more rescued in a tab, which publishes NO headcount. Its whole page is parsed,
    // job cards and all, and one of those cards carries a pay band - a bare number range in a
    // cell of its own, which is exactly the shape of the employees pill. Blank is the right
    // answer here; a pay band in the Employees column is indistinguishable from a real headcount
    // once it is in the file.
    {company:"Monumental",slug:"monumental",amount:"$32M",stage:"Series B",iso:"2026-07-15",shown:"Jul 15, 2026",
        lead:"Khosla Ventures",leadSlug:"khosla-ventures",source:"https://www.monumental.co/press/announcing-our-32-million-fundraise/"},
    // the company page with no write-up: Description falls back to the meta tagline, with the
    // site's boilerplate cut off the end
    {company:"Throne",slug:"throne",amount:"$10M",stage:"Series A",iso:"2026-07-28",shown:"Jul 28, 2026",
        lead:"Will Ventures",leadSlug:"will-ventures",source:"https://www.businesswire.com/news/home/throne-science"}
];

const COMPANIES={
    blacksmith:{
        name:"Blacksmith",slug:"blacksmith",tagline:"The fastest way to run your GitHub Actions.",
        amount:"$45M",stage:"Series B",raisedOn:"August 12, 2026",stageSlug:"series-b",
        location:"San Francisco, United States",citySlug:"san-francisco",
        industry:"DevTools",industrySlug:"devtools",work:"Onsite",workSlug:"onsite",
        employees:"11–50",website:"https://www.blacksmith.sh/",
        description:"Blacksmith is a dead-simple, drop-in replacement for GitHub runners across Linux, Windows, and macOS that helps you run GitHub Actions faster, make everything (actually) observable, and reduce CI cost.",
        // Peak XV led the round and its logo carries NO alt, so its name can only come from the
        // feed row that named it
        investors:[{slug:"y-combinator",alt:"Y Combinator"},{slug:"google-ventures",alt:"Google Ventures"},{slug:"peak-xv",alt:""}]
    },
    lovable:{
        name:"Lovable",slug:"lovable",tagline:"Full-stack AI engineer.",
        amount:"$400M",stage:"Series C",raisedOn:"August 12, 2026",stageSlug:"series-c",
        location:"Stockholm, Sweden",citySlug:"stockholm",
        industry:"DevTools",industrySlug:"devtools",work:"Onsite",workSlug:"onsite",
        employees:"51–200",website:"https://lovable.dev/",
        description:"Build apps and websites by chatting with AI. We are a small team of serial founders, product engineers, physicists, competitive programmers and people who just care about building a great product and shipping fast.",
        investors:[{slug:"accel",alt:"Accel"},{slug:"menlo-ventures",alt:"Menlo Ventures"},
            {slug:"20vc-fund",alt:""},{slug:"visionaries-club",alt:"Visionaries Club"},
            {slug:"eqt-ventures",alt:"EQT Ventures"},{slug:"creandum",alt:"Creandum"},{slug:"hummingbird-vc",alt:""}]
    },
    "alloy-robotics":{
        name:"Alloy Robotics",slug:"alloy-robotics",tagline:"Data platform for robotics.",
        amount:"$11.5M",stage:"Seed",raisedOn:"August 11, 2026",stageSlug:"seed",
        location:"Sydney, Australia",citySlug:"sydney",
        industry:"Robotics",industrySlug:"robotics",work:"Onsite",workSlug:"onsite",
        employees:"11–50",website:"https://www.usealloy.ai/",
        description:"Alloy is how robotics teams learn from every mission. We capture data off the robot, surface what went wrong, diagnose why, generate reports, and track performance across your entire fleet.",
        investors:[{slug:"blackbird",alt:"Blackbird"},{slug:"square-peg",alt:""},{slug:"airtree",alt:"AirTree"}]
    },
    "river-ai":{
        name:"River AI",slug:"river-ai",tagline:"Custom models for every business.",
        amount:"$1.1B",stage:"Seed",raisedOn:"August 11, 2026",stageSlug:"seed",
        location:"San Francisco, United States",citySlug:"san-francisco",
        industry:"AI",industrySlug:"ai",work:"Onsite",workSlug:"onsite",
        employees:"11–50",website:"https://river.ai/",
        description:"River AI trains custom frontier models for businesses that cannot send their data to a shared endpoint, and runs them wherever the data already lives.",
        investors:[{slug:"general-catalyst",alt:"General Catalyst"}]
    },
    "osmo-studio":{
        name:"Osmo Studio",slug:"osmo-studio",tagline:"Digital scent.",
        amount:"$5M",stage:"Seed",raisedOn:"August 5, 2026",stageSlug:"seed",
        location:"New York, United States",citySlug:"new-york",
        industry:"Consumer",industrySlug:"consumer",work:"Onsite",workSlug:"onsite",
        employees:"1–10",website:"https://www.osmo.studio/",
        description:"Osmo Studio is giving computers a sense of smell, starting with a scent library that a phone can play back the way it plays a sound.",
        investors:[{slug:"bain-capital-ventures",alt:"Bain Capital Ventures"}]
    },
    "valar-atomics":{
        name:"Valar Atomics",slug:"valar-atomics",tagline:"The new atomic age.",
        amount:"$1B",stage:"Series B",raisedOn:"August 3, 2026",stageSlug:"series-b",
        location:"Los Angeles, United States",citySlug:"los-angeles",
        industry:"Energy",industrySlug:"energy",work:"Onsite",workSlug:"onsite",
        employees:"51–200",website:"https://valaratomics.com/",
        description:"Valar Atomics is scaling nuclear energy for heavy industrial power and clean hydrocarbon fuel production. To unlock economies of scale, we are building hundreds of nuclear reactors on Valar Atomics gigasites.",
        investors:[{slug:"sequoia-capital",alt:"Sequoia Capital"},{slug:"day-one-ventures",alt:""},
            {slug:"conviction-capital",alt:""},{slug:"alleycorp",alt:"AlleyCorp"},
            {slug:"initialized-capital",alt:"Initialized Capital"},{slug:"riot-ventures",alt:""}]
    },
    "fish-audio":{
        name:"Fish Audio",slug:"fish-audio",tagline:"Expressive TTS and audio generation.",
        amount:"$52M",stage:"Seed",raisedOn:"July 28, 2026",stageSlug:"seed",
        location:"San Francisco, United States",citySlug:"san-francisco",
        industry:"AI",industrySlug:"ai",work:"Onsite",workSlug:"onsite",
        employees:"11–50",website:"https://fish.audio/",
        description:"Fish Audio is a voice AI platform. Every core feature is available three ways: in the web app (no code), through the REST API, and via the official SDK.",
        investors:[{slug:"coreline-ventures",alt:""}]
    },
    telli:{
        name:"telli",slug:"telli",tagline:"AI phone calls that convert.",
        amount:"$15M",stage:"Seed",raisedOn:"July 28, 2026",stageSlug:"seed",
        location:"Berlin, Germany",citySlug:"berlin",
        industry:"Productivity",industrySlug:"productivity",work:"Onsite",workSlug:"onsite",
        employees:"11–50",website:"https://www.telli.com/",
        description:"telli helps companies build, deploy, and improve consumer-facing AI voice agents at scale. Today, leading B2C companies are already using telli to deploy thousands of voice agents.",
        investors:[{slug:"redalpine",alt:"redalpine"},{slug:"y-combinator",alt:"Y Combinator"}]
    },
    "senra-systems":{
        name:"Senra Systems",slug:"senra-systems",tagline:"Wire harnesses for hard things.",
        amount:"$65M",stage:"Series B",raisedOn:"July 15, 2026",stageSlug:"series-b",
        location:"Los Angeles, United States",citySlug:"los-angeles",
        industry:"Aerospace",industrySlug:"aerospace",work:"Onsite",workSlug:"onsite",
        employees:"51–200",website:"https://www.senrasystems.com/",
        description:"Senra Systems builds wire harnesses for aerospace, defense and industrial robotics, with the design and manufacturing loop closed in one place instead of five.",
        investors:[{slug:"lowercarbon-capital",alt:""},{slug:"general-catalyst",alt:"General Catalyst"}]
    },
    monumental:{
        name:"Monumental",slug:"monumental",tagline:"Robots that lay bricks.",
        amount:"$32M",stage:"Series B",raisedOn:"July 15, 2026",stageSlug:"series-b",
        location:"Amsterdam, Netherlands",citySlug:"amsterdam",
        industry:"Construction",industrySlug:"construction",work:"Onsite",workSlug:"onsite",
        // no headcount published at all
        employees:"",website:"https://www.monumental.co/",
        description:"Monumental builds robots that lay bricks on real construction sites, and the software that plans the wall they are laying before they get there.",
        investors:[{slug:"khosla-ventures",alt:"Khosla Ventures"}]
    },
    throne:{
        name:"Throne",slug:"throne",tagline:"A smart toilet sensor.",
        amount:"$10M",stage:"Series A",raisedOn:"July 28, 2026",stageSlug:"series-a",
        location:"Austin, United States",citySlug:"austin",
        industry:"Health",industrySlug:"health",work:"Onsite",workSlug:"onsite",
        employees:"11–50",website:"https://www.throne.science/",
        // no write-up at all: Description has to come off the meta tag
        description:"",
        investors:[{slug:"will-ventures",alt:"Will Ventures"}]
    }
};

//---------------------------------------------------
// the live tab
//---------------------------------------------------

const doc=makeDocument(feedPage(BATCH1),"Funding News | startups.gallery");

const list=doc.querySelector("#post-list");

// Which Load More copy is laid out. Framer hides the rest with CSS, and a hidden one answers a
// click by doing nothing at all - which is what this models.
const buttons=doc.querySelectorAll('[data-highlight="true"]');

const clicked={hidden:0,visible:0};

// what the visible button was actually sent, in order - so a failure says WHICH gesture was
// missing rather than just "nothing loaded"
const gestures=[];

let batchesServed=0;

function appendRows(rows){

    // Framer re-renders the whole list, so the rows already there STAY there and are read again
    const fragment=parse(rows.map(postRow).join(""));

    for(const child of fragment.childNodes.slice()){
        child.parentNode=list;
        list.childNodes.push(child);
    }

}

function serveNextBatch(){

    clicked.visible++;

    batchesServed++;

    if(batchesServed===1) appendRows(BATCH2);
    else if(batchesServed===2){

        appendRows(BATCH3);

        // ...and the feed is exhausted: Framer drops the button out of the document
        for(const copy of buttons){

            const parent=copy.parentNode;

            if(!parent) continue;

            parent.childNodes=parent.childNodes.filter(child=>child!==copy);

        }

    }

}

buttons.forEach((button,index)=>{

    // the first copy is the hidden one
    const hidden=index===0;

    button.getClientRects=()=>hidden?[]:[{width:120,height:36}];
    button.getBoundingClientRect=()=>hidden
        ?{left:0,top:0,width:0,height:0,right:0,bottom:0}
        :{left:40,top:200,width:120,height:36,right:160,bottom:236};

    button.focus=()=>{};

    // The real control is a Framer component - "framer-v-121ine6" is its current VARIANT and
    // data-highlight="true" is the marker Framer puts on anything with a tap or hover variant.
    // Those are framer-motion gestures, and framer-motion arms a tap on `pointerdown` and
    // completes it on `pointerup`. HTMLElement.click() fires neither: it dispatches a click event
    // and nothing else, so the handler never runs, nothing loads, and the walk reads a working
    // feed as an exhausted one.
    //
    // So this button does what the real one does - it answers a pointer press and ignores a bare
    // .click() - and a crawler that only knows how to call click() comes away with batch 1.
    let armed=false;

    button.click=()=>{

        if(hidden){
            clicked.hidden++;
            return;
        }

        gestures.push("click");

    };

    button.dispatchEvent=event=>{

        const type=event&&event.type||"";

        if(hidden){
            clicked.hidden++;
            return true;
        }

        gestures.push(type);

        if(type==="pointerdown") armed=true;

        else if(type==="pointerup"&&armed){

            armed=false;

            serveNextBatch();

        }

        return true;

    };

});

// every element that is not a Load More copy answers the layout question the same way, and
// swallows whatever is dispatched at it
for(const node of doc.descendants()){

    if(!node.getClientRects) node.getClientRects=()=>[{width:100,height:20}];

    if(!node.getBoundingClientRect){
        node.getBoundingClientRect=()=>({left:0,top:0,width:100,height:20,right:100,bottom:20});
    }

    if(!node.dispatchEvent) node.dispatchEvent=()=>true;

    if(!node.focus) node.focus=()=>{};

}

//---------------------------------------------------
// the sandbox
//---------------------------------------------------

const alerts=[];
const errors=[];
const warnings=[];
const asked=[];

let rows=null;

// refused a plain request. Senra is rescued by a tab below; Ambrook is refused there too.
const REFUSED=new Set([ORIGIN+"/companies/ambrook",ORIGIN+"/companies/senra-systems",
    ORIGIN+"/companies/monumental"]);

const NO_TAB_EITHER=new Set([ORIGIN+"/companies/ambrook"]);

const tabbed=[];

let clock=0;

class FakeEvent{

    constructor(type,init){

        Object.assign(this,init||{});

        this.type=String(type);
        this.defaultPrevented=false;

    }

    preventDefault(){
        this.defaultPrevented=true;
    }

    stopPropagation(){}

}

const sandbox={

    console:{
        log:()=>{},
        warn:(...a)=>warnings.push(a.join(" ")),
        error:(...a)=>errors.push(a.map(x=>x&&x.stack||x).join(" "))
    },

    alert:msg=>alerts.push(String(msg)),

    // A clock of its own, the same one wf-403.test.js runs on. Two of the company pages here are
    // refused, and the gate answers a refusal by parking the pool for seconds at a time. Squashing
    // setTimeout alone does not skip that: the gate re-checks in a loop until the wall clock has
    // caught up, so a 30 second cooldown becomes ten thousand 3ms spins and the fixture spends
    // the real 30 seconds anyway. Advancing the clock on every read burns the cooldown off in a
    // handful of calls, which is the point - the ladder is core.js's to test, not this file's.
    performance:{now:()=>(clock+=200)},

    setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms||0,1)),
    clearTimeout:id=>clearTimeout(id),
    setInterval:(fn,ms)=>setInterval(fn,Math.min(ms||0,3)),
    clearInterval:id=>clearInterval(id),

    // the crawler watches for the batch to land; here it lands inside the click, so the observer
    // never has to fire and the immediate re-check is what ends the wait
    MutationObserver:class{
        constructor(){}
        observe(){}
        disconnect(){}
        takeRecords(){return [];}
    },

    Date,Math,JSON,Promise,Set,Map,Array,Object,String,Number,RegExp,Error,isNaN,parseInt,parseFloat,Infinity,
    URL,URLSearchParams,TextDecoder,TextEncoder,

    // enough of an Event to carry a type and whatever init the crawler puts on it. The button
    // above reads nothing but `type`, which is the part that decides whether a Framer gesture
    // fires at all.
    Event:FakeEvent,
    UIEvent:FakeEvent,
    MouseEvent:FakeEvent,
    PointerEvent:FakeEvent,
    KeyboardEvent:FakeEvent,

    Blob:class{
        constructor(parts){
            this.text=parts.join("");
        }
    },

    DOMParser:class{
        parseFromString(html){
            return makeDocument(html,"");
        }
    },

    fetch:async url=>{

        asked.push(url);

        if(REFUSED.has(url)){
            return {status:403,ok:false,url,headers:{get:()=>null},text:async()=>""};
        }

        const slug=(/\/companies\/([^/?#]+)/.exec(url)||[])[1];

        const company=COMPANIES[slug];

        if(!company){
            return {status:404,ok:false,url,headers:{get:()=>null},text:async()=>""};
        }

        return {
            status:200,
            ok:true,
            url,
            headers:{get:()=>null},
            text:async()=>companyPage(company)
        };

    },

    document:doc,

    location:{href:FEED,origin:ORIGIN,hostname:"startups.gallery",search:"",pathname:"/news"},

    chrome:{
        storage:{
            local:{
                get:async()=>({maxClicks:0,details:true,concurrency:4}),
                set:async()=>{},
                remove:async()=>{}
            },
            session:{get:async()=>({}),set:async()=>{}}
        },
        runtime:{

            // the background worker, which reopens a refused URL as a real navigation and hands
            // back what the browser rendered - the WHOLE document, with no slice applied to it
            sendMessage:async message=>{

                if(!message) return {ok:false,error:"no message"};

                if(message.type==="tab:ping") return {ok:true};

                if(message.type!=="tab:fetch") return {ok:false,error:"unknown message"};

                const url=String(message.url||"");

                tabbed.push(url);

                if(NO_TAB_EITHER.has(url)) return {ok:false,error:"the tab could not be read"};

                const slug=(/\/companies\/([^/?#]+)/.exec(url)||[])[1];

                const company=COMPANIES[slug];

                if(!company) return {ok:false,error:"no such page"};

                return {ok:true,html:companyPage(company),url};

            },

            onMessage:{addListener(){}}

        }
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

// exportCsv builds an <a download>, so this is where the file is caught
const realCreate=doc.createElement;

doc.createElement=name=>{

    const node=realCreate(name);

    node.click=()=>{};

    return node;

};

sandbox.Blob=class{

    constructor(parts){

        const text=parts.join("");

        // strip the UTF-8 BOM Excel needs before parsing
        rows=parseCsv(text.replace(/^﻿/,""));

    }

};

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

function rowFor(company,date){
    return (rows||[]).find(row=>row["Company Name"]===company&&(!date||row["Date"]===date));
}

(async()=>{

    const until=Date.now()+25000;

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
        console.log("\n"+passed+" passed, "+(failed||1)+" failed");
        process.exit(1);
    }

    check("the columns are the ones asked for",
        JSON.stringify(Object.keys(rows[0]))===JSON.stringify(
            ["Company Name","Location","Funding Stage","Investors","Employees","Invest Amount",
                "Date","Description","Lead Investor","Industry","Website","Company Page","Press Source"]),
        JSON.stringify(Object.keys(rows[0])));

    //---------------------------------------------------
    // the Load More walk
    //---------------------------------------------------

    check("the VISIBLE Load More copy was pressed, not the hidden one",
        clicked.visible>0&&clicked.hidden===0,
        `visible: ${clicked.visible}, hidden: ${clicked.hidden}`);

    // The control is a framer-motion component: it arms its tap on pointerdown and completes it
    // on pointerup. A bare .click() fires neither, so this is the assertion that says the button
    // was PRESSED rather than merely clicked at.
    check("the press is a real pointer sequence, not a bare click()",
        gestures.indexOf("pointerdown")>=0&&gestures.indexOf("pointerup")>=0,
        "sent: "+(gestures.join(" > ")||"nothing"));

    check("...with the down before the up",
        gestures.indexOf("pointerdown")<gestures.indexOf("pointerup"),
        "sent: "+gestures.join(" > "));

    check("it kept clicking until the button was gone",clicked.visible===2,
        "clicked "+clicked.visible+" time(s)");

    check("every row of all three batches reached the file",rows.length===13,
        rows.length+" rows: "+rows.map(r=>r["Company Name"]+" "+r["Date"]).join(" | "));

    // Framer re-renders the whole list, so batch 1 is read three times and batch 2 twice
    check("a row re-rendered by a later batch is written once",
        rows.filter(row=>row["Company Name"]==="Blacksmith").length===1,
        rows.filter(row=>row["Company Name"]==="Blacksmith").length+" Blacksmith rows");

    check("the column headings above the list are not read as a funding row",
        !rows.some(row=>row["Company Name"]==="Company"||row["Company Name"]==="Lead Investor"),
        rows.map(r=>r["Company Name"]).join(" | "));

    //---------------------------------------------------
    // one page per company, one row per round
    //---------------------------------------------------

    const lovablePages=asked.filter(url=>/\/companies\/lovable$/.test(url));

    check("a company that raised twice is two rows",
        rows.filter(row=>row["Company Name"]==="Lovable").length===2,
        rows.filter(row=>row["Company Name"]==="Lovable").length+" Lovable rows");

    check("...and one company page request",lovablePages.length===1,
        lovablePages.length+" requests: "+lovablePages.join(", "));

    check("the older round keeps its OWN stage, not the company's current one",
        rowFor("Lovable","2026-02-20")&&rowFor("Lovable","2026-02-20")["Funding Stage"]==="Series B",
        rowFor("Lovable","2026-02-20")&&rowFor("Lovable","2026-02-20")["Funding Stage"]);

    check("...and both Lovable rows still share the company's columns",
        rowFor("Lovable","2026-02-20")&&rowFor("Lovable","2026-08-12")
            &&rowFor("Lovable","2026-02-20")["Location"]==="Stockholm, Sweden"
            &&rowFor("Lovable","2026-08-12")["Location"]==="Stockholm, Sweden");

    //---------------------------------------------------
    // the six columns asked for
    //---------------------------------------------------

    const blacksmith=rowFor("Blacksmith");

    check("Location comes off the company page",blacksmith["Location"]==="San Francisco, United States",
        blacksmith["Location"]);

    check("Employees is the unlabelled cell in the pill row",blacksmith["Employees"]==="11–50",
        JSON.stringify(blacksmith["Employees"]));

    check("Funding Stage is the round's",blacksmith["Funding Stage"]==="Series B",blacksmith["Funding Stage"]);

    check("Invest Amount and Date are split out of the row",
        blacksmith["Invest Amount"]==="$45M"&&blacksmith["Date"]==="2026-08-12",
        blacksmith["Invest Amount"]+" / "+blacksmith["Date"]);

    check("Description is the paragraph under the Raised line",
        /^Blacksmith is a dead-simple, drop-in replacement/.test(blacksmith["Description"]),
        blacksmith["Description"].slice(0,70));

    check("...and never the Raised line itself",
        !rows.some(row=>/^Raised \$/.test(row["Description"])),
        rows.map(r=>r["Description"].slice(0,30)).join(" | "));

    //---------------------------------------------------
    // investors: the sharpest trap on this site
    //---------------------------------------------------

    check("Investors is the company's own list, not the footer directory",
        blacksmith["Investors"]==="Y Combinator, Google Ventures, Peak XV",
        blacksmith["Investors"]);

    check("...so no company is credited with the whole directory",
        !rows.some(row=>/Parkway VC|Aramco Ventures|Sofina/i.test(row["Investors"])),
        rows.map(r=>r["Company Name"]+": "+r["Investors"]).join("\n          "));

    // The page above was cut down before it was parsed, so the directory was never in the
    // document to leak. This one was refused and reopened in a tab, and a tab hands back the
    // rendered page WHOLE - so here the sixteen funds really are in the DOM, four elements away
    // from the two that belong to the company.
    const senra=rowFor("Senra Systems");

    check("a refused page is rescued in a tab and still read",
        senra&&senra["Location"]==="Los Angeles, United States"&&senra["Employees"]==="51–200",
        senra&&JSON.stringify([senra["Location"],senra["Employees"]]));

    check("...and the directory does not leak into it, though nothing cut it out this time",
        senra&&senra["Investors"]==="Lowercarbon Capital, General Catalyst",
        senra&&senra["Investors"]);

    check("...nor does the directory's location list reach its Location cell",
        senra&&senra["Location"]==="Los Angeles, United States",senra&&senra["Location"]);

    const monumental=rowFor("Monumental");

    check("a company page that publishes no headcount leaves Employees blank",
        monumental&&monumental["Employees"]==="",
        monumental&&JSON.stringify(monumental["Employees"]));

    check("...rather than taking a job card's pay band, which is the same shape",
        !rows.some(row=>row["Employees"]==="150–220"),
        rows.map(r=>r["Company Name"]+": "+r["Employees"]).join(" | "));

    check("...and the rest of its page is still read",
        monumental&&monumental["Location"]==="Amsterdam, Netherlands"
            &&monumental["Investors"]==="Khosla Ventures",
        monumental&&JSON.stringify([monumental["Location"],monumental["Investors"]]));

    check("the tab was used for exactly the pages that were refused",
        tabbed.length>0&&tabbed.every(url=>REFUSED.has(url)),
        tabbed.join("\n          "));

    check("a logo with no alt is named from the feed row that spelled it out",
        /Peak XV/.test(blacksmith["Investors"]),blacksmith["Investors"]);

    check("...and one the feed never named falls back to its slug, title-cased",
        rowFor("Valar Atomics")&&/Day One Ventures/.test(rowFor("Valar Atomics")["Investors"]),
        rowFor("Valar Atomics")&&rowFor("Valar Atomics")["Investors"]);

    check("the lead investor from the row is kept in its own column",
        blacksmith["Lead Investor"]==="Peak XV",blacksmith["Lead Investor"]);

    //---------------------------------------------------
    // the pill row, and what must not leak into it
    //---------------------------------------------------

    check("Location is never a job card's location",
        !rows.some(row=>/New York City/.test(row["Location"])),
        rows.map(r=>r["Location"]).join(" | "));

    check("Industry comes off its own pill",blacksmith["Industry"]==="DevTools",blacksmith["Industry"]);

    check("Website is the Visit Website button, not the jobs board",
        blacksmith["Website"]==="https://www.blacksmith.sh/",blacksmith["Website"]);

    check("the press link is the row's, and an absent one is blank not wrong",
        rowFor("Osmo Studio")&&rowFor("Osmo Studio")["Press Source"]===""
            &&/techcrunch\.com/.test(blacksmith["Press Source"]),
        rowFor("Osmo Studio")&&JSON.stringify(rowFor("Osmo Studio")["Press Source"]));

    //---------------------------------------------------
    // degrading
    //---------------------------------------------------

    const ambrook=rowFor("Ambrook");

    check("a refused company page still leaves the round in the file",!!ambrook,
        rows.map(r=>r["Company Name"]).join(" | "));

    check("...with every column the ROW carried still filled",
        ambrook&&ambrook["Invest Amount"]==="$30M"&&ambrook["Date"]==="2026-08-04"
            &&ambrook["Funding Stage"]==="Series B"&&ambrook["Lead Investor"]==="Lachy Groom",
        ambrook&&JSON.stringify(ambrook));

    check("...and the page's columns blank rather than guessed",
        ambrook&&ambrook["Location"]===""&&ambrook["Employees"]===""&&ambrook["Description"]==="",
        ambrook&&JSON.stringify([ambrook["Location"],ambrook["Employees"],ambrook["Description"]]));

    const throne=rowFor("Throne");

    check("a company page with no write-up falls back to the meta tagline",
        throne&&throne["Description"]==="Throne: A smart toilet sensor.",
        throne&&JSON.stringify(throne["Description"]));

    check("...with the site's boilerplate cut off the end",
        throne&&!/Find top early-stage/.test(throne["Description"]),
        throne&&throne["Description"]);

    //---------------------------------------------------
    // no wasted requests
    //---------------------------------------------------

    check("the feed itself was never fetched - it is the tab, and ?page=2 serves it again",
        !asked.some(url=>/\/news/.test(url)),asked.join("\n          "));

    check("one request per company, none repeated",
        new Set(asked).size===asked.length||asked.filter(u=>/ambrook/.test(u)).length>1,
        asked.join("\n          "));

    console.log("\n"+passed+" passed, "+failed+" failed");

    process.exit(failed?1:0);

})();
