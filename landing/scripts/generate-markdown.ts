// Generates static markdown artifacts under `public/` at build time.
// These files are primarily useful for direct static access (e.g. tools
// that fetch `/llms.txt` without negotiation). The primary content
// negotiation happens in `middleware.ts`, which imports the same source.

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INDEX_MD, LLMS_TXT } from "../content/markdown.js";
import { DOC_METADATA, DOC_SECTIONS } from "../src/content/doc-metadata.js";

const landingRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(landingRoot, "..");
const publicDir = path.join(landingRoot, "public");
const mdDir = path.join(publicDir, "md");
const staticDocsDir = path.join(publicDir, "docs");

await mkdir(mdDir, { recursive: true });

const files: Array<[string, string]> = [
  [path.join(mdDir, "index.md"), INDEX_MD],
  [path.join(publicDir, "llms.txt"), LLMS_TXT],
];

for (const [file, contents] of files) {
  await writeFile(file, contents, "utf8");
  console.log(`wrote ${path.relative(landingRoot, file)} (${contents.length} bytes)`);
}

await rm(staticDocsDir, { recursive: true, force: true });
await cp(path.join(repoRoot, "docs"), staticDocsDir, { recursive: true });
console.log(`synced ${path.relative(landingRoot, staticDocsDir)} from ../docs`);

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stripMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_#>]/g, "")
    .trim();
}

function slugify(value: string): string {
  return stripMarkdown(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function docHrefForMarkdown(sourcePath: string, href: string): string {
  if (/^(https?:|mailto:|#)/.test(href)) return href;

  const normalized = new URL(href, `https://agent-fs.dev/${sourcePath}`).pathname.replace(/^\//, "");
  if (!normalized.startsWith("docs/")) return href;

  const withoutPrefix = normalized.replace(/^docs\//, "");
  const withoutExtension = withoutPrefix.replace(/\.md(#.*)?$/, "");
  if (withoutExtension === "mounting/README") return "/docs/mounting";

  const routeSlug = withoutExtension.replace(/^mounting\//, "mounting-").replace(/\//g, "-");
  return `/docs/${routeSlug}`;
}

function renderInline(value: string, sourcePath: string): string {
  const escaped = escapeHtml(value);
  return escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
    const resolved = docHrefForMarkdown(sourcePath, href);
    return `<a href="${escapeHtml(resolved)}">${escapeHtml(label)}</a>`;
  });
}

function markdownToHtml(markdown: string, sourcePath: string): string {
  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }

    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index].startsWith("```")) {
        code.push(lines[index]);
        index++;
      }
      index++;
      blocks.push(`<pre><code data-language="${escapeHtml(language)}">${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 4);
      const text = stripMarkdown(heading[2]);
      const id = slugify(text);
      blocks.push(`<h${level} id="${id}">${escapeHtml(text)}</h${level}>`);
      index++;
      continue;
    }

    if (/^(\d+\.|-)\s+/.test(line)) {
      const ordered = /^\d+\.\s+/.test(line);
      const itemPattern = ordered ? /^\d+\.\s+/ : /^-\s+/;
      const items: string[] = [];
      while (index < lines.length && itemPattern.test(lines[index])) {
        items.push(`<li>${renderInline(lines[index].replace(itemPattern, ""), sourcePath)}</li>`);
        index++;
      }
      blocks.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }

    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].startsWith(">")) {
        quote.push(lines[index].replace(/^>\s?/, ""));
        index++;
      }
      blocks.push(`<blockquote>${quote.map((part) => `<p>${renderInline(part, sourcePath)}</p>`).join("")}</blockquote>`);
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^#{1,4}\s+/.test(lines[index]) &&
      !lines[index].startsWith("```") &&
      !lines[index].startsWith(">") &&
      !/^(\d+\.|-)\s+/.test(lines[index])
    ) {
      paragraph.push(lines[index].trim());
      index++;
    }
    blocks.push(`<p>${renderInline(paragraph.join(" "), sourcePath)}</p>`);
  }

  return blocks.join("\n");
}

function docsNav(activeSlug?: string): string {
  return DOC_SECTIONS.map((section) => {
    const docs = DOC_METADATA.filter((doc) => doc.section === section);
    return `<section><h2>${section}</h2><ul>${docs
      .map((doc) => {
        const active = doc.slug === activeSlug ? ' aria-current="page"' : "";
        return `<li><a href="/docs/${doc.slug}"${active}>${escapeHtml(doc.title)}</a></li>`;
      })
      .join("")}</ul></section>`;
  }).join("");
}

function pageShell({
  title,
  description,
  canonicalPath,
  body,
}: {
  title: string;
  description: string;
  canonicalPath: string;
  body: string;
}): string {
  const canonical = `https://agent-fs.dev${canonicalPath}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${canonical}" />
    <style>
      :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #09090b; color: #fafafa; }
      body { margin: 0; }
      a { color: #f5b942; text-decoration: none; }
      a:hover { text-decoration: underline; }
      header, footer { border-color: #27272a; }
      header { border-bottom: 1px solid #27272a; padding: 16px 24px; }
      header nav, footer nav { display: flex; flex-wrap: wrap; gap: 12px 18px; font-family: ui-monospace, monospace; font-size: 13px; }
      main { display: grid; gap: 32px; grid-template-columns: minmax(180px, 260px) minmax(0, 1fr); max-width: 1180px; margin: 0 auto; padding: 48px 24px; }
      aside { border-right: 1px solid #27272a; padding-right: 24px; }
      aside h2 { color: #a1a1aa; font-family: ui-monospace, monospace; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; }
      ul { padding-left: 20px; }
      li { margin: 8px 0; }
      article { max-width: 760px; }
      h1 { font-size: clamp(36px, 6vw, 64px); line-height: .95; margin: 0 0 16px; }
      h2 { margin-top: 40px; }
      p, li { color: #d4d4d8; line-height: 1.75; }
      pre { overflow-x: auto; border: 1px solid #27272a; border-radius: 8px; padding: 16px; background: #18181b; }
      footer { border-top: 1px solid #27272a; padding: 24px; }
      @media (max-width: 760px) { main { grid-template-columns: 1fr; } aside { border-right: 0; padding-right: 0; } }
    </style>
  </head>
  <body>
    <header>
      <nav aria-label="Primary">
        <a href="/">agent-fs</a>
        <a href="/docs">Docs</a>
        <a href="/docs/mcp-setup">MCP Setup</a>
        <a href="/docs/api-reference">API Reference</a>
        <a href="https://github.com/desplega-ai/agent-fs">GitHub</a>
      </nav>
    </header>
    ${body}
    <footer>
      <nav aria-label="Footer">
        <a href="/docs">Docs index</a>
        <a href="/llms.txt">llms.txt</a>
        <a href="https://github.com/desplega-ai/agent-fs">GitHub</a>
      </nav>
    </footer>
  </body>
</html>
`;
}

const docsIndexHtml = pageShell({
  title: "agent-fs docs",
  description: "Documentation for agent-fs setup, deployment, HTTP APIs, SQL queries, and remote mounting.",
  canonicalPath: "/docs",
  body: `<main>
  <aside>${docsNav()}</aside>
  <article>
    <p>Documentation</p>
    <h1>Build against the agent filesystem.</h1>
    <p>The docs index is emitted as static HTML at build time so crawlers can discover every docs route before client-side JavaScript runs.</p>
    ${DOC_SECTIONS.map((section) => {
      const docs = DOC_METADATA.filter((doc) => doc.section === section);
      return `<section><h2>${section}</h2><ul>${docs
        .map((doc) => `<li><a href="/docs/${doc.slug}">${escapeHtml(doc.title)}</a> — ${escapeHtml(doc.summary)}</li>`)
        .join("")}</ul></section>`;
    }).join("")}
  </article>
</main>`,
});

await writeFile(path.join(staticDocsDir, "index.html"), docsIndexHtml, "utf8");
console.log("wrote public/docs/index.html");

for (const doc of DOC_METADATA) {
  const markdown = await readFile(path.join(repoRoot, doc.sourcePath), "utf8");
  const html = pageShell({
    title: `${doc.title} — agent-fs docs`,
    description: doc.summary,
    canonicalPath: `/docs/${doc.slug}`,
    body: `<main>
  <aside>${docsNav(doc.slug)}</aside>
  <article>
    <p>${escapeHtml(doc.sourcePath)}</p>
    ${markdownToHtml(markdown, doc.sourcePath)}
  </article>
</main>`,
  });
  const outDir = path.join(staticDocsDir, doc.slug);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "index.html"), html, "utf8");
  console.log(`wrote public/docs/${doc.slug}/index.html`);
}
