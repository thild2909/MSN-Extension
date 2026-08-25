(async()=>{

    const LOG="[apollo-crawler]";

    //---------------------------------------------------
    // guard against double runs when the button is clicked repeatedly
    //---------------------------------------------------

    if(window.__apolloCrawlerRunning){
        alert("Crawler is already running on this tab. Wait for it to finish.");
        return;
    }

    window.__apolloCrawlerRunning=true;

    const core=window.CrawlerCore;

    if(!core){
        alert("core.js is not loaded in this tab. popup.js must inject core.js before content.js.");
        window.__apolloCrawlerRunning=false;
        return;
    }

    //---------------------------------------------------
    // bridge to the page-world interceptor (inject.js)
    //
    // inject.js runs in the PAGE world and holds the captured search request; this script runs in
    // the ISOLATED world and cannot read that world's variables, so the two talk over postMessage.
    // Every message carries the namespace and a direction so the page's own postMessage traffic -
    // Apollo uses plenty - is never mistaken for a reply.
    //---------------------------------------------------

    const NS="apolloCrawler";

    let msgSeq=0;

    function sendToPage(cmd,extra,timeoutMs){

        return new Promise(resolve=>{

            const id=NS+":"+(++msgSeq);

            let done=false;

            function onMsg(ev){

                const d=ev&&ev.data;

                if(!d||d.__ns!==NS||d.dir!=="page->cs"||d.id!==id) return;

                if(done) return;

                done=true;

                try{ window.removeEventListener("message",onMsg); }catch(e){}

                resolve(d);

            }

            try{ window.addEventListener("message",onMsg); }catch(e){}

            try{
                if(typeof window.postMessage==="function"){
                    window.postMessage(Object.assign({__ns:NS,dir:"cs->page",id:id,cmd:cmd},extra||{}),"*");
                }
            }
            catch(e){}

            setTimeout(()=>{

                if(done) return;

                done=true;

                try{ window.removeEventListener("message",onMsg); }catch(e){}

                resolve(null);

            },timeoutMs||10000);

        });

    }

    const report=core.makeReporter("apollo-crawler-status",LOG);

    //---------------------------------------------------
    // mapping helpers - one Apollo person record -> one CSV row
    //---------------------------------------------------

    function str(v){
        return v===null||v===undefined?"":String(v);
    }

    function joinArr(v){

        if(Array.isArray(v)) return v.filter(x=>x!==null&&x!==undefined&&x!=="").join(", ");

        return str(v);

    }

    // A masked value is one the account has not paid to reveal; "email_not_unlocked@domain.com" and
    // any string with a "*" in it are placeholders, not data. The user asked never to spend credits,
    // so a locked field is left blank rather than filled with a placeholder that reads like a real one.
    function looksMasked(v){

        if(!v) return true;

        const s=String(v);

        return /not_unlocked|email_not_unlocked|\*/i.test(s);

    }

    // Real email, from the contact record first (a saved contact may already carry it) then the
    // person. Never a placeholder.
    function realEmail(p){

        const candidates=[
            p&&p.contact&&p.contact.email,
            p&&p.email
        ];

        for(const c of candidates){
            if(c&&String(c).indexOf("@")>=0&&!looksMasked(c)) return String(c);
        }

        return "";

    }

    // A mobile number, preferred over other line types, from whichever record carries one. Locked
    // numbers come back null or masked and are skipped.
    function mobile(p){

        const lists=[
            p&&p.contact&&p.contact.phone_numbers,
            p&&p.phone_numbers
        ];

        let fallback="";

        for(const list of lists){

            if(!Array.isArray(list)) continue;

            for(const num of list){

                if(!num) continue;

                const value=num.sanitized_number||num.raw_number||"";

                if(!value||looksMasked(value)) continue;

                const type=String(num.type_cd||num.type||"").toLowerCase();

                if(type.indexOf("mobile")>=0) return value;

                if(!fallback) fallback=value;

            }

        }

        return fallback;

    }

    function companyPhone(org){

        if(!org) return "";

        if(org.phone&&!looksMasked(org.phone)) return String(org.phone);

        if(org.sanitized_phone&&!looksMasked(org.sanitized_phone)) return String(org.sanitized_phone);

        if(org.primary_phone&&org.primary_phone.number&&!looksMasked(org.primary_phone.number)){
            return String(org.primary_phone.number);
        }

        return "";

    }

    function technologies(org){

        if(!org) return "";

        if(Array.isArray(org.technology_names)&&org.technology_names.length) return joinArr(org.technology_names);

        if(Array.isArray(org.current_technologies)){
            return org.current_technologies.map(t=>t&&(t.name||t)).filter(Boolean).join(", ");
        }

        return "";

    }

    function catchall(p){

        const v=p&&p.email_domain_catchall;

        return typeof v==="boolean"?String(v):"";

    }

    function buildRow(p){

        // net-new people carry `organization`; a saved contact's company may sit under `account`
        const org=(p&&(p.organization||p.account))||{};

        return {
            "First Name":str(p.first_name),
            "Last Name":str(p.last_name),
            "Company Name":str(org.name),
            "Company Website":str(org.website_url),
            "Email":realEmail(p),
            "Mobile Number":mobile(p),
            "Full Name":str(p.name),
            "LinkedIn":str(p.linkedin_url),
            "Title":str(p.title),
            "Industry":str(org.industry),
            "Headline":str(p.headline),
            "Seniority":str(p.seniority),
            "Department":joinArr(p.departments),
            "City":str(p.city),
            "State":str(p.state),
            "Country":str(p.country),
            "Employees Count":str(org.estimated_num_employees),
            "Keywords":joinArr(org.keywords),
            "Company Annual Revenue Clean":str(org.annual_revenue),
            "Company Annual Revenue":str(org.annual_revenue_printed),
            "Company SEO Description":str(org.seo_description),
            "Company Short Description":str(org.short_description),
            "Company Linkedin":str(org.linkedin_url),
            "Company Linkedin UID":str(org.linkedin_uid),
            "Company Total Funding Clean":str(org.total_funding),
            "Company Total Funding":str(org.total_funding_printed),
            "Company Technologies":technologies(org),
            "Email Domain Catchall":catchall(p),
            "Person Photo":str(p.photo_url),
            "Twitter URL":str(p.twitter_url),
            "Facebook URL":str(p.facebook_url),
            "Person ID":str(p.id),
            "Company ID":str(org.id),
            "Company Phone Number":companyPhone(org),
            "Company Logo":str(org.logo_url),
            "Company Twitter":str(org.twitter_url),
            "Company Facebook":str(org.facebook_url),
            "Company Market Cap":str(org.market_cap),
            "Company Founded Year":str(org.founded_year),
            "Company Domain":str(org.primary_domain),
            "Company Raw Address":str(org.raw_address),
            "Company Street Address":str(org.street_address),
            "Company City":str(org.city),
            "Company State":str(org.state),
            "Company Country":str(org.country),
            "Company Postal Code":str(org.postal_code)
        };

    }

    // the column order the file must have, kept fixed so a page where every company happens to
    // carry no funding does not drop the column for the whole run
    const HEADERS=["First Name","Last Name","Company Name","Company Website","Email","Mobile Number",
        "Full Name","LinkedIn","Title","Industry","Headline","Seniority","Department","City","State",
        "Country","Employees Count","Keywords","Company Annual Revenue Clean","Company Annual Revenue",
        "Company SEO Description","Company Short Description","Company Linkedin","Company Linkedin UID",
        "Company Total Funding Clean","Company Total Funding","Company Technologies",
        "Email Domain Catchall","Person Photo","Twitter URL","Facebook URL","Person ID","Company ID",
        "Company Phone Number","Company Logo","Company Twitter","Company Facebook","Company Market Cap",
        "Company Founded Year","Company Domain","Company Raw Address","Company Street Address",
        "Company City","Company State","Company Country","Company Postal Code"];

    // pull the record array out of a list response - net-new under `people`, saved under `contacts`
    function recordsOf(json){

        const out=[];

        if(json&&Array.isArray(json.people)) for(const p of json.people) out.push(p);

        if(json&&Array.isArray(json.contacts)) for(const c of json.contacts) out.push(c);

        return out;

    }

    //---------------------------------------------------
    // state - declared before the try so the summary/salvage below can read it
    //---------------------------------------------------

    const rows=[];

    const stats={
        pagesOk:0,
        pagesFailed:0,
        withEmail:0,
        withMobile:0
    };

    const startedAt=performance.now();

    // checkpoint so a tab navigation mid-run is resumable rather than lost
    const checkpoint=core.makeCheckpoint("apolloCheckpoint",{log:LOG});

    let fileWritten=false;
    let resumed=0;
    let totalEntries=0;
    let totalPages=0;
    let crashed="";

    // Every record is kept, no matter what - no dedupe, nothing skipped. The user wants the full
    // set, so a person that appears more than once is written more than once.
    function pushRecord(p){

        const row=buildRow(p);
        rows.push(row);
        if(row.Email) stats.withEmail++;
        if(row["Mobile Number"]) stats.withMobile++;

    }

    try{

        //---------------------------------------------------
        // 1. settings
        //---------------------------------------------------

        const settings=await chrome.storage.local.get(["maxPages","perPage","concurrency"]);

        const maxPages=Math.max(0,parseInt(settings.maxPages,10)||0);            // 0 = all
        // Fewer round-trips by asking for more records/request - BUT Apollo's mixed_people/search
        // validates per_page and rejects an over-large value with 422 (it does NOT silently clamp).
        // So the default is a value Apollo accepts (25), and if even that is refused with 422 the
        // walk drops the per_page override entirely and replays the captured request verbatim.
        let perPage=Math.min(100,Math.max(0,parseInt(settings.perPage,10)||0));
        if(!perPage) perPage=25;
        // set to 0 mid-walk if Apollo 422s the override; 0 means "keep the captured per_page"
        let effPerPage=perPage;
        // how many page requests are in flight at once - the real speed lever
        const concurrency=Math.min(8,Math.max(1,parseInt(settings.concurrency,10)||5));

        if(!/app\.apollo\.io$/.test(location.hostname)){
            console.warn(LOG,"this is not app.apollo.io - trying to talk to the interceptor anyway");
        }

        //---------------------------------------------------
        // 2. make sure the interceptor is present and has captured the search
        //---------------------------------------------------

        report("Looking for the Apollo search request...");

        const probe=await sendToPage("probe",null,4000);

        if(!probe){

            alert("Apollo Crawler could not reach its page helper.\n\n"
                +"This almost always means the tab was open before the extension was installed or "
                +"updated. Reload this Apollo tab (F5), then run the crawler again.");

            window.__apolloCrawlerRunning=false;

            return;

        }

        if(!probe.ready){

            alert("No Apollo search request has been captured on this tab yet.\n\n"
                +"Open your People search (the list of people), let it load, then run the crawler. "
                +"If the list is already showing, reload the page once so the request is seen.");

            window.__apolloCrawlerRunning=false;

            return;

        }

        console.log(LOG,"interceptor ready, endpoint:",probe.endpoint);

        if(probe.pagination){
            totalEntries=probe.pagination.total_entries||0;
            totalPages=probe.pagination.total_pages||0;
        }

        //---------------------------------------------------
        // 3. resume an unfinished run of the SAME search
        //---------------------------------------------------

        let startPage=1;

        const saved=await checkpoint.load();

        if(saved&&Array.isArray(saved.rows)&&saved.rows.length){

            for(const row of saved.rows){

                rows.push(row);

                if(row.Email) stats.withEmail++;

                if(row["Mobile Number"]) stats.withMobile++;

            }

            resumed=rows.length;
            startPage=Math.max(1,(saved.nextPage||1));

            if(saved.totalPages) totalPages=saved.totalPages;
            if(saved.totalEntries) totalEntries=saved.totalEntries;

            console.log(LOG,`resumed ${resumed} row(s) from an unfinished run, continuing at page ${startPage}`);

        }

        //---------------------------------------------------
        // 4. walk the pages by replaying the captured request - in parallel
        //
        // Speed comes from three things: 100 records per request instead of 25, a window of
        // `concurrency` page requests in flight at once (core.pipelinePages, which consumes them in
        // page order so the file is still deterministic), and no fixed delay - full speed until
        // Apollo pushes back, then a shared backoff every worker respects.
        //
        // Nothing is deduped - every record on every page is kept. The walk terminates on the page
        // count derived from page 1 and on an empty page, so a search whose tail repeats stops at
        // total_pages rather than looping.
        //---------------------------------------------------

        const failedPages=[];

        // shared across all workers: a 429/403 from any page parks every page until this time
        let pauseUntil=0;
        let backoff=0;

        // one page, with retries and a shared adaptive backoff; returns the JSON or null
        async function replayOne(pg){

            for(let attempt=0;attempt<5;attempt++){

                const wait=pauseUntil-Date.now();

                if(wait>0) await core.sleep(wait);

                const res=await sendToPage("replay",{page:pg,perPage:effPerPage},30000);

                if(res&&res.ok&&res.json) return res.json;

                const status=res?res.status:0;

                // 422 = Apollo rejected the body. The only field we change is per_page, so an
                // over-large per_page is the cause: drop the override (replay the captured request
                // verbatim) and retry this page. Only give up if it 422s even without the override.
                if(status===422){
                    console.warn(LOG,`page ${pg} refused (422): ${res.text||"no body"}`);
                    if(effPerPage){
                        console.warn(LOG,`dropping per_page override (was ${effPerPage}) and retrying with the captured page size`);
                        effPerPage=0;
                        continue;
                    }
                    return null;
                }

                // rate limit / transient / dropped reply -> back off everyone, then retry this page
                if(status===429||status===403||status===500||status===502||status===503||!res){
                    backoff=Math.min(15000,Math.max(1200,backoff*1.7||1200));
                    pauseUntil=Date.now()+backoff;
                    console.warn(LOG,`page ${pg} refused (${status||"no reply"}) - pausing ${Math.round(backoff)}ms`);
                    await core.sleep(backoff);
                    continue;
                }

                // a hard 4xx that will not fix itself
                if(res&&res.text) console.warn(LOG,`page ${pg} refused (${status}): ${res.text}`);
                return null;

            }

            return null;

        }

        // page 1 (or the resume point) first, alone, to learn the real page size and page count
        report("Reading page 1...");

        const first=await replayOne(startPage);

        if(!first){

            crashed=startPage===1
                ? "the first page could not be read - the session may have expired; reload Apollo and sign in again"
                : "could not resume the run - re-run the crawler on a fresh page";

        }
        else{

            const firstRecords=recordsOf(first);

            for(const p of firstRecords) pushRecord(p);

            stats.pagesOk++;

            if(first.pagination&&first.pagination.total_entries){
                totalEntries=first.pagination.total_entries;
            }

            // The real page size is what page 1 actually returned - if Apollo ignored our per_page
            // and served 25, effPer is 25 and the ceiling matches, so no page is skipped. Paging by
            // page number is correct whichever size Apollo used.
            const effPer=firstRecords.length||perPage||25;

            totalPages=totalEntries
                ? Math.ceil(totalEntries/effPer)
                : (first.pagination&&first.pagination.total_pages||1);

            const ceiling=maxPages?Math.min(maxPages,totalPages):totalPages;

            const pages=[];

            for(let pg=startPage+1;pg<=ceiling;pg++) pages.push(pg);

            if(pages.length){

                report(`Reading ${pages.length} more page(s), ${concurrency} at a time...`);

                const walk=await core.pipelinePages(pages,replayOne,async(pg,json)=>{

                    // a page that never came back is recorded by pipelinePages and retried below
                    if(!json) return;

                    const records=recordsOf(json);

                    // a genuinely empty page is the end of the list
                    if(!records.length) return "stop";

                    for(const p of records) pushRecord(p);

                    stats.pagesOk++;

                    report(`Page ${pg} / ${ceiling} - ${rows.length} contact(s)`);

                    await checkpoint.save({rows,nextPage:pg+1,totalPages,totalEntries});

                    return;

                },{limit:concurrency,log:LOG});

                for(const pg of walk.missed) failedPages.push(pg);

            }

        }

        //---------------------------------------------------
        // 5. one retry pass over any page that failed mid-walk
        //---------------------------------------------------

        if(failedPages.length){

            report(`Retrying ${failedPages.length} page(s) that failed...`);

            const stillFailed=[];

            for(const pg of failedPages){

                const json=await replayOne(pg);

                if(json){

                    const records=recordsOf(json);

                    for(const rec of records) pushRecord(rec);

                    stats.pagesOk++;

                }
                else{
                    stillFailed.push(pg);
                    stats.pagesFailed++;
                }

            }

            failedPages.length=0;

            for(const pg of stillFailed) failedPages.push(pg);

        }

        //---------------------------------------------------
        // 6. write the file
        //---------------------------------------------------

        finish({failedPages,crashed:""});

    }
    catch(error){

        console.error(LOG,"crashed:",error);

        crashed=error&&error.message||String(error);

        salvage(error);

    }
    finally{

        window.__apolloCrawlerRunning=false;

    }

    //---------------------------------------------------
    // helpers hoisted and called from inside the try
    //---------------------------------------------------

    function finish(info){

        if(fileWritten) return;

        fileWritten=true;

        const failedPages=(info&&info.failedPages)||[];
        const crashedNote=(info&&info.crashed)||crashed||"";

        if(!rows.length){
            alert("No contacts were exported. The search returned nothing, or the request could not be replayed.");
            return;
        }

        const written=core.exportCsv(rows,{
            headers:HEADERS,
            filename:"apollo_people.csv",
            log:LOG
        });

        const elapsed=Math.round((performance.now()-startedAt)/1000);

        const summary=[
            `Done in ${elapsed}s. Saved as apollo_people.csv`,
            ``,
            `Contacts:  ${rows.length} exported`
                +(totalEntries?` of ${totalEntries} in the search`:"")
                +(resumed?`, ${resumed} resumed from an earlier unfinished run`:""),
            `Pages:     ${stats.pagesOk} read`
                +(totalPages?` of ${totalPages}`:"")
                +(stats.pagesFailed?`, ${stats.pagesFailed} still failing`:""),
            `Contact:   ${stats.withEmail} row(s) with an unlocked email, ${stats.withMobile} with a mobile`,
            `           (locked emails/phones are left blank on purpose - no credits were spent)`,
            failedPages.length?`Failed:    page(s) ${failedPages.join(", ")} could not be read`:"",
            written.clipped?`Truncated: ${written.clipped} cell(s) hit Excel's 32,767 character limit`:"",
            crashedNote?`\nThe run stopped early: ${crashedNote}.`
                +`\nEverything collected before that point is in the file above.`:""
        ].filter(line=>line!=="").join("\n");

        console.log(LOG,"\n"+summary);

        report(`Done: ${rows.length} contact(s) exported.`);

        if(!crashedNote) checkpoint.clear();

        setTimeout(()=>alert(summary),0);

    }

    function salvage(error){

        try{

            if(!rows.length){
                alert("Crawl failed before anything was collected: "+(error&&error.message||error));
                return;
            }

            finish({failedPages:[],crashed:(error&&error.message||String(error))});

        }
        catch(e){

            console.error(LOG,"could not salvage the run either:",e);

            alert("Crawl failed: "+(error&&error.message||error)+"\nOpen DevTools console (F12) for details.");

        }

    }

})();
