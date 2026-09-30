import { createHash } from "node:crypto";

/**
 * The share page's own scripts. Both are static strings, allowed by their
 * SHA-256 in the CSP: nothing from the shared file can ever become a script.
 * The heavy renderers (mermaid, KaTeX, highlight.js) are loaded only when the
 * document needs them, from exact, version-pinned CDN paths with Subresource
 * Integrity, and the CSP allows those exact paths and nothing else.
 */

const CDN = "https://cdn.jsdelivr.net/npm";

export const SHARE_ASSETS = {
  mermaid: {
    src: `${CDN}/mermaid@11.17.2/dist/mermaid.min.js`,
    sri: "sha384-EOXBFmc3gx5mb+vn0vPvvGqACToJD24hhacX5Yx+8NUUQrHIle/Qi5Bg9o3zKwW2",
  },
  katex: {
    src: `${CDN}/katex@0.18.9/dist/katex.min.js`,
    sri: "sha384-19KE2cFb3U+RUWmyhBz7aLOGDG8WrRC6hE3oY/HTZZlAAVWYTdmvLC//+TIV3zUx",
  },
  katexCss: {
    src: `${CDN}/katex@0.18.9/dist/katex.min.css`,
    sri: "sha384-lPx0C4zIUZLpveABMwOFcFeGZwsvKBJfhJ85FN1PYOV7xApBcFMhcAEMVKF8loOI",
  },
  katexFonts: `${CDN}/katex@0.18.9/dist/fonts/`,
  highlight: {
    src: `${CDN}/@highlightjs/cdn-assets@11.12.0/highlight.min.js`,
    sri: "sha384-wjfDDhOPPdjtva8vWBhWeVprSpmxisEu5aYT3q1JyACqXpdKpo3PWZTMVq24MBix",
  },
} as const;

export const THEME_STORAGE_KEY = "agent-fs-share-theme";

/** In <head>: applies the saved theme before first paint, so there is no flash. */
export const THEME_INIT_SCRIPT = `(function(){var d=document.documentElement;d.classList.add("js");try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY
)});if(t==="light"||t==="dark")d.setAttribute("data-theme",t)}catch(e){}})();`;

/**
 * End of <body>: theme picker, copy buttons, TOC highlight, source view, image
 * zoom, and the lazy renderers. Globals are checked with `typeof` because an
 * element id in the document (a heading slug) can shadow a window property.
 */
export const PAGE_SCRIPT = `(function(){
"use strict";
var A=${JSON.stringify(SHARE_ASSETS)};
var KEY=${JSON.stringify(THEME_STORAGE_KEY)};
var d=document,root=d.documentElement;
var mq=window.matchMedia("(prefers-color-scheme: dark)");
function isDark(){var t=root.getAttribute("data-theme");return t?t==="dark":mq.matches}
function $$(sel,el){return Array.prototype.slice.call((el||d).querySelectorAll(sel))}
var onTheme=[];
function themeChanged(){onTheme.forEach(function(f){f()})}

var sel=d.querySelector(".theme-select");
if(sel){
  sel.value=root.getAttribute("data-theme")||"system";
  sel.addEventListener("change",function(){
    var v=sel.value;
    if(v==="light"||v==="dark")root.setAttribute("data-theme",v);else{root.removeAttribute("data-theme");v=null}
    try{v?localStorage.setItem(KEY,v):localStorage.removeItem(KEY)}catch(e){}
    themeChanged();
  });
}
if(mq.addEventListener)mq.addEventListener("change",function(){if(!root.getAttribute("data-theme"))themeChanged()});

var loaded={};
function load(a){
  if(!loaded[a.src])loaded[a.src]=new Promise(function(res,rej){
    var s=d.createElement("script");s.src=a.src;s.integrity=a.sri;s.crossOrigin="anonymous";
    s.onload=res;s.onerror=rej;d.head.appendChild(s);
  });
  return loaded[a.src];
}
function loadCss(a){
  var l=d.createElement("link");l.rel="stylesheet";l.href=a.src;l.integrity=a.sri;l.crossOrigin="anonymous";
  d.head.appendChild(l);
}

function copyText(text,btn){
  function done(ok){var old=btn.getAttribute("data-label")||btn.textContent;btn.setAttribute("data-label",old);btn.textContent=ok?"Copied":"Copy failed";setTimeout(function(){btn.textContent=old},1500)}
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(text).then(function(){done(true)},function(){done(false)});
  else done(false);
}

$$(".code-block").forEach(function(block){
  var code=block.querySelector("code");if(!code)return;
  var b=d.createElement("button");b.type="button";b.className="copy";b.textContent="Copy";
  b.addEventListener("click",function(){copyText(code.textContent,b)});
  block.appendChild(b);
});

var src=d.querySelector("pre.source"),doc=d.querySelector(".doc-body");
var toggle=d.querySelector(".source-toggle");
if(toggle&&src&&doc)toggle.addEventListener("click",function(){
  var showing=!src.hidden;src.hidden=showing;doc.hidden=!showing;
  toggle.textContent=showing?"View source":"View rendered";
  toggle.setAttribute("aria-pressed",String(!showing));
});
var copyMd=d.querySelector(".copy-md");
if(copyMd&&src)copyMd.addEventListener("click",function(){copyText(src.textContent,copyMd)});

$$(".toc-mobile a").forEach(function(a){a.addEventListener("click",function(){var det=a.closest("details");if(det)det.open=false})});
var links=$$(".toc a");
if(links.length&&"IntersectionObserver" in window){
  var byId={};links.forEach(function(a){byId[decodeURIComponent(a.getAttribute("href").slice(1))]=a});
  var visible={};
  var io=new IntersectionObserver(function(entries){
    entries.forEach(function(e){visible[e.target.id]=e.isIntersecting});
    var heads=$$(".doc-body [id]").filter(function(h){return byId[h.id]});
    var current=null;
    for(var i=0;i<heads.length;i++){if(visible[heads[i].id]){current=heads[i].id;break}}
    if(!current)return;
    links.forEach(function(a){a.classList.toggle("active",a===byId[current])});
  },{rootMargin:"-64px 0px -60% 0px"});
  Object.keys(byId).forEach(function(id){var h=d.getElementById(id);if(h)io.observe(h)});
}

$$("img.media").forEach(function(img){img.addEventListener("click",function(){img.classList.toggle("zoomed")})});

var codes=$$(".code-block code[class^='language-']").filter(function(c){return c.textContent.length<100000});
if(codes.length)load(A.highlight).then(function(){
  var h=window.hljs;if(!h||typeof h.highlightElement!=="function")return;
  codes.forEach(function(c){var lang=c.className.slice(9);if(h.getLanguage(lang))h.highlightElement(c)});
}).catch(function(){});

var maths=$$(".math");
if(maths.length){
  loadCss(A.katexCss);
  load(A.katex).then(function(){
    var k=window.katex;if(!k||typeof k.render!=="function")return;
    maths.forEach(function(el){
      var tex=el.textContent;el.setAttribute("title",tex);
      try{k.render(tex,el,{displayMode:el.classList.contains("math-display"),throwOnError:false,trust:false,maxExpand:1000,maxSize:50})}catch(e){}
    });
  }).catch(function(){});
}

var diagrams=$$(".mermaid-block");
if(diagrams.length)load(A.mermaid).then(function(){
  var m=window.mermaid;if(!m||typeof m.render!=="function")return;
  var n=0;
  function draw(){
    m.initialize({startOnLoad:false,securityLevel:"strict",theme:isDark()?"dark":"default",suppressErrorRendering:true});
    diagrams.forEach(function(block){
      var pre=block.querySelector("pre.mermaid-src");var out=block.querySelector(".mermaid-out");
      if(!out){out=d.createElement("div");out.className="mermaid-out";block.appendChild(out)}
      var id="afs-mermaid-"+(n++);
      m.render(id,pre.textContent).then(function(r){out.innerHTML=r.svg;block.classList.add("rendered");block.classList.remove("failed")},function(){
        var stray=d.getElementById("d"+id);if(stray)stray.remove();
        block.classList.add("failed");block.classList.remove("rendered");out.textContent="This diagram could not be rendered. Its source is shown above.";
      });
    });
  }
  draw();onTheme.push(draw);
}).catch(function(){});
})();`;

function sha256(source: string): string {
  return `'sha256-${createHash("sha256").update(source).digest("base64")}'`;
}

export const THEME_INIT_HASH = sha256(THEME_INIT_SCRIPT);
export const PAGE_SCRIPT_HASH = sha256(PAGE_SCRIPT);
