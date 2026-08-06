(async()=>{

    const LOG="[latka-crawler]";
    const ORIGIN=location.origin;

    //---------------------------------------------------
    // guard against double runs when the button is clicked repeatedly
    //---------------------------------------------------

    if(window.__latkaCrawlerRunning){
        alert("Crawler is already running on this tab. Wait for it to finish.");
        return;
    }

    window.__latkaCrawlerRunning=true;

    const core=window.CrawlerCore;

    if(!core){

        alert("core.js is not loaded in this tab. popup.js must inject core.js before content.js.");

        window.__latkaCrawlerRunning=false;

        return;

    }

    // Company table: there is only one <table> on the page, and the user picks the columns,
    // so the header is read dynamically instead of being hardcoded.
    const TABLE="table";
    const ROW="tbody tr";

    // Next page button: <a rel="next" aria-label="Next page" href="/saas-companies?page=2&...">
    const NEXT='a[rel="next"]';
    const NEXT_FALLBACK='nav[aria-label*="pagination" i] a';

    // company profile link: /companies/<slug>
    // (NOT the /companies/countries/... links in the Location column)
    const COMPANY_HREF=/^\/companies\/[^/]+$/;

    // "181 companies match your criteria." or "1 - 20 of 181"
    const TOTAL_MATCH=/([\d,]+)\s+companies\s+match/i;
    const TOTAL_OF=/\bof\s+([\d,]+)\b/i;

    // Latka's empty cell marker
    const EMPTY_CELL="-";

    const HARD_PAGE_CAP=200;

    // the pace the popup asks for is a floor, not a fixed toll: the gate widens it the moment
    // Latka actually refuses something and walks it back down once it stops
    const DELAY=0;

    const gate=core.makeGate({minGap:DELAY,limit:3,log:LOG});

    const fetcher=core.makeFetcher(gate,{log:LOG});

    const fetchDoc=fetcher.fetchDoc;

    const rows=[];

    // the /companies/<slug> of each row, kept beside rows[] rather than in it: an extra key on the
    // row object would come out as an extra column in the exported sheet
    const slugs=[];

    const visited=new Set();

    let headers=[];

    const startedAt=performance.now();

    const report=core.makeReporter("latka-crawler-status",LOG);

    const norm=core.norm;

    // A tab navigation kills the content script outright - no catch block runs and nothing is
    // written. The checkpoint turns that from "the whole run is gone" into "the next run starts
    // where this one stopped".
    const checkpoint=core.makeCheckpoint("latkaCheckpoint",{log:LOG});

    // set the moment the file is handed to the browser, so the crash path can never write a second one
    let fileWritten=false;

    let resumed=0;
    let rewound=0;

    try{

        //---------------------------------------------------
        // 0. XLSX must be injected into the tab BEFORE content.js
        //---------------------------------------------------

        if(typeof XLSX==="undefined"){

            const msg="XLSX is not loaded in this tab. popup.js must inject xlsx.full.min.js before content.js.";
            console.error(LOG,msg);
            alert(msg);
            return;

        }

        //---------------------------------------------------
        // 1. read the settings saved by the popup
        //---------------------------------------------------

        let maxPages=0;
        let pace=DELAY;

        try{

            const settings=await chrome.storage.local.get(["maxPages","pace"]);

            maxPages=Math.max(0,+settings.maxPages||0);

            if(settings.pace) pace=Math.min(5000,Math.max(0,+settings.pace));

        }
        catch(e){
            console.warn(LOG,"could not read settings, using defaults",e);
        }

        //---------------------------------------------------
        // 2. take the columns exactly as the visible header lists them
        //---------------------------------------------------

        headers=readHeaders(document);

        if(headers.length===0){

            alert("No company table found. Open a getlatka.com list page (for example /saas-companies) and run again.");
            return;

        }

        console.log(LOG,"columns:",headers.map(column=>column.name).join(" | "));

        //---------------------------------------------------
        // 2b. pick up an unfinished run on the same list
        //     Only when the columns still match: a row read under a different "Choose columns"
        //     selection would line up under the wrong headers.
        //---------------------------------------------------

        const saved=await checkpoint.load();

        if(saved&&Array.isArray(saved.rows)&&saved.rows.length
            &&Array.isArray(saved.headers)
            &&saved.headers.map(c=>c.name).join("|")===headers.map(c=>c.name).join("|")){

            // the slugs travel beside the rows rather than inside them: an extra key in the row
            // object would be appended as an extra column in the exported sheet
            saved.rows.forEach((row,index)=>{

                const slug=(saved.slugs||[])[index];

                if(!row||!slug||visited.has(slug)) return;

                visited.add(slug);
                rows.push(row);
                slugs.push(slug);
                resumed++;

            });

            report(`Resumed ${resumed} compan${resumed===1?"y":"ies"} from an unfinished run on this list.`);

        }

        //---------------------------------------------------
        // 3. read the current page fully BEFORE moving to the next one,
        //    repeating until there is no Next button left
        //---------------------------------------------------

        const total=readTotal(document);

        if(total) console.log(LOG,`${total} companies match the current filters`);

        const paging=await crawlAllPages(maxPages,pace);

        console.log(LOG,`${paging.pages} page(s) read -> ${rows.length} companies`
            +(paging.stoppedEarly?" (stopped early)":""));

        if(rows.length===0){

            alert("The table has no company rows. Check the filters on the page and run again.");
            return;

        }

        if(total&&rows.length<total){
            console.warn(LOG,`only ${rows.length} of the ${total} companies Latka reports were read`);
        }

        //---------------------------------------------------
        // 4. export to excel + trigger the download
        //---------------------------------------------------

        finish({total,paging,crashed:null});

    }
    catch(e){

        console.error(LOG,"crawl aborted:",e);

        // Everything collected up to the crash is real data. Throwing it away because the last
        // step failed is the single most expensive thing this crawler used to do.
        salvage(e);

    }
    finally{

        window.__latkaCrawlerRunning=false;

    }

    //---------------------------------------------------
    // helper: write the file
    //---------------------------------------------------

    function finish(state){

        // the crash path calls this too, and an exception raised INSIDE it would come back round
        // and download a second copy of the same file
        if(fileWritten) return;

        fileWritten=true;

        const HEADERS=headers.map(column=>column.name);

        const written=core.exportXlsx(rows,{
            headers:HEADERS,
            widths:HEADERS.map(columnWidth),
            filename:"getlatka_companies.xlsx",
            log:LOG
        });

        const locked=countLocked();
        const elapsed=Math.round((performance.now()-startedAt)/1000);

        const paging=state.paging||{pages:0,failed:0,recovered:0,reason:"end"};

        const problems=[
            rewound?`Rewound to page 1: the tab was on page ${rewound+1}, so pages 1-${rewound} `
                +"would otherwise have been skipped entirely.":"",
            paging.recovered?`${paging.recovered} page(s) were recovered on the second pass.`:"",
            paging.failed?`${paging.failed} page(s) could not be read at all - those companies are missing.`:"",
            paging.reason==="blocked"
                ? "Latka stopped serving pages part way through - this is a rate limit, not the end "
                    +"of the list. Wait a few minutes and run again."
                :"",
            paging.reason==="limit"?"Stopped at the max pages limit - there are more companies.":"",
            written.clipped?`${written.clipped} cell(s) truncated to fit Excel's 32,767 character limit.`:""
        ].filter(Boolean);

        const summary=`Done in ${elapsed}s: ${rows.length} companies`
            +(state.total?` of the ${state.total} Latka reports`
                +(rows.length<state.total?` - ${state.total-rows.length} NOT READ`:" - complete"):"")
            +` over ${paging.pages} page(s), ${HEADERS.length} columns`
            +(locked?`, ${locked} locked cell(s) need a Latka subscription`:"")
            +"."
            +(resumed?`\nResumed ${resumed} compan${resumed===1?"y":"ies"} from an earlier unfinished run.`:"")
            +(problems.length?"\n\n"+problems.join("\n"):"")
            +(fetcher.describe()?`\nRequests: ${fetcher.describe()}`:"")
            +(state.crashed?`\n\nThe run stopped early: ${state.crashed}.`
                +"\nEverything collected before that point is in the file above.":"");

        report(summary);

        // the run reached the file, so there is nothing left to resume
        if(!state.crashed) checkpoint.clear();

        // let the download start before the alert blocks the page
        setTimeout(()=>alert(summary+"\nSaved as getlatka_companies.xlsx"),0);

    }

    // build the file out of whatever survived the crash
    function salvage(error){

        try{

            if(rows.length===0||headers.length===0){
                alert("Crawl failed before anything was collected: "+(error&&error.message||error));
                return;
            }

            finish({total:0,paging:null,crashed:(error&&error.message||String(error))});

        }
        catch(e){

            console.error(LOG,"could not salvage the run either:",e);

            alert("Crawl failed: "+(error&&error.message||error)+"\nOpen DevTools console for details.");

        }

    }

    //---------------------------------------------------
    // helper: read the whole table of the current page BEFORE moving on
    // The Next button is a real <a>: clicking it reloads the page and kills the content
    // script, so the crawler follows its href with fetch instead.
    // Stops when: there is no Next, the next page has no rows, the Next link points back
    // to a page already read, or the max pages limit is reached.
    //---------------------------------------------------

    async function crawlAllPages(maxPages,pace){

        const limit=maxPages?Math.min(maxPages,HARD_PAGE_CAP):HARD_PAGE_CAP;

        // the open page is already rendered and costs no request, so read it whatever happens
        const first=collectFrom(document);

        report(`Open page: +${first.added} compan${first.added===1?"y":"ies"}, ${rows.length} total`);

        const here=core.paramOf(location.href,"page",ORIGIN)||1;

        // The Next chain only ever goes FORWARD, so starting wherever the tab happens to sit
        // silently drops every earlier page. Rewind to page 1 instead; rows already in `visited`
        // are deduped on arrival, so the only cost is the requests, not the data.
        const start=here>1?pageUrl(1):nextUrl(document);

        rewound=here>1?here-1:0;

        if(rewound) report(`Tab was on page ${here} - rewinding to page 1 so pages 1-${rewound} are not lost...`);

        const walk=await core.walkPages({

            first:start,

            fetchDoc:(url,opts)=>fetchDoc(url,Object.assign({pace},opts||{})),

            onDoc:async (doc,url,page)=>{

                const found=collectFrom(doc);

                report(`Page ${page}: +${found.added} compan${found.added===1?"y":"ies"}, ${rows.length} total`);

                await checkpoint.save({rows,slugs,headers});

                if(readRows(doc).length===0){
                    console.warn(LOG,"a page has no rows - end of the list or a login wall");
                    return "stop";
                }

                return "";

            },

            nextOf:doc=>nextUrl(doc),

            // The next URL normally comes out of the page we just failed to read, so without this
            // a single bad request ended the walk and threw away every page behind it. Latka
            // paginates on a plain ?page= counter, so the page after a missing one is knowable.
            guessNext:url=>cleanUrl(core.bumpParam(url,"page",1,ORIGIN)),

            maxPages:limit,
            report,
            log:LOG

        });

        await checkpoint.save({rows,slugs,headers},true);

        return {
            pages:walk.pages+1,
            failed:walk.skipped,
            recovered:walk.recovered,
            reason:walk.reason,
            stoppedEarly:walk.reason!=="end"
        };

    }

    // the same list, on a given page number
    function pageUrl(page){

        const url=new URL(location.href);

        url.searchParams.set("page",String(page));

        return cleanUrl(url.toString());

    }

    //---------------------------------------------------
    // helper: the table header
    // The last <th> only holds the "Choose columns" button, so it has no text -> drop it.
    // Keep the index so cells still line up even when an empty <th> sits in the middle.
    //---------------------------------------------------

    function readHeaders(doc){

        const table=doc.querySelector(TABLE);

        if(!table) return [];

        const out=[];

        table.querySelectorAll("thead th").forEach((th,index)=>{

            const name=norm(th);

            if(name) out.push({name,index});

        });

        return out;

    }

    function readRows(doc){

        const table=doc.querySelector(TABLE);

        if(!table) return [];

        // only accept rows with a company profile link, dropping "no results" or ad rows
        return [...table.querySelectorAll(ROW)].filter(row=>companyLink(row));

    }

    // the company name link is in the first cell; the Location column also points at
    // /companies/countries/..., so it has to be filtered out
    function companyLink(row){

        for(const link of row.querySelectorAll('a[href^="/companies/"]')){

            const href=link.getAttribute("href")||"";

            if(COMPANY_HREF.test(href.split("?")[0])) return link;

        }

        return null;

    }

    //---------------------------------------------------
    // helper: collect the rows of one page
    //---------------------------------------------------

    function collectFrom(doc){

        const found=readRows(doc);

        let added=0;

        for(const row of found){

            const slug=companyLink(row).getAttribute("href").split("?")[0];

            if(visited.has(slug)) continue;

            visited.add(slug);

            rows.push(readRow(row));
            slugs.push(slug);

            added++;

        }

        return {rows:found.length,added};

    }

    function readRow(row){

        const cells=[...row.children];

        const out={};

        for(const column of headers) out[column.name]=cellText(cells[column.index]);

        return out;

    }

    // "Locked" is kept as is (it is real information: a paid plan is required to see the value),
    // while "-" means an empty cell and becomes blank to keep the file clean.
    function cellText(cell){

        const text=norm(cell);

        return text===EMPTY_CELL?"":text;

    }

    function countLocked(){

        let count=0;

        for(const row of rows){
            for(const key of Object.keys(row)) if(row[key]==="Locked") count++;
        }

        return count;

    }

    //---------------------------------------------------
    // helper: URL of the next page
    //---------------------------------------------------

    function nextUrl(doc){

        let link=doc.querySelector(NEXT);

        if(!link){

            // fallback when rel="next" is missing: look for the word "Next" inside the pagination block
            for(const candidate of doc.querySelectorAll(NEXT_FALLBACK)){

                if(/^next\b/i.test(norm(candidate))){
                    link=candidate;
                    break;
                }

            }

        }

        const href=link&&link.getAttribute("href");

        return href?cleanUrl(new URL(href,ORIGIN).toString()):"";

    }

    // strip #hash so two URLs differing only by anchor are not treated as two pages
    function cleanUrl(href){

        const url=new URL(href,ORIGIN);

        return url.origin+url.pathname+url.search;

    }

    //---------------------------------------------------
    // helper: the total company count the page declares
    //---------------------------------------------------

    function readTotal(doc){

        const text=norm(doc.body);

        const match=text.match(TOTAL_MATCH)||text.match(TOTAL_OF);

        return match?+match[1].replace(/,/g,""):0;

    }

    function columnWidth(name){

        if(/^name$/i.test(name)) return 28;
        if(/website|founder|location/i.test(name)) return 24;
        if(/updated/i.test(name)) return 18;

        return 16;

    }

})();
