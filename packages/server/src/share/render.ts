import { detectMimeType, withUtf8Charset } from "@/core/ops/mime.js";

/**
 * Server-side HTML for the public /share/:token page.
 *
 * Everything here is escape-by-construction: user content only ever reaches the
 * page through `escapeHtml`, the page carries no scripts (the CSP forbids them
 * too), and links/embeds are built from fixed shapes, never from file content.
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

const ALIGN_CLASS: Record<string, string> = { left: "al-l", right: "al-r", center: "al-c" };

/**
 * Render markdown to HTML with a whitelist renderer. Raw HTML in the source is
 * shown as text (never passed through), images are replaced by their alt text
 * (no remote loads from a public page), and links are restricted to http(s) and
 * mailto. Text is escaped in one place, the `text` callback.
 */
export function renderMarkdownSafe(markdown: string): string {
  const md = (Bun as any).markdown as
    | { render?: (input: string, callbacks: Record<string, (...args: any[]) => string>) => string }
    | undefined;
  if (typeof md?.render !== "function") {
    // Runtime without the markdown renderer: show the source, escaped.
    return `<pre>${escapeHtml(markdown)}</pre>`;
  }

  const level = (meta: any): number => Math.min(6, Math.max(1, Number(meta?.level) || 1));

  return md.render(markdown, {
    text: (text: string) => escapeHtml(String(text)),
    html: (children: string) => children, // already-escaped text: raw HTML is displayed, not interpreted
    heading: (children: string, meta: any) => `<h${level(meta)}>${children}</h${level(meta)}>\n`,
    paragraph: (children: string) => `<p>${children}</p>\n`,
    blockquote: (children: string) => `<blockquote>${children}</blockquote>\n`,
    code: (children: string) => `<pre><code>${children}</code></pre>\n`,
    codespan: (children: string) => `<code>${children}</code>`,
    hr: () => "<hr>\n",
    strong: (children: string) => `<strong>${children}</strong>`,
    emphasis: (children: string) => `<em>${children}</em>`,
    strikethrough: (children: string) => `<del>${children}</del>`,
    list: (children: string, meta: any) => {
      if (!meta?.ordered) return `<ul>\n${children}</ul>\n`;
      const start = Number(meta.start);
      const attr = Number.isInteger(start) && start !== 1 ? ` start="${start}"` : "";
      return `<ol${attr}>\n${children}</ol>\n`;
    },
    listItem: (children: string, meta: any) => {
      const box = meta?.checked === true ? "&#9745; " : meta?.checked === false ? "&#9744; " : "";
      return `<li>${box}${children}</li>\n`;
    },
    table: (children: string) => `<div class="table-wrap"><table>${children}</table></div>\n`,
    thead: (children: string) => `<thead>${children}</thead>`,
    tbody: (children: string) => `<tbody>${children}</tbody>`,
    tr: (children: string) => `<tr>${children}</tr>`,
    th: (children: string, meta: any) => {
      const cls = ALIGN_CLASS[meta?.align as string];
      return `<th${cls ? ` class="${cls}"` : ""}>${children}</th>`;
    },
    td: (children: string, meta: any) => {
      const cls = ALIGN_CLASS[meta?.align as string];
      return `<td${cls ? ` class="${cls}"` : ""}>${children}</td>`;
    },
    link: (children: string, meta: any) => {
      const href = typeof meta?.href === "string" ? safeHref(meta.href) : null;
      if (!href) return children;
      return `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow" target="_blank">${children}</a>`;
    },
    image: (children: string) => `<span class="img-alt">[image${children ? `: ${children}` : ""}]</span>`,
  });
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

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#6b7280;--line:#e5e7eb;--card:#f9fafb;--accent:#111827;--accent-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e5e7eb;--muted:#9ca3af;--line:#262a33;--card:#161a21;--accent:#e5e7eb;--accent-fg:#0f1115}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.bar{display:flex;gap:16px;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg)}
.bar h1{margin:0;font-size:16px;font-weight:600;overflow-wrap:anywhere}
.sub{margin:2px 0 0;color:var(--muted);font-size:13px}
.btn{display:inline-block;padding:8px 16px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-weight:600;text-decoration:none;white-space:nowrap}
.btn:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
main{max-width:920px;margin:0 auto;padding:24px 20px}
.note{margin:0 0 16px;padding:10px 14px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--muted);font-size:13px}
pre{margin:0;padding:16px;overflow:auto;border:1px solid var(--line);border-radius:8px;background:var(--card);font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
article :is(h1,h2,h3,h4){line-height:1.25;margin:1.6em 0 .6em}
article h1{font-size:1.8em}article h2{font-size:1.4em}article h3{font-size:1.15em}
article p,article ul,article ol,article blockquote{margin:0 0 1em}
article blockquote{padding-left:14px;border-left:3px solid var(--line);color:var(--muted)}
article code{padding:1px 5px;border-radius:4px;background:var(--card);font:.9em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
article pre code{padding:0;background:none}
article a{color:inherit;text-decoration:underline}
article hr{border:0;border-top:1px solid var(--line);margin:1.6em 0}
.table-wrap{overflow-x:auto;margin:0 0 1em}
table{border-collapse:collapse;min-width:50%}
th,td{padding:6px 12px;border:1px solid var(--line)}
th{background:var(--card)}
.al-l{text-align:left}.al-r{text-align:right}.al-c{text-align:center}
.img-alt{color:var(--muted);font-style:italic}
.media{display:block;max-width:100%;margin:0 auto;border-radius:8px}
iframe.media{width:100%;height:80vh;border:1px solid var(--line)}
audio.media,video.media{width:100%}
.card{text-align:center;padding:48px 20px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
.card h2{margin:0 0 8px;font-size:18px}
.card p{margin:0 0 20px;color:var(--muted)}
.center{max-width:520px;margin:12vh auto;padding:0 20px;text-align:center}
.center h1{font-size:22px;margin:0 0 10px}
.center p{color:var(--muted)}
footer{max-width:920px;margin:0 auto;padding:16px 20px 32px;color:var(--muted);font-size:12px}
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
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
  | { kind: "markdown"; html: string }
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
  body: ShareBody;
}

function renderEmbed(tag: "img" | "iframe" | "audio" | "video", rawSrc: string, filename: string): string {
  const src = escapeHtml(rawSrc);
  const label = escapeHtml(filename);
  if (tag === "img") return `<img class="media" src="${src}" alt="${label}">`;
  if (tag === "iframe") return `<iframe class="media" src="${src}" title="${label}"></iframe>`;
  if (tag === "audio") return `<audio class="media" src="${src}" controls preload="metadata"></audio>`;
  return `<video class="media" src="${src}" controls preload="metadata"></video>`;
}

function renderBody(input: SharePageInput): string {
  const { body, filename } = input;
  if (body.kind === "markdown") return `<article>${body.html}</article>`;
  if (body.kind === "text") return `<pre>${escapeHtml(body.text)}</pre>`;
  if (body.kind === "embed") return renderEmbed(body.tag, body.src, filename);
  return `<div class="card"><h2>No preview available</h2><p>${escapeHtml(body.reason)}</p></div>`;
}

export function renderSharePage(input: SharePageInput): string {
  const { token, filename, size, mime, expiresAt, now, viewsLeft } = input;
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
  return shell(
    `${filename} · agent-fs`,
    `<header class="bar">
<div>
<h1>${escapeHtml(filename)}</h1>
<p class="sub">${type}${escapeHtml(formatBytes(size))} · ${expiry}</p>
</div>
<a class="btn" href="/share/${token}/download">Download</a>
</header>
<main>
${viewsNote}
${renderBody(input)}
</main>
<footer>Shared with agent-fs</footer>`
  );
}

// --- Headers ---

/**
 * Deny by default; open only what the page actually uses. No script-src at all,
 * so nothing can execute even if the escaping above had a hole. `embedSource`
 * is where the embed loads from (`'self'` or one origin); null when the page
 * embeds nothing.
 */
export function buildCsp(embedSource: string | null): string {
  const directives = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ];
  if (embedSource) {
    directives.push(
      `img-src ${embedSource}`,
      `media-src ${embedSource}`,
      `frame-src ${embedSource}`
    );
  }
  return directives.join("; ");
}

/** Headers for every response of the share routes. */
export function shareSecurityHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Frame-Options": "DENY",
    ...extra,
  };
}

const PREVIEW_BOT_UA =
  /slackbot|slack-imgproxy|twitterbot|facebookexternalhit|facebot|whatsapp|telegrambot|discordbot|linkedinbot|skypeuripreview|embedly|pinterest|redditbot|googlebot|bingbot|applebot|iframely|vkshare|mattermost/i;

/** Link unfurlers fetch pasted URLs; they must not consume a one-off view. */
export function isLinkPreviewBot(userAgent: string | undefined): boolean {
  return !!userAgent && PREVIEW_BOT_UA.test(userAgent);
}
