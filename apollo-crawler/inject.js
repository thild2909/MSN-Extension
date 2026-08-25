// Apollo Crawler - page-world interceptor + replayer
//
// This runs in the PAGE's own JavaScript world (manifest content_scripts world:"MAIN",
// run_at:"document_start"), which is the only place the app's real search request can be seen and
// replayed with the exact auth it was sent under.
//
// Why capture-and-replay instead of reading the table:
//   The People finder shows a masked table - "****@****.com", no revenue, no funding, no
//   technologies, no company address. Every field the CSV asks for lives in the JSON the app
//   already fetches from its own search endpoint (mixed_people/search). So rather than reconstruct
//   that request - dozens of camelCase->snake_case filter params, a CSRF token, whatever headers
//   the app adds - the interceptor records the request the app itself makes on page load, and the
//   content script replays that exact request for every page, changing only `page`.
//
// The content script (isolated world) cannot read this world's variables, so the two talk over
// window.postMessage. This file only ever RESPONDS - it never fetches on its own, never touches the
// page, and is wrapped so a failure here can never break Apollo.

(function(){

    "use strict";

    if(window.__apolloCrawlerInjected) return;
    window.__apolloCrawlerInjected=true;

    const NS="apolloCrawler";

    // the untouched fetch, kept before patching so a replay never re-enters the capture path
    const origFetch=window.fetch ? window.fetch.bind(window) : null;

    // the last request that looked like the people list: {url, method, headers:[[k,v]], body}
    let template=null;

    // the pagination block of the last captured list response - {page, per_page, total_entries,
    // total_pages} - handed to the content script so it can size the walk before the first replay
    let lastPagination=null;

    // headers a page cannot set on a fetch (the browser fills them itself); replaying them is at
    // best a no-op and at worst a thrown error, so they are dropped from the captured template
    const FORBIDDEN=new Set([
        "host","connection","content-length","cookie","accept-encoding",
        "user-agent","origin","referer","sec-fetch-mode","sec-fetch-site",
        "sec-fetch-dest","sec-ch-ua","sec-ch-ua-mobile","sec-ch-ua-platform"
    ]);

    // Only responses from a URL that looks like a search endpoint are parsed - parsing every
    // response the app makes would be wasteful and pointless.
    function looksLikeSearch(url){
        return typeof url==="string" && /search/i.test(url) && /apollo\.io/i.test(url);
    }

    // A list response is the one that carries BOTH a pagination block and an array of records.
    // Matching on shape rather than on an exact path means an endpoint rename (mixed_people ->
    // something else) does not silently empty the run.
    function isListPayload(json){
        return !!(json && json.pagination
            && (Array.isArray(json.people) || Array.isArray(json.contacts)));
    }

    function headerEntries(headers){

        const out=[];

        if(!headers) return out;

        try{

            if(typeof Headers!=="undefined" && headers instanceof Headers){
                headers.forEach((v,k)=>out.push([k,v]));
            }
            else if(Array.isArray(headers)){
                for(const pair of headers) if(pair&&pair.length===2) out.push([pair[0],pair[1]]);
            }
            else if(typeof headers==="object"){
                for(const k of Object.keys(headers)) out.push([k,headers[k]]);
            }

        }
        catch(e){}

        return out.filter(pair=>!FORBIDDEN.has(String(pair[0]).toLowerCase()));

    }

    function remember(url,method,headers,body){

        // Apollo sends the filters as a JSON string body; a Request-object body cannot be read here
        // synchronously, but the app uses the init form, so a non-string body simply is not stored.
        if(typeof body!=="string" || !body) return;

        template={
            url:url,
            method:(method||"POST").toUpperCase(),
            headers:headerEntries(headers),
            body:body
        };

    }

    //---------------------------------------------------
    // patch fetch - capture only, replay uses origFetch
    //---------------------------------------------------

    if(origFetch){

        window.fetch=function(input,init){

            let url,method,headers,body;

            try{

                if(typeof input==="string"){
                    url=input;
                }
                else if(input&&typeof input==="object"){
                    url=input.url;
                    method=input.method;
                    headers=input.headers;
                }

                if(init){
                    if(init.method) method=init.method;
                    if(init.headers) headers=init.headers;
                    if(typeof init.body==="string") body=init.body;
                }

            }
            catch(e){}

            const promise=origFetch(input,init);

            // inspect the response without consuming the app's copy of it
            if(looksLikeSearch(url)){

                promise.then(res=>{

                    try{

                        res.clone().json().then(json=>{

                            if(isListPayload(json)){
                                remember(url,method,headers,body);
                                lastPagination=json.pagination||lastPagination;
                            }

                        }).catch(()=>{});

                    }
                    catch(e){}

                    return res;

                }).catch(()=>{});

            }

            return promise;

        };

    }

    //---------------------------------------------------
    // patch XMLHttpRequest - some paths still use it
    //---------------------------------------------------

    (function(){

        const XHR=window.XMLHttpRequest;

        if(!XHR||!XHR.prototype) return;

        const open=XHR.prototype.open;
        const send=XHR.prototype.send;
        const setHeader=XHR.prototype.setRequestHeader;

        XHR.prototype.open=function(method,url){
            this.__ac={method:method,url:url,headers:[]};
            return open.apply(this,arguments);
        };

        XHR.prototype.setRequestHeader=function(k,v){
            if(this.__ac) this.__ac.headers.push([k,v]);
            return setHeader.apply(this,arguments);
        };

        XHR.prototype.send=function(body){

            const meta=this.__ac;

            if(meta&&looksLikeSearch(meta.url)){

                this.addEventListener("load",function(){

                    try{

                        const json=JSON.parse(this.responseText);

                        if(isListPayload(json)){
                            remember(meta.url,meta.method,meta.headers,typeof body==="string"?body:null);
                            lastPagination=json.pagination||lastPagination;
                        }

                    }
                    catch(e){}

                });

            }

            return send.apply(this,arguments);

        };

    })();

    //---------------------------------------------------
    // replay one page with the captured request, verbatim but for `page`
    //---------------------------------------------------

    async function replay(page,perPage){

        if(!template) return {ok:false,error:"no-template"};
        if(!origFetch) return {ok:false,error:"no-fetch"};

        let bodyObj;

        try{
            bodyObj=JSON.parse(template.body||"{}");
        }
        catch(e){
            return {ok:false,error:"bad-body"};
        }

        if(page) bodyObj.page=page;
        if(perPage) bodyObj.per_page=perPage;

        const headers=new Headers();

        for(const pair of template.headers){
            try{ headers.set(pair[0],pair[1]); }catch(e){}
        }

        try{ headers.set("content-type","application/json"); }catch(e){}

        let res;

        try{

            res=await origFetch(template.url,{
                method:template.method||"POST",
                headers:headers,
                body:JSON.stringify(bodyObj),
                credentials:"include"
            });

        }
        catch(e){
            return {ok:false,error:"network",message:String(e&&e.message||e)};
        }

        let json=null;
        let text="";

        try{
            text=await res.text();
            json=JSON.parse(text);
        }
        catch(e){
            json=null;
        }

        return {
            ok:res.ok,
            status:res.status,
            json:json,
            text:json?"":text.slice(0,300)
        };

    }

    //---------------------------------------------------
    // the bridge to the content script (isolated world)
    //---------------------------------------------------

    window.addEventListener("message",function(event){

        if(event.source!==window) return;

        const data=event.data;

        if(!data || data.__ns!==NS || data.dir!=="cs->page") return;

        const id=data.id;

        function reply(payload){
            window.postMessage(Object.assign({__ns:NS,dir:"page->cs",id:id},payload),"*");
        }

        if(data.cmd==="probe"){

            reply({
                ready:!!template,
                pagination:lastPagination||null,
                endpoint:template?template.url:null
            });

            return;

        }

        if(data.cmd==="replay"){

            replay(data.page,data.perPage).then(reply).catch(err=>{
                reply({ok:false,error:"replay-threw",message:String(err&&err.message||err)});
            });

            return;

        }

    });

})();
