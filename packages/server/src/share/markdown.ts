import { escapeHtml, safeHref } from "./render.js";

/**
 * Markdown documents for the public /share/:token page.
 *
 * The renderer is a whitelist: every tag in the output is built here from a
 * fixed shape, and user text reaches it only through `escapeHtml` (the `text`
 * callback, or `escapeHtml` on a value this file extracted itself). Raw HTML in
 * the source is shown as text, images become their alt text, and links are
 * limited to http(s), mailto and in-page fragments.
 *
 * Things the markdown parser does not know (math, footnotes) are cut out of the
 * source first and replaced by opaque placeholders, then put back as escaped
 * text inside fixed tags once the parser is done. The page's own script turns
 * those tags into diagrams, math and highlighted code; without it they stay
 * readable source.
 */

export interface TocEntry {
  level: number;
  id: string;
  /** Plain text, not escaped. */
  text: string;
}

export interface MarkdownDocument {
  /** The rendered body. */
  html: string;
  /** Rendered frontmatter block, or null when the file has none. */
  frontmatter: string | null;
  /** Headings for the table of contents (already filtered to the levels shown). */
  toc: TocEntry[];
  words: number;
  /** Which client-side enhancements the body needs. */
  features: { mermaid: boolean; math: boolean; highlight: boolean };
}

// Private-use code points never survive from the source (see `stripPlaceholders`).
const PH_OPEN = "\uE000";
const PH_CLOSE = "\uE001";
const PLACEHOLDER = /\uE000(\d+)\uE001/g;

type Slot =
  | { kind: "math"; display: boolean; tex: string; raw: string }
  | { kind: "fnref"; id: string; raw: string };

// --- Frontmatter ---

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const MAX_FRONTMATTER_CHARS = 32 * 1024;
/** Values rendered from the frontmatter at most. YAML aliases can make a tiny file a huge tree. */
const FRONTMATTER_NODE_BUDGET = 400;
const FRONTMATTER_MAX_DEPTH = 3;

function splitFrontmatter(source: string): { yaml: string | null; body: string } {
  // Only the head of the file can be frontmatter: never scan a whole large file for it.
  const match = FRONTMATTER.exec(source.slice(0, MAX_FRONTMATTER_CHARS + 16));
  if (!match || match[1].length > MAX_FRONTMATTER_CHARS) return { yaml: null, body: source };
  return { yaml: match[1], body: source.slice(match[0].length) };
}

function renderFrontmatter(yaml: string): string {
  let data: unknown;
  try {
    data = (Bun as any).YAML?.parse(yaml);
  } catch {
    data = undefined;
  }
  const inner =
    data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).length > 0
      ? renderMapping(data as Record<string, unknown>, 0, { left: FRONTMATTER_NODE_BUDGET })
      : `<pre class="fm-raw">${escapeHtml(yaml)}</pre>`;
  return `<section class="frontmatter" aria-label="Document metadata">${inner}</section>`;
}

function renderMapping(obj: Record<string, unknown>, depth: number, budget: { left: number }): string {
  const rows: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (--budget.left < 0) {
      rows.push(`<div class="fm-row"><dt>…</dt><dd></dd></div>`);
      break;
    }
    rows.push(`<div class="fm-row"><dt>${escapeHtml(key)}</dt><dd>${renderYamlValue(value, depth + 1, budget)}</dd></div>`);
  }
  return `<dl class="fm">${rows.join("")}</dl>`;
}

function renderYamlValue(value: unknown, depth: number, budget: { left: number }): string {
  if (value === null || value === undefined || value === "") return `<span class="fm-empty">—</span>`;
  if (value instanceof Date) return escapeHtml(value.toISOString());
  if (typeof value !== "object") {
    const text = String(value);
    if (typeof value === "boolean") return `<span class="fm-bool">${text}</span>`;
    const href = typeof value === "string" && /^https?:\/\/\S+$/i.test(text) ? safeHref(text) : null;
    return href
      ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(text)}</a>`
      : escapeHtml(text);
  }
  if (depth > FRONTMATTER_MAX_DEPTH || budget.left <= 0) return `<span class="fm-empty">…</span>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `<span class="fm-empty">—</span>`;
    const scalars = value.every((v) => v === null || typeof v !== "object");
    const items: string[] = [];
    for (const item of value) {
      if (--budget.left < 0) {
        items.push(scalars ? `<span class="chip">…</span>` : `<li>…</li>`);
        break;
      }
      const rendered = renderYamlValue(item, depth + 1, budget);
      items.push(scalars ? `<span class="chip">${rendered}</span>` : `<li>${rendered}</li>`);
    }
    return scalars ? `<span class="chips">${items.join("")}</span>` : `<ul class="fm-list">${items.join("")}</ul>`;
  }
  return renderMapping(value as Record<string, unknown>, depth, budget);
}

// --- Math and footnotes, cut out before parsing ---

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FOOTNOTE_DEF = /^\[\^([A-Za-z0-9_-]{1,64})\]:[ \t]?(.*)$/;
const FOOTNOTE_REF = /\[\^([A-Za-z0-9_-]{1,64})\]/g;
const DISPLAY_MATH = /\$\$([\s\S]+?)\$\$/g;
// `$x$`: no space just inside either dollar, and no digit/word right after the
// closing one, so "$5 and $10" stays prose.
// Bounded, so a line full of lone dollars costs linear time.
const INLINE_MATH = /(?<![\\$\w])\$(?![\s$])((?:\\.|[^$\\\n]){1,500}?)(?<![\s\\])\$(?![\w$])/g;

/** Split into fenced-code and prose chunks, line by line. Fenced code is never touched. */
function splitFences(body: string): Array<{ code: boolean; text: string }> {
  const chunks: Array<{ code: boolean; text: string }> = [];
  let fence: string | null = null;
  let current: string[] = [];
  const flush = (code: boolean) => {
    if (current.length) chunks.push({ code, text: current.join("\n") });
    current = [];
  };
  for (const line of body.split("\n")) {
    if (fence === null) {
      const open = FENCE_OPEN.exec(line);
      if (open) {
        flush(false);
        fence = open[1];
        current.push(line);
        continue;
      }
      current.push(line);
    } else {
      current.push(line);
      const trimmed = line.trim();
      if (trimmed.length >= fence.length && trimmed === fence[0].repeat(trimmed.length)) {
        flush(true);
        fence = null;
      }
    }
  }
  flush(fence !== null);
  return chunks;
}

/** Apply `fn` to prose only: fenced code and inline code spans pass through. */
function mapProse(body: string, fn: (prose: string) => string): string {
  return splitFences(body)
    .map((chunk) => {
      if (chunk.code) return chunk.text;
      let out = "";
      let last = 0;
      for (const [start, end] of codeSpans(chunk.text)) {
        out += fn(chunk.text.slice(last, start)) + chunk.text.slice(start, end);
        last = end;
      }
      return out + fn(chunk.text.slice(last));
    })
    .join("\n");
}

/**
 * Inline code spans as [start, end) ranges: a backtick run closed by the next
 * run of the same length. Linear, unlike a backreference regex, which is
 * quadratic on long unmatched runs.
 */
function codeSpans(text: string): Array<[number, number]> {
  const runs = [...text.matchAll(/`+/g)].map((m) => ({ at: m.index!, len: m[0].length }));
  const byLen = new Map<number, number[]>();
  runs.forEach((run, i) => {
    const list = byLen.get(run.len);
    if (list) list.push(i);
    else byLen.set(run.len, [i]);
  });
  const cursor = new Map<number, number>();
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < runs.length; i++) {
    const { at, len } = runs[i];
    const list = byLen.get(len)!;
    let p = cursor.get(len) ?? 0;
    while (p < list.length && list[p] <= i) p++;
    cursor.set(len, p);
    if (p === list.length) continue; // unmatched: literal backticks
    const close = list[p];
    spans.push([at, runs[close].at + len]);
    i = close;
  }
  return spans;
}

/** Pull `[^id]: text` definitions (with indented continuation lines) out of the prose. */
function extractFootnoteDefs(body: string): { body: string; defs: Map<string, string> } {
  const defs = new Map<string, string>();
  const out: string[] = [];
  for (const chunk of splitFences(body)) {
    if (chunk.code) {
      out.push(chunk.text);
      continue;
    }
    const lines = chunk.text.split("\n");
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const def = FOOTNOTE_DEF.exec(lines[i]);
      if (!def) {
        kept.push(lines[i]);
        continue;
      }
      const parts = [def[2]];
      while (i + 1 < lines.length && /^(?: {2,}|\t)\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      if (!defs.has(def[1])) defs.set(def[1], parts.join("\n"));
    }
    out.push(kept.join("\n"));
  }
  return { body: out.join("\n"), defs };
}

// --- Rendering ---

const CALLOUTS: Record<string, string> = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
};
const CALLOUT_HEAD = /^<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|(?=<\/p>))/i;
const ALIGN_CLASS: Record<string, string> = { left: "al-l", right: "al-r", center: "al-c" };
/** Bare URLs and emails become links; the link callback still vets every href. */
const RENDER_OPTIONS = { autolinks: true };
const FRAGMENT_HREF = /^#[^\s"'<>`]{0,200}$/;

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return slug || "section";
}

function codeLanguage(meta: any): string | null {
  const lang = typeof meta?.language === "string" ? meta.language.trim().split(/\s+/)[0] : "";
  return /^[A-Za-z0-9_+#.-]{1,32}$/.test(lang) ? lang.toLowerCase() : null;
}

/** Remove the placeholder code points from untrusted input so they can only come from us. */
function stripPlaceholders(text: string): string {
  return text.replace(/[\uE000\uE001]/g, "\uFFFD");
}

export function renderMarkdownDocument(source: string): MarkdownDocument {
  const { yaml, body: rawBody } = splitFrontmatter(stripPlaceholders(source));
  const features = { mermaid: false, math: false, highlight: false };

  const slots: Slot[] = [];
  const slot = (s: Slot) => `${PH_OPEN}${slots.push(s) - 1}${PH_CLOSE}`;
  /** Placeholders back to their source text (for code, attributes and plain text). */
  const restore = (text: string) => text.replace(PLACEHOLDER, (_, i) => slots[Number(i)]?.raw ?? "");

  const { body: withoutDefs, defs } = extractFootnoteDefs(rawBody);
  const prose = (text: string) =>
    text
      .replace(DISPLAY_MATH, (raw, tex: string) => slot({ kind: "math", display: true, tex: tex.trim(), raw }))
      .replace(INLINE_MATH, (raw, tex: string) => slot({ kind: "math", display: false, tex, raw }))
      .replace(FOOTNOTE_REF, (raw, id: string) => (defs.has(id) ? slot({ kind: "fnref", id, raw }) : raw));
  const body = mapProse(withoutDefs, prose);
  const defBodies = new Map([...defs].map(([id, text]) => [id, mapProse(text, prose)]));

  const headings: TocEntry[] = [];
  const usedIds = new Set<string>();
  const md = (Bun as any).markdown as
    | { render?: (input: string, callbacks: Record<string, (...args: any[]) => string>, options?: object) => string }
    | undefined;
  if (typeof md?.render !== "function") {
    // Runtime without the markdown renderer: show the source, escaped.
    return {
      html: `<pre>${escapeHtml(source)}</pre>`,
      frontmatter: null,
      toc: [],
      words: countWords(source),
      features,
    };
  }

  const level = (meta: any): number => Math.min(6, Math.max(1, Number(meta?.level) || 1));

  const callbacks: Record<string, (...args: any[]) => string> = {
    text: (text: string) => escapeHtml(String(text)),
    html: (children: string) => children, // already-escaped text: raw HTML is displayed, not interpreted
    heading: (children: string, meta: any) => {
      const n = level(meta);
      const text = stripTags(restore(children)).trim();
      let id = slugify(text);
      for (let i = 1; usedIds.has(id); i++) id = `${slugify(text)}-${i}`;
      usedIds.add(id);
      headings.push({ level: n, id, text });
      return `<h${n} id="${escapeHtml(id)}">${children}<a class="anchor" href="#${escapeHtml(id)}" aria-label="Link to this section">#</a></h${n}>\n`;
    },
    paragraph: (children: string) => `<p>${children}</p>\n`,
    blockquote: (children: string) => {
      const head = CALLOUT_HEAD.exec(children);
      if (!head) return `<blockquote>${children}</blockquote>\n`;
      const type = head[1].toUpperCase();
      const rest = `<p>${children.slice(head[0].length)}`.replace(/^<p><\/p>\n?/, "");
      return `<div class="callout callout-${type.toLowerCase()}"><p class="callout-title">${CALLOUTS[type]}</p>${rest}</div>\n`;
    },
    code: (children: string, meta: any) => {
      const code = restore(children);
      const lang = codeLanguage(meta);
      if (lang === "mermaid") {
        features.mermaid = true;
        return `<div class="mermaid-block"><pre class="mermaid-src"><code>${code}</code></pre></div>\n`;
      }
      if (lang === "math") {
        features.math = true;
        return `<p><span class="math math-display">${code}</span></p>\n`;
      }
      if (lang) features.highlight = true;
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      const label = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
      return `<div class="code-block"${label}><pre class="code"><code${cls}>${code}</code></pre></div>\n`;
    },
    codespan: (children: string) => `<code>${restore(children)}</code>`,
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
      if (meta?.checked === true || meta?.checked === false) {
        const checked = meta.checked ? " checked" : "";
        return `<li class="task"><input type="checkbox" disabled${checked}> ${children}</li>\n`;
      }
      return `<li>${children}</li>\n`;
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
      const raw = typeof meta?.href === "string" ? restore(meta.href) : "";
      if (FRAGMENT_HREF.test(raw)) return `<a href="${escapeHtml(raw)}">${children}</a>`;
      const href = raw ? safeHref(raw) : null;
      if (!href) return children;
      return `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow" target="_blank">${children}</a>`;
    },
    image: (children: string) => `<span class="img-alt">[image${children ? `: ${children}` : ""}]</span>`,
  };

  // Footnotes are numbered in the order they are first referenced.
  const fnOrder: string[] = [];
  const fnNumber = new Map<string, number>();
  const fnRefCount = new Map<string, number>();
  const fill = (html: string): string =>
    html.replace(PLACEHOLDER, (_, i) => {
      const s = slots[Number(i)];
      if (!s) return "";
      if (s.kind === "math") {
        features.math = true;
        return `<span class="math ${s.display ? "math-display" : "math-inline"}">${escapeHtml(s.tex)}</span>`;
      }
      let n = fnNumber.get(s.id);
      if (n === undefined) {
        n = fnOrder.push(s.id);
        fnNumber.set(s.id, n);
      }
      const seen = (fnRefCount.get(s.id) ?? 0) + 1;
      fnRefCount.set(s.id, seen);
      const refId = seen === 1 ? `fnref:${s.id}` : `fnref:${s.id}-${seen}`;
      return `<sup class="fnref"><a href="#fn:${s.id}" id="${refId}">${n}</a></sup>`;
    });

  let html = fill(md.render(body, callbacks, RENDER_OPTIONS));

  if (fnOrder.length) {
    const items: string[] = [];
    // A footnote may reference another one: the list grows while it is built.
    for (let i = 0; i < fnOrder.length; i++) {
      const id = fnOrder[i];
      const inner = fill(md.render(defBodies.get(id) ?? "", callbacks, RENDER_OPTIONS)).trim();
      const back = `<a class="fn-back" href="#fnref:${id}" aria-label="Back to reference">↩</a>`;
      const withBack = inner.endsWith("</p>") ? `${inner.slice(0, -4)} ${back}</p>` : `${inner}${back}`;
      items.push(`<li id="fn:${id}">${withBack}</li>`);
    }
    html += `<section class="footnotes" aria-label="Footnotes"><hr><ol>${items.join("\n")}</ol></section>\n`;
  }

  return {
    html,
    frontmatter: yaml === null ? null : renderFrontmatter(yaml),
    toc: tocEntries(headings),
    words: countWords(stripTags(html)),
    features,
  };
}

/** A lone H1 is the document title, not a section. Two levels below the top one are listed. */
function tocEntries(headings: TocEntry[]): TocEntry[] {
  const h1s = headings.filter((h) => h.level === 1).length;
  const candidates = h1s === 1 ? headings.filter((h) => h.level > 1) : headings;
  if (candidates.length === 0) return [];
  const top = Math.min(...candidates.map((h) => h.level));
  return candidates.filter((h) => h.level <= top + 1);
}

function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
}
