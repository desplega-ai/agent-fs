import { describe, test, expect } from "bun:test";
import { renderMarkdownDocument } from "../share/markdown.js";
import { buildCsp, pageScripts, renderSharePage } from "../share/render.js";
import { SHARE_ASSETS } from "../share/client.js";

const render = (md: string) => renderMarkdownDocument(md);

/** No real tag may carry an event handler, and nothing may open a script. */
function expectInert(html: string) {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<(img|iframe|svg|object|embed|style)\b/i);
  expect(html).not.toMatch(/<[a-z][^>]*\son\w+=/i);
  expect(html).not.toMatch(/href="(?!https?:|mailto:|#)/i);
}

describe("share markdown: structure", () => {
  test("headings get unique ids and anchor links; the TOC skips a lone title", () => {
    const doc = render("# Title\n\n## Intro\n\n### Detail\n\n## Intro\n\n#### Deep\n");
    expect(doc.html).toContain('<h2 id="intro">Intro<a class="anchor" href="#intro"');
    expect(doc.html).toContain('<h2 id="intro-1">');
    expect(doc.toc.map((e) => [e.level, e.id])).toEqual([
      [2, "intro"],
      [3, "detail"],
      [2, "intro-1"],
    ]);
  });

  test("frontmatter becomes a metadata card, not text", () => {
    const doc = render("---\ntitle: Plan\ntags: [a, b]\ndraft: true\nurl: https://x.example/p\n---\n# Body\n");
    expect(doc.frontmatter).toContain("<dt>title</dt><dd>Plan</dd>");
    expect(doc.frontmatter).toContain('<span class="chip">a</span><span class="chip">b</span>');
    expect(doc.frontmatter).toContain('<span class="fm-bool">true</span>');
    expect(doc.frontmatter).toContain('href="https://x.example/p"');
    expect(doc.html).not.toContain("title: Plan");
    expect(doc.html).toContain('<h1 id="body">');
  });

  test("frontmatter that is not a mapping is shown as escaped source", () => {
    const doc = render("---\n- <b>x</b>\n- : [\n---\ntext\n");
    expect(doc.frontmatter).toContain('<pre class="fm-raw">');
    expect(doc.frontmatter).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  test("a YAML alias bomb is cut off by the node budget", () => {
    const lines = ["a: &a [x, x, x, x, x, x, x, x, x, x]"];
    for (let i = 0; i < 8; i++) lines.push(`${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [*${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}]`);
    const started = performance.now();
    const doc = render(`---\n${lines.join("\n")}\n---\nok\n`);
    expect(performance.now() - started).toBeLessThan(500);
    expect(doc.frontmatter!.length).toBeLessThan(50_000);
  });

  test("GitHub callouts, task lists and footnotes", () => {
    const doc = render(
      "> [!WARNING]\n> Careful here\n\n- [x] done\n- [ ] todo\n\nSee this[^n] and again[^n].\n\n[^n]: The note.\n"
    );
    expect(doc.html).toContain('<div class="callout callout-warning"><p class="callout-title">Warning</p><p>Careful here</p>');
    expect(doc.html).toContain('<li class="task"><input type="checkbox" disabled checked> done</li>');
    expect(doc.html).toContain('<li class="task"><input type="checkbox" disabled> todo</li>');
    expect(doc.html).toContain('<sup class="fnref"><a href="#fn:n" id="fnref:n">1</a></sup>');
    expect(doc.html).toContain('id="fnref:n-2"');
    expect(doc.html).toContain('<li id="fn:n"><p>The note. <a class="fn-back" href="#fnref:n"');
    expect(doc.html).not.toContain("[^n]:");
  });

  test("math, mermaid and highlighted code are marked for the client and flagged", () => {
    const doc = render("Inline $a_1 * b_2$ and\n\n$$\n\\sum x\n$$\n\n```mermaid\ngraph TD; A-->B\n```\n\n```ts\nconst x = 1;\n```\n");
    expect(doc.html).toContain('<span class="math math-inline">a_1 * b_2</span>');
    expect(doc.html).toContain('<span class="math math-display">\\sum x</span>');
    expect(doc.html).toContain('<pre class="mermaid-src"><code>graph TD; A--&gt;B');
    expect(doc.html).toContain('<div class="code-block" data-lang="ts"><pre class="code"><code class="language-ts">');
    expect(doc.features).toEqual({ mermaid: true, math: true, highlight: true });
  });

  test("dollars in prose and in code are left alone", () => {
    const doc = render("It costs $5 and $10 today.\n\n`echo $HOME $PATH`\n\n```sh\necho $a $b\n```\n");
    expect(doc.html).not.toContain('class="math');
    expect(doc.html).toContain("<code>echo $HOME $PATH</code>");
    expect(doc.html).toContain("echo $a $b");
    expect(doc.features.math).toBe(false);
  });

  test("a plain document needs no client renderer", () => {
    expect(render("# Hi\n\nplain `code`\n\n```\nno language\n```\n").features).toEqual({
      mermaid: false,
      math: false,
      highlight: false,
    });
  });
});

describe("share markdown: nothing from the file becomes markup", () => {
  test("math, mermaid, frontmatter and footnotes are escaped text", () => {
    const doc = render(
      [
        "---",
        'title: "<script>alert(1)</script>"',
        "x: <img src=x onerror=alert(1)>",
        "---",
        "Math $<img src=x onerror=alert(1)>$ here.",
        "",
        "$$</span><script>alert(1)</script>$$",
        "",
        "```mermaid",
        'graph TD; A["<img src=x onerror=alert(1)>"]',
        "```",
        "",
        "ref[^x]",
        "",
        "[^x]: <script>alert(3)</script>",
      ].join("\n")
    );
    expectInert(doc.html);
    expectInert(doc.frontmatter!);
    expect(doc.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(doc.frontmatter).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("a hostile code-fence language is dropped", () => {
    const doc = render('```js" onmouseover="alert(1)\nx\n```\n');
    expectInert(doc.html);
    expect(doc.html).not.toContain("onmouseover=\"");
  });

  test("placeholders cannot be forged, and never land in an attribute", () => {
    const doc = render("forged \uE0000\uE001 text $x$\n\n[link](https://ok.example/$a\"b$) [frag](#sec\"tion)\n");
    expectInert(doc.html);
    expect(doc.html).not.toContain("\uE000");
    expect(doc.html).toContain("\uFFFD");
    expect(doc.html).not.toMatch(/href="[^"]*<span/);
  });

  test("only http(s), mailto and in-page fragment links survive", () => {
    const doc = render("[a](javascript:alert(1)) [b](#goals) [c](/rel) <https://ok.example> www.ok.example\n");
    expect(doc.html).toContain('<a href="#goals">b</a>');
    expect(doc.html).toContain('href="https://ok.example"');
    expect(doc.html).not.toContain("javascript:");
    expect(doc.html).not.toContain('href="/rel"');
    expectInert(doc.html);
  });
});

describe("share markdown: bounded work on hostile input", () => {
  for (const [name, input] of [
    ["lone dollars", "$a ".repeat(80_000)],
    ["unmatched backtick runs", Array.from({ length: 600 }, (_, i) => "`".repeat(i + 1)).join(" x ")],
    ["one long backtick run", "`".repeat(200_000)],
    ["unclosed frontmatter", "---\n" + "k: v\n".repeat(50_000)],
    ["many footnotes", Array.from({ length: 5_000 }, (_, i) => `r[^f${i}]`).join(" ") + "\n\n" + Array.from({ length: 5_000 }, (_, i) => `[^f${i}]: d`).join("\n")],
  ] as const) {
    test(name, () => {
      const started = performance.now();
      render(input);
      expect(performance.now() - started).toBeLessThan(1500);
    });
  }
});

describe("share page: CSP follows the document", () => {
  test("renderers are allowed only when the document uses them", () => {
    const plain = buildCsp(null, pageScripts({ kind: "markdown", doc: render("# a"), source: "# a" }));
    expect(plain).toMatch(/script-src 'sha256-[^']+' 'sha256-[^']+'(;|$)/);
    expect(plain).not.toContain("cdn.jsdelivr.net");

    const rich = buildCsp(null, pageScripts({ kind: "markdown", doc: render("$x$\n\n```mermaid\na\n```"), source: "" }));
    expect(rich).toContain(SHARE_ASSETS.mermaid.src);
    expect(rich).toContain(SHARE_ASSETS.katex.src);
    expect(rich).toContain(`style-src 'unsafe-inline' ${SHARE_ASSETS.katexCss.src}`);
    expect(rich).toContain(`font-src ${SHARE_ASSETS.katexFonts}`);
    expect(rich).not.toContain(SHARE_ASSETS.highlight.src);
    expect(rich).not.toContain("'unsafe-inline' 'sha256");

    // Error pages and other responses built without page scripts stay script-free.
    expect(buildCsp(null)).not.toContain("script-src");
  });

  test("TOC, theme picker, source view and reading time on the page", () => {
    const source = "# T\n\n## One\n\ntext\n\n## Two\n\n## Three\n";
    const page = renderSharePage({
      token: "tok",
      filename: "doc.md",
      size: source.length,
      mime: "text/markdown",
      expiresAt: new Date(Date.now() + 3_600_000),
      now: new Date(),
      viewsLeft: null,
      body: { kind: "markdown", doc: render(source), source },
    });
    expect(page).toContain('<nav class="toc" aria-label="Contents">');
    expect(page).toContain('<details class="toc-mobile">');
    expect(page).toContain('<select class="theme-select js-only" aria-label="Theme">');
    expect(page).toContain('<pre class="source" hidden># T');
    expect(page).toContain("1 min read");
    expect(page).toContain('<main class="wide">');
  });

  test("short documents get no TOC", () => {
    const source = "# T\n\n## One\n\ntext\n";
    const page = renderSharePage({
      token: "tok",
      filename: "doc.md",
      size: 1,
      mime: "text/markdown",
      expiresAt: new Date(Date.now() + 3_600_000),
      now: new Date(),
      viewsLeft: null,
      body: { kind: "markdown", doc: render(source), source },
    });
    expect(page).not.toContain('class="toc');
    expect(page).toContain("<main>");
  });
});
