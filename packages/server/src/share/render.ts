import { detectMimeType, withUtf8Charset } from "@/core/ops/mime.js";
import { PAGE_SCRIPT, PAGE_SCRIPT_HASH, SHARE_ASSETS, THEME_INIT_HASH, THEME_INIT_SCRIPT } from "./client.js";
import type { MarkdownDocument } from "./markdown.js";

/**
 * Server-side HTML for the public /share/:token page.
 *
 * Everything here is escape-by-construction: user content only ever reaches the
 * page through `escapeHtml`, the only scripts are the page's own static ones
 * (allowed by hash in the CSP, see `client.ts`), and links/embeds are built
 * from fixed shapes, never from file content.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

// --- File classification ---

/** Extensions the shared MIME map does not cover but a browser can play. */
const EXTRA_MIME: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
};

/**
 * Extensions that browsers render as an active document. These are never
 * previewed and never served with their own content type: download only.
 */
const DOWNLOAD_ONLY_EXT = new Set([
  "html", "htm", "xhtml", "xht", "shtml", "mht", "mhtml", "svg", "svgz",
]);

/** Types that may be embedded inline. Deliberately excludes SVG and HTML. */
const EMBEDDABLE_MIME = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon",
  "application/pdf",
  "audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/aac", "audio/flac",
  "video/mp4", "video/webm", "video/quicktime", "video/ogg",
]);

export type ShareKind = "markdown" | "text" | "image" | "pdf" | "audio" | "video" | "sniff" | "none";

export interface ShareFileType {
  /** Content type used for delivery. `application/octet-stream` for download-only types. */
  mime: string;
  kind: ShareKind;
  /** Active-content type that must only ever be downloaded. */
  downloadOnly: boolean;
}

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

export function classifyShareFile(path: string): ShareFileType {
  const ext = extensionOf(path);
  if (DOWNLOAD_ONLY_EXT.has(ext)) {
    return { mime: "application/octet-stream", kind: "none", downloadOnly: true };
  }

  let mime = detectMimeType(path);
  if (mime === "application/octet-stream" && EXTRA_MIME[ext]) mime = EXTRA_MIME[ext];

  if (mime === "image/svg+xml" || mime === "text/html") {
    return { mime: "application/octet-stream", kind: "none", downloadOnly: true };
  }
  if (mime === "text/markdown") return { mime, kind: "markdown", downloadOnly: false };
  if (mime === "application/pdf") return { mime, kind: "pdf", downloadOnly: false };
  if (EMBEDDABLE_MIME.has(mime)) {
    const kind = mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : "video";
    return { mime, kind, downloadOnly: false };
  }
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/x-ndjson" ||
    mime === "application/xml" ||
    mime === "application/x-yaml" ||
    mime === "application/toml"
  ) {
    return { mime, kind: "text", downloadOnly: false };
  }
  // Unknown extension: only previewed if the bytes turn out to be plain text.
  if (mime === "application/octet-stream") return { mime, kind: "sniff", downloadOnly: false };
  return { mime, kind: "none", downloadOnly: false };
}

export function isEmbeddable(type: ShareFileType): boolean {
  return EMBEDDABLE_MIME.has(type.mime) && !type.downloadOnly;
}

/** Content-Type header for bytes served by the share routes. */
export function shareContentType(type: ShareFileType): string {
  return withUtf8Charset(type.mime);
}

// --- Markdown ---

const SAFE_LINK = /^(https?:|mailto:)/i;

/** Only absolute http(s) and mailto links survive; everything else is dropped. */
export function safeHref(href: string): string | null {
  // Browsers ignore control characters and whitespace inside a scheme
  // ("java\tscript:"), so normalise before testing.
  const compact = href.replace(/[\u0000- \u007f-\u009f]/g, "");
  return SAFE_LINK.test(compact) ? href.trim() : null;
}

/**
 * The markdown parser is quadratic in container nesting (50,000 nested
 * blockquotes blocked the event loop for ~15 s) and this route is public, so
 * pathological input is shown as source instead of being parsed.
 */
export const MAX_MARKDOWN_RENDER_CHARS = 256 * 1024;
const DEEP_CONTAINER = /^(?:[ \t]*(?:>|[-*+]|\d{1,9}[.)])){40}/m;

export function isMarkdownSafeToRender(markdown: string): boolean {
  return markdown.length <= MAX_MARKDOWN_RENDER_CHARS && !DEEP_CONTAINER.test(markdown);
}

// --- Page ---

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[i]}`;
}

/** "in 3 hours", "in 12 minutes" — coarse on purpose. */
export function formatRemaining(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} days`;
}

const LIGHT = "--bg:#fff;--fg:#1a1a1a;--muted:#6b7280;--line:#e5e7eb;--card:#f6f7f9;--accent:#111827;--accent-fg:#fff;--link:#2563eb;--hl-kw:#cf222e;--hl-str:#0a3069;--hl-num:#0550ae;--hl-com:#6e7781;--hl-fn:#8250df;--hl-type:#953800;--hl-add:#dafbe1;--hl-del:#ffebe9;--note:#2563eb;--tip:#16a34a;--important:#8250df;--warning:#b45309;--caution:#dc2626";
const DARK = "--bg:#0f1115;--fg:#e5e7eb;--muted:#9ca3af;--line:#262a33;--card:#161a21;--accent:#e5e7eb;--accent-fg:#0f1115;--link:#7aa2ff;--hl-kw:#ff7b72;--hl-str:#a5d6ff;--hl-num:#79c0ff;--hl-com:#8b949e;--hl-fn:#d2a8ff;--hl-type:#ffa657;--hl-add:#033a16;--hl-del:#67060c;--note:#6ea8fe;--tip:#4ade80;--important:#c4a5ff;--warning:#fbbf24;--caution:#f87171";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

const STYLE = `
:root{color-scheme:light dark;${LIGHT}}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK}}}
:root[data-theme=light]{color-scheme:light}
:root[data-theme=dark]{color-scheme:dark;${DARK}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-x:hidden}
html:not(.js) .js-only{display:none!important}
.bar{display:flex;gap:12px 16px;align-items:center;justify-content:space-between;padding:12px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:10;background:var(--bg)}
.bar-title{min-width:0}
.bar h1{margin:0;font-size:16px;font-weight:600;overflow-wrap:anywhere}
.sub{margin:2px 0 0;color:var(--muted);font-size:13px}
.actions{display:flex;gap:8px;align-items:center;flex-shrink:0}
.btn{display:inline-block;padding:8px 16px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-weight:600;text-decoration:none;white-space:nowrap}
.btn:focus-visible,.tool:focus-visible,.theme-select:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
.theme-select,.tool{font:inherit;font-size:13px;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 10px;cursor:pointer}
.tool:hover,.theme-select:hover{background:var(--card)}
main{max-width:920px;margin:0 auto;padding:24px 20px}
main.wide{max-width:1180px}
.note{margin:0 0 16px;padding:10px 14px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--muted);font-size:13px}
pre{margin:0;padding:16px;overflow:auto;border:1px solid var(--line);border-radius:8px;background:var(--card);font:13px/1.5 ${MONO};white-space:pre-wrap;overflow-wrap:anywhere}
.doc{min-width:0}
.doc-body,.doc-main{min-width:0}
.doc-tools{display:flex;gap:8px;justify-content:flex-end;margin:0 0 12px}
.frontmatter{margin:0 0 24px;padding:12px 16px;border:1px solid var(--line);border-radius:10px;background:var(--card);font-size:14px}
.fm{margin:0;display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 20px}
.fm-row{display:contents}
.fm dt{color:var(--muted);font-weight:600}
.fm dd{margin:0;min-width:0;overflow-wrap:anywhere}
.fm .fm{grid-template-columns:max-content minmax(0,1fr);font-size:13px}
.fm-empty{color:var(--muted)}
.fm-bool{font-family:${MONO};font-size:.9em}
.fm-list{margin:0;padding-left:18px}
.fm-raw{background:none;border:0;padding:0}
.chips{display:flex;flex-wrap:wrap;gap:4px}
.chip{padding:0 8px;border:1px solid var(--line);border-radius:999px;background:var(--bg);font-size:13px}
article{font-size:16px;line-height:1.7;overflow-wrap:break-word}
article>:first-child{margin-top:0}
article :is(h1,h2,h3,h4,h5,h6){line-height:1.25;margin:1.6em 0 .6em;scroll-margin-top:80px}
article h1{font-size:1.8em}article h2{font-size:1.4em;padding-bottom:.25em;border-bottom:1px solid var(--line)}article h3{font-size:1.15em}
article p,article ul,article ol,article blockquote,article .callout{margin:0 0 1em}
article li>ul,article li>ol{margin:0}
article li.task{list-style:none}
article li.task input{margin:0 .4em 0 -1.3em;vertical-align:middle}
article blockquote{padding-left:14px;border-left:3px solid var(--line);color:var(--muted)}
article code{padding:1px 5px;border-radius:4px;background:var(--card);font:.88em ${MONO}}
article pre code{padding:0;background:none;font-size:13px}
article a{color:var(--link);text-decoration:underline;text-underline-offset:2px}
article hr{border:0;border-top:1px solid var(--line);margin:1.6em 0}
.anchor{margin-left:.35em;color:var(--muted);text-decoration:none!important;opacity:0;font-weight:400}
:is(h1,h2,h3,h4,h5,h6):hover>.anchor,.anchor:focus{opacity:1}
@media (hover:none){.anchor{opacity:.5}}
.code-block{position:relative;margin:0 0 1em}
.code-block pre{white-space:pre;overflow-wrap:normal;overflow-x:auto}
.code-block[data-lang]::before{content:attr(data-lang);position:absolute;top:6px;right:64px;color:var(--muted);font:11px ${MONO};pointer-events:none}
.copy{position:absolute;top:6px;right:6px;font:12px system-ui,sans-serif;color:var(--muted);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:2px 8px;cursor:pointer;opacity:.85}
.copy:hover{opacity:1;color:var(--fg)}
.callout{padding:8px 14px;border-left:4px solid var(--c);border-radius:6px;background:var(--card)}
.callout>:last-child{margin-bottom:0}
.callout-title{margin:0 0 4px!important;font-weight:600;color:var(--c)}
.callout-note{--c:var(--note)}.callout-tip{--c:var(--tip)}.callout-important{--c:var(--important)}.callout-warning{--c:var(--warning)}.callout-caution{--c:var(--caution)}
.math-display{display:block;overflow-x:auto;overflow-y:hidden;padding:4px 0;text-align:center}
.math:not(:has(.katex)){font-family:${MONO};font-size:.9em}
.mermaid-block{margin:0 0 1em}
.mermaid-block.rendered .mermaid-src{display:none}
.mermaid-out{overflow-x:auto;text-align:center}
.mermaid-out:empty{display:none}
.mermaid-out svg{max-width:100%;height:auto}
.mermaid-block.failed .mermaid-out{margin-top:6px;color:var(--muted);font-size:13px;text-align:left}
.footnotes{font-size:.9em;color:var(--muted);margin-top:2em}
.footnotes li:target,.fnref a:target{background:var(--card)}
.fnref a{text-decoration:none}
.fn-back{text-decoration:none}
pre.source{white-space:pre-wrap}
.toc{display:none}
.toc-title{margin:0 0 8px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.toc ol,.toc-mobile ol{list-style:none;margin:0;padding:0}
.toc a,.toc-mobile a{display:block;padding:3px 0 3px 10px;border-left:2px solid transparent;color:var(--muted);text-decoration:none;font-size:13px;line-height:1.4}
.toc a:hover,.toc-mobile a:hover{color:var(--fg)}
.toc a.active{color:var(--fg);border-left-color:var(--fg)}
.toc .t2 a,.toc-mobile .t2 a{padding-left:22px}
.toc-mobile{margin:0 0 16px;border:1px solid var(--line);border-radius:8px;background:var(--card)}
.toc-mobile summary{padding:8px 12px;cursor:pointer;font-size:14px;font-weight:600}
.toc-mobile ol{padding:0 12px 10px}
@media (min-width:1100px){
.doc.has-toc{display:grid;grid-template-columns:minmax(0,1fr) 220px;column-gap:48px}
.doc.has-toc>*{grid-column:1}
.doc.has-toc>.toc{display:block;grid-column:2;grid-row:1/span 5;position:sticky;top:84px;align-self:start;max-height:calc(100vh - 110px);overflow:auto}
.toc-mobile{display:none}
}
.table-wrap{overflow-x:auto;margin:0 0 1em}
table{border-collapse:collapse;min-width:50%}
th,td{padding:6px 12px;border:1px solid var(--line)}
th{background:var(--card)}
.al-l{text-align:left}.al-r{text-align:right}.al-c{text-align:center}
.img-alt{color:var(--muted);font-style:italic}
.media{display:block;max-width:100%;margin:0 auto;border-radius:8px}
img.media{cursor:zoom-in}
img.media.zoomed{max-width:none;cursor:zoom-out}
main:has(img.media.zoomed){max-width:none;overflow-x:auto}
iframe.media{width:100%;height:80vh;border:1px solid var(--line)}
audio.media,video.media{width:100%}
.card{text-align:center;padding:48px 20px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
.card h2{margin:0 0 8px;font-size:18px}
.card p{margin:0 0 20px;color:var(--muted)}
.center{max-width:520px;margin:12vh auto;padding:0 20px;text-align:center}
.center h1{font-size:22px;margin:0 0 10px}
.center p{color:var(--muted)}
footer{max-width:920px;margin:0 auto;padding:16px 20px 32px;color:var(--muted);font-size:12px}
main.wide+footer{max-width:1180px}
.hljs-keyword,.hljs-selector-tag,.hljs-meta .hljs-keyword,.hljs-doctag,.hljs-template-tag{color:var(--hl-kw)}
.hljs-string,.hljs-regexp,.hljs-meta .hljs-string,.hljs-char.escape_{color:var(--hl-str)}
.hljs-number,.hljs-literal,.hljs-attr,.hljs-attribute,.hljs-variable,.hljs-template-variable,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-meta,.hljs-symbol,.hljs-link{color:var(--hl-num)}
.hljs-comment,.hljs-code,.hljs-formula,.hljs-quote{color:var(--hl-com);font-style:italic}
.hljs-title,.hljs-title.function_,.hljs-section,.hljs-name{color:var(--hl-fn)}
.hljs-built_in,.hljs-type,.hljs-title.class_,.hljs-params,.hljs-property,.hljs-bullet{color:var(--hl-type)}
.hljs-addition{background:var(--hl-add)}.hljs-deletion{background:var(--hl-del)}
.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:600}
@media (max-width:640px){
.bar{padding:10px 14px;flex-wrap:wrap;position:static}
.actions{width:100%;justify-content:space-between}
main{padding:16px 14px}
footer{padding:12px 14px 24px}
.fm{grid-template-columns:minmax(0,1fr);gap:0}
.fm dt{margin-top:6px}
.fm .fm{gap:2px 12px}
.fm .fm dt{margin-top:0}
article th,article td{white-space:nowrap}
article{font-size:16px}
article h1{font-size:1.6em}article h2{font-size:1.3em}
}
@media print{
:root,:root[data-theme]{color-scheme:light;${LIGHT}}
body{font-size:11pt}
.bar{position:static}
.actions,.doc-tools,.toc,.toc-mobile,.copy,.anchor,footer,.note{display:none!important}
main,main.wide{max-width:none;padding:0}
.doc.has-toc{display:block}
.code-block pre,pre{white-space:pre-wrap;overflow:visible}
article a[href^="http"]::after{content:" (" attr(href) ")";font-size:.85em;color:var(--muted);overflow-wrap:anywhere}
article :is(h1,h2,h3){break-after:avoid}
.code-block,.callout,.mermaid-block,table,.frontmatter{break-inside:avoid}
}
`;

function shell(title: string, body: string, opts: { scripts?: boolean } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
${opts.scripts ? `<script>${THEME_INIT_SCRIPT}</script>\n` : ""}<style>${STYLE}</style>
</head>
<body>
${body}
${opts.scripts ? `<script>${PAGE_SCRIPT}</script>\n` : ""}</body>
</html>
`;
}

/** Shown for revoked, expired and used-up links (and links that never existed). */
export function renderExpiredPage(): string {
  return shell(
    "Link expired · agent-fs",
    `<div class="center">
<h1>This link has expired</h1>
<p>It has passed its expiry time, been revoked, or already been opened the maximum number of times.</p>
<p>Ask the person who shared it for a new link.</p>
</div>`
  );
}

/** The link is valid but its file is gone (deleted or moved). */
export function renderUnavailablePage(): string {
  return shell(
    "File unavailable · agent-fs",
    `<div class="center">
<h1>This file is no longer available</h1>
<p>The shared file was deleted or moved. Ask the person who shared it for a new link.</p>
</div>`
  );
}

/**
 * Minimal page for link-preview crawlers (Slack, WhatsApp, ...). They must not
 * spend a view of a one-off link, and they get no file details.
 */
export function renderPreviewBotPage(): string {
  return shell(
    "Shared file · agent-fs",
    `<div class="center">
<h1>A file was shared with you</h1>
<p>Open this link in a browser to view and download it.</p>
</div>`
  );
}

export type ShareBody =
  | { kind: "markdown"; doc: MarkdownDocument; source: string }
  | { kind: "text"; text: string }
  | { kind: "embed"; tag: "img" | "iframe" | "audio" | "video"; src: string }
  | { kind: "none"; reason: string };

export interface SharePageInput {
  token: string;
  filename: string;
  size: number;
  mime: string;
  expiresAt: Date;
  now: Date;
  /** Views left after this one, or null for an unlimited link. */
  viewsLeft: number | null;
  /**
   * The grant issued with this view of a view-limited link. The Download link
   * carries it; without it the byte routes refuse the request. Null for an
   * unlimited link, whose token is enough.
   */
  grant?: string | null;
  body: ShareBody;
}

/** `?g=<grant>` for a byte-route URL, or nothing for an unlimited link. */
export function grantQuery(grant: string | null | undefined): string {
  return grant ? `?g=${encodeURIComponent(grant)}` : "";
}

function renderEmbed(tag: "img" | "iframe" | "audio" | "video", rawSrc: string, filename: string): string {
  const src = escapeHtml(rawSrc);
  const label = escapeHtml(filename);
  if (tag === "img") return `<img class="media" src="${src}" alt="${label}">`;
  if (tag === "iframe") return `<iframe class="media" src="${src}" title="${label}"></iframe>`;
  if (tag === "audio") return `<audio class="media" src="${src}" controls preload="metadata"></audio>`;
  return `<video class="media" src="${src}" controls preload="metadata"></video>`;
}

/** Shown only when there are enough sections to be worth navigating. */
const MIN_TOC_ENTRIES = 3;

function renderTocList(doc: MarkdownDocument): string {
  const top = Math.min(...doc.toc.map((e) => e.level));
  const items = doc.toc.map(
    (e) => `<li class="t${e.level - top + 1}"><a href="#${escapeHtml(e.id)}">${escapeHtml(e.text)}</a></li>`
  );
  return `<ol>${items.join("")}</ol>`;
}

function renderMarkdownBody(doc: MarkdownDocument, source: string): string {
  const hasToc = doc.toc.length >= MIN_TOC_ENTRIES;
  const list = hasToc ? renderTocList(doc) : "";
  return `<div class="doc${hasToc ? " has-toc" : ""}">
${hasToc ? `<details class="toc-mobile"><summary>Contents</summary>${list}</details>` : ""}
<div class="doc-tools js-only"><button type="button" class="tool source-toggle" aria-pressed="false">View source</button><button type="button" class="tool copy-md">Copy markdown</button></div>
<div class="doc-body">
${doc.frontmatter ?? ""}
<article>${doc.html}</article>
</div>
<pre class="source" hidden>${escapeHtml(source)}</pre>
${hasToc ? `<nav class="toc" aria-label="Contents"><p class="toc-title">Contents</p>${list}</nav>` : ""}
</div>`;
}

function renderBody(input: SharePageInput): string {
  const { body, filename } = input;
  if (body.kind === "markdown") return renderMarkdownBody(body.doc, body.source);
  if (body.kind === "text") return `<pre>${escapeHtml(body.text)}</pre>`;
  if (body.kind === "embed") return renderEmbed(body.tag, body.src, filename);
  return `<div class="card"><h2>No preview available</h2><p>${escapeHtml(body.reason)}</p></div>`;
}

/** "4 min read" at a typical 220 words a minute. */
export function formatReadingTime(words: number): string {
  return `${Math.max(1, Math.round(words / 220))} min read`;
}

const THEME_PICKER = `<select class="theme-select js-only" aria-label="Theme">
<option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
</select>`;

export function renderSharePage(input: SharePageInput): string {
  const { token, filename, size, mime, expiresAt, now, viewsLeft, body } = input;
  const remaining = formatRemaining(expiresAt.getTime() - now.getTime());
  const expiry = `Expires <time datetime="${expiresAt.toISOString()}">${escapeHtml(
    expiresAt.toISOString().replace("T", " ").slice(0, 16)
  )} UTC</time> (${remaining})`;

  let viewsNote = "";
  if (viewsLeft !== null) {
    viewsNote =
      viewsLeft === 0
        ? `<p class="note">This link has now been used up and will not open again. Download the file now if you need it.</p>`
        : `<p class="note">This link can be opened ${viewsLeft} more time${viewsLeft === 1 ? "" : "s"}.</p>`;
  }

  const type = mime === "application/octet-stream" ? "" : `${escapeHtml(mime)} · `;
  const reading = body.kind === "markdown" ? `${formatReadingTime(body.doc.words)} · ` : "";
  const wide = body.kind === "markdown" && body.doc.toc.length >= MIN_TOC_ENTRIES;
  return shell(
    `${filename} · agent-fs`,
    `<header class="bar">
<div class="bar-title">
<h1>${escapeHtml(filename)}</h1>
<p class="sub">${type}${escapeHtml(formatBytes(size))} · ${reading}${expiry}</p>
</div>
<div class="actions">
${THEME_PICKER}
<a class="btn" href="/share/${token}/download${grantQuery(input.grant)}">Download</a>
</div>
</header>
<main${wide ? ` class="wide"` : ""}>
${viewsNote}
${renderBody(input)}
</main>
<footer>Shared with agent-fs</footer>`,
    { scripts: true }
  );
}

/** Scripts the page body needs, which decides what its CSP lets it load. */
export function pageScripts(body: ShareBody): PageScripts {
  return body.kind === "markdown" ? { ...body.doc.features } : {};
}

// --- Headers ---

export interface PageScripts {
  mermaid?: boolean;
  math?: boolean;
  highlight?: boolean;
}

/**
 * Deny by default; open only what the page actually uses. `embedSource` is
 * where the embed loads from (`'self'` or one origin); null when the page
 * embeds nothing.
 *
 * `scripts` is set only for the preview page. It allows the page's two inline
 * scripts by hash (never 'unsafe-inline', so nothing injected into the markup
 * could run even if the escaping had a hole) and, when the document needs
 * them, the exact version-pinned CDN files of the renderers, which the page
 * loads with Subresource Integrity. Pages without it carry no script-src.
 */
export function buildCsp(embedSource: string | null, scripts?: PageScripts | null): string {
  const styles = ["'unsafe-inline'"];
  if (scripts?.math) styles.push(SHARE_ASSETS.katexCss.src);
  const directives = [
    "default-src 'none'",
    `style-src ${styles.join(" ")}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ];
  if (scripts) {
    const sources = [THEME_INIT_HASH, PAGE_SCRIPT_HASH];
    if (scripts.highlight) sources.push(SHARE_ASSETS.highlight.src);
    if (scripts.math) sources.push(SHARE_ASSETS.katex.src);
    if (scripts.mermaid) sources.push(SHARE_ASSETS.mermaid.src);
    directives.push(`script-src ${sources.join(" ")}`);
    if (scripts.math) directives.push(`font-src ${SHARE_ASSETS.katexFonts}`);
  }
  if (embedSource) {
    directives.push(
      `img-src ${embedSource}`,
      `media-src ${embedSource}`,
      `frame-src ${embedSource}`
    );
  }
  return directives.join("; ");
}

/**
 * Baseline CSP for every share response that has no page of its own: errors,
 * redirects, rate-limit refusals. Nothing loads, nothing frames it, and the
 * sandbox drops every privilege should a browser ever render the body. The
 * page, the embed routes and the PDF route replace it with their own value.
 */
export const SHARE_BASELINE_CSP =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox";

/**
 * Headers for every response of the share routes. `extra` wins, which is how
 * the preview page and the inline routes replace the baseline CSP.
 */
export function shareSecurityHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": SHARE_BASELINE_CSP,
    ...extra,
  };
}

const PREVIEW_BOT_UA =
  /slackbot|slack-imgproxy|twitterbot|facebookexternalhit|facebot|whatsapp|telegrambot|discordbot|linkedinbot|skypeuripreview|embedly|pinterest|redditbot|googlebot|bingbot|applebot|iframely|vkshare|mattermost/i;

/** Link unfurlers fetch pasted URLs; they must not consume a one-off view. */
export function isLinkPreviewBot(userAgent: string | undefined): boolean {
  return !!userAgent && PREVIEW_BOT_UA.test(userAgent);
}
