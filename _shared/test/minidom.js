// A real, if small, HTML parser and CSS selector engine, shared by the fixtures that drive a
// crawler against a site's OWN markup.
//
// The stub DOM in smoke.js answers whatever it is asked, which is enough to test control flow but
// cannot test a single selector - and on a site that hashes its class names per build (Reed) or
// styles everything with utility classes and identifies elements only by data-testid, role and
// aria-* (Dice), the selectors ARE the risk. A wrong one there does not crash a run: it writes a
// file with an empty column.
//
// Plain Node, no dependencies. Only the selector forms the crawlers actually use are supported:
//   tag  .class  [attr]  [attr="v"]  [attr*="v" i]  [attr~="v"]  descendant  a, b


const VOID=new Set(["area","base","br","col","embed","hr","img","input","link","meta","param",
    "source","track","wbr"]);

class Node{

    constructor(tag,attrs){

        this.nodeType=tag?1:3;
        this.tagName=(tag||"").toUpperCase();
        this.attrs=attrs||{};
        this.childNodes=[];
        this.parentNode=null;
        this.nodeValue="";

    }

    get textContent(){

        if(this.nodeType===3) return this.nodeValue;

        return this.childNodes.map(child=>child.textContent).join("");

    }

    getAttribute(name){

        const value=this.attrs[name.toLowerCase()];

        return value===undefined?null:value;

    }

    setAttribute(name,value){
        this.attrs[name.toLowerCase()]=String(value);
    }

    contains(other){

        for(let node=other;node;node=node.parentNode){
            if(node===this) return true;
        }

        return false;

    }

    get children(){
        return this.childNodes.filter(child=>child.nodeType===1);
    }

    // every element below this one, in document order - which is what querySelectorAll promises
    descendants(out){

        out=out||[];

        for(const child of this.childNodes){

            if(child.nodeType!==1) continue;

            out.push(child);

            child.descendants(out);

        }

        return out;

    }

    querySelectorAll(selector){
        return matchAll(this,selector);
    }

    querySelector(selector){

        const found=matchAll(this,selector);

        return found.length?found[0]:null;

    }

    closest(selector){

        for(let node=this;node;node=node.parentNode){
            if(node.nodeType===1&&matchesCompound(node,parseSelector(selector)[0][0])) return node;
        }

        return null;

    }

    click(){}
    remove(){}
    appendChild(){}
    scrollIntoView(){}

    // exportXlsx builds an <a>, hides it and clicks it
    get style(){

        if(!this._style) this._style={};

        return this._style;

    }

}

const ATTR=/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(text){

    const attrs={};

    let match;

    ATTR.lastIndex=0;

    while((match=ATTR.exec(text))!==null){
        attrs[match[1].toLowerCase()]=match[2]!==undefined?match[2]
            :match[3]!==undefined?match[3]
            :match[4]!==undefined?match[4]:"";
    }

    return attrs;

}

function parse(html){

    const root=new Node("html-root",{});

    const stack=[root];

    let i=0;

    const push=node=>{

        node.parentNode=stack[stack.length-1];

        stack[stack.length-1].childNodes.push(node);

    };

    while(i<html.length){

        const lt=html.indexOf("<",i);

        if(lt<0){

            if(i<html.length) pushText(html.slice(i));

            break;

        }

        if(lt>i) pushText(html.slice(i,lt));

        // comments and doctypes carry nothing the crawler reads
        if(html.startsWith("<!--",lt)){

            const end=html.indexOf("-->",lt);

            i=end<0?html.length:end+3;

            continue;

        }

        if(html.startsWith("<!",lt)){

            const end=html.indexOf(">",lt);

            i=end<0?html.length:end+1;

            continue;

        }

        // the tag ends at the first ">" that is not inside a quoted attribute value
        let end=lt+1;
        let quote="";

        while(end<html.length){

            const ch=html[end];

            if(quote){
                if(ch===quote) quote="";
            }
            else if(ch==='"'||ch==="'"){
                quote=ch;
            }
            else if(ch===">"){
                break;
            }

            end++;

        }

        const raw=html.slice(lt+1,end);

        i=end+1;

        if(raw.startsWith("/")){

            const name=raw.slice(1).trim().toLowerCase();

            // close back to the matching open tag, so one stray </div> cannot unwind the document
            for(let depth=stack.length-1;depth>0;depth--){

                if(stack[depth].tagName===name.toUpperCase()){
                    stack.length=depth;
                    break;
                }

            }

            continue;

        }

        const space=raw.search(/[\s/]/);
        const name=(space<0?raw:raw.slice(0,space)).toLowerCase();
        const attrs=parseAttrs(space<0?"":raw.slice(space));

        const node=new Node(name,attrs);

        push(node);

        if(!VOID.has(name)&&!raw.trimEnd().endsWith("/")) stack.push(node);

    }

    function pushText(text){

        const node=new Node("",{});

        node.nodeValue=text;

        push(node);

    }

    return root;

}

//---------------------------------------------------
// the selector engine: only the forms content.js and core.js actually use
//   tag  .class  [attr]  [attr="v"]  [attr*="v" i]  [attr~="v"]  descendant  a, b
//---------------------------------------------------

const cache=new Map();

function parseSelector(selector){

    if(cache.has(selector)) return cache.get(selector);

    const groups=selector.split(",").map(part=>part.trim()).filter(Boolean).map(part=>

        part.split(/\s+(?![^\[]*\])/).map(step=>{

            const compound={tag:"",classes:[],attrs:[]};

            const rest=step.replace(/\[([^\]]*)\]/g,(all,body)=>{

                const match=/^([^~*^$|=\s]+)(?:\s*([~*^$|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?\s*(i)?$/.exec(body.trim());

                if(match){

                    compound.attrs.push({
                        name:match[1].toLowerCase(),
                        op:match[2]||"",
                        value:match[3]!==undefined?match[3]:match[4]!==undefined?match[4]:match[5]||"",
                        fold:!!match[6]
                    });

                }

                return "";

            });

            for(const cls of rest.split(".").slice(1)) if(cls) compound.classes.push(cls);

            const tag=rest.split(".")[0].replace(/^#.*$/,"");

            compound.tag=tag&&tag!=="*"?tag.toUpperCase():"";

            return compound;

        })

    );

    cache.set(selector,groups);

    return groups;

}

function matchesAttr(el,rule){

    let value=el.getAttribute(rule.name);

    if(value===null) return false;

    if(!rule.op) return true;

    let wanted=rule.value;

    if(rule.fold){
        value=value.toLowerCase();
        wanted=wanted.toLowerCase();
    }

    if(rule.op==="=") return value===wanted;
    if(rule.op==="*=") return value.includes(wanted);
    if(rule.op==="~=") return value.split(/\s+/).includes(wanted);
    if(rule.op==="^=") return value.startsWith(wanted);
    if(rule.op==="$=") return value.endsWith(wanted);

    return false;

}

function matchesCompound(el,compound){

    if(compound.tag&&el.tagName!==compound.tag) return false;

    const classes=(el.getAttribute("class")||"").split(/\s+/);

    for(const cls of compound.classes) if(!classes.includes(cls)) return false;

    for(const rule of compound.attrs) if(!matchesAttr(el,rule)) return false;

    return true;

}

// walk the ancestors to satisfy the steps in front of the last one
function matchesChain(el,steps,root){

    let node=el;

    for(let i=steps.length-1;i>=0;i--){

        if(i===steps.length-1){

            if(!matchesCompound(node,steps[i])) return false;

            continue;

        }

        node=node.parentNode;

        let found=false;

        while(node&&node!==root.parentNode){

            if(node.nodeType===1&&matchesCompound(node,steps[i])){
                found=true;
                break;
            }

            node=node.parentNode;

        }

        if(!found) return false;

    }

    return true;

}

function matchAll(root,selector){

    const groups=parseSelector(selector);

    const out=[];

    for(const el of root.descendants()){

        for(const steps of groups){

            if(matchesChain(el,steps,root)){
                out.push(el);
                break;
            }

        }

    }

    // Array already has forEach; the crawler only ever iterates and indexes
    return out;

}

function makeDocument(html,title){

    const root=parse(html);

    const doc=root;

    doc.body=root.querySelector("body")||root;
    doc.documentElement=root;
    doc.createElement=name=>new Node(name,{});
    doc.addEventListener=()=>{};
    doc.title=title||"";

    return doc;

}

module.exports={Node,parse,matchAll,makeDocument};
