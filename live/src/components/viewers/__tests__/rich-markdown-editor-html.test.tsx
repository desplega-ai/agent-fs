// Renders the real RichMarkdownEditor (MDXEditor) into a happy-dom document
// and checks what it builds from raw HTML in a markdown file. Script
// evaluation and iframe loading are off, so attribute values never run; the
// tests inspect the DOM and the markup the editor handles.
//
// Run from live/: bun test src/components/viewers/__tests__/
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

const HTML_FILE = [
  "# Control heading",
  "",
  "Plain paragraph with **bold** text.",
  "",
  '<details open ontoggle="window.__flag1 = 1">x</details>',
  "",
  '<iframe srcdoc="<script>parent.__flag2 = 1</script>"></iframe>',
  "",
  'Hover <span onmouseover="window.__flag3 = 1">here</span> please.',
  "",
].join("\n")

// Angle-bracket placeholders in prose, the pattern agents write in research
// notes. Without the mdx-jsx parser they are inline HTML to markdown.
const PLACEHOLDER_FILE = [
  "# Route notes for <org>",
  "",
  "Checked the canonical, the breadcrumb use /blog/omnia/<slug>, the sitemap lists it, and the feed links to <slug> as well.",
  "",
  "- open /file/<org>/<drive>/<path> to review",
  "- line break here<br>and after",
  "",
  "| Route        | Owner  |",
  "| ------------ | ------ |",
  "| /blog/<slug> | <team> |",
  "",
  "Keep `<slug>` in code spans as code.",
  "",
].join("\n")

// Inline HTML inside emphasis, strong and strikethrough. The editor imports
// it with the parent's formatting, so the export must write the formatting
// back around the markup instead of escaping it.
const FORMATTED_FILE = [
  "# Formatted",
  "",
  'A **<span class="notice">warning</span>** before the list.',
  "",
  "Bold run **a <slug> b**, italic *<org>*, both ***<drive>***, and struck ~~<team>~~ text.",
  "",
  "Mixed **bold *<path> in italic* tail** end.",
  "",
  "## Heading with **<slug>**",
  "",
  "See [the **<slug>** page](https://example.test/x) next.",
  "",
  "| Route         | Owner    |",
  "| ------------- | -------- |",
  "| **/b/<slug>** | *<team>* |",
  "",
].join("\n")

const SHEET_TAG = '<SwarmSheet id="7f1c2a4e-9b3d-4e61-8a0f-5c2d1e3b4a67" tab="Q4 plan" range="B2:D9" />'
const BOARD_TAG = '<SwarmBoard id="0d9b6e2a-3c41-4f8e-b7a5-91e2c6f0d384" height="400" fit="true" />'

// A report with a sheet and a board embed on their own lines.
const EMBED_FILE = [
  "# Q4 report",
  "",
  "Numbers first.",
  "",
  SHEET_TAG,
  "",
  "Then the plan board.",
  "",
  BOARD_TAG,
  "",
  "Closing **notes**.",
  "",
].join("\n")

function imageFile(html: string): string {
  return ["# Images", "", html, ""].join("\n")
}

type Root = { render(node: unknown): void; unmount(): void }
type Rendered = { editable: Element; parseErrors: number }

const roots: Root[] = []
// Every string assigned to `innerHTML` while the tests run.
const innerHtmlWrites: string[] = []
let restoreInnerHtml: (() => void) | null = null

async function waitFor<T>(fn: () => T | null | undefined, ms = 8000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - start > ms) throw new Error("timed out waiting for editor DOM")
    await new Promise(r => setTimeout(r, 25))
  }
}

async function renderEditor(content: string, ready: (editable: Element) => boolean): Promise<Rendered> {
  const React = await import("react")
  const { createRoot } = await import("react-dom/client")
  const { default: RichMarkdownEditor } = await import("../RichMarkdownEditor")

  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = createRoot(host) as Root
  roots.push(root)
  const result = { parseErrors: 0 }
  root.render(
    React.createElement(RichMarkdownEditor, {
      content,
      onSave: async () => true,
      isSaving: false,
      saveError: null,
      onClearError: () => {},
      onCancel: () => {},
      onDirtyChange: () => {},
      onParseError: () => { result.parseErrors++ },
    }),
  )
  const editable = await waitFor(() => {
    const el = host.querySelector('[contenteditable="true"]')
    return el && ready(el) ? el : null
  })
  // The parse error callback is deferred by a tick.
  await new Promise(r => setTimeout(r, 50))
  return { editable, parseErrors: result.parseErrors }
}

function scriptAttributes(root: Element): string[] {
  const hits: string[] = []
  for (const el of Array.from(root.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith("on") || name === "srcdoc") hits.push(`<${el.tagName.toLowerCase()} ${name}>`)
    }
  }
  return hits
}

beforeAll(() => {
  GlobalRegistrator.register({
    url: "http://127.0.0.1/",
    settings: {
      disableJavaScriptEvaluation: true,
      disableIframePageLoading: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
    },
  })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false

  let proto: object | null = HTMLDivElement.prototype
  while (proto && !Object.getOwnPropertyDescriptor(proto, "innerHTML")) proto = Object.getPrototypeOf(proto)
  const owner = proto!
  const original = Object.getOwnPropertyDescriptor(owner, "innerHTML")!
  Object.defineProperty(owner, "innerHTML", {
    ...original,
    set(value: string) {
      innerHtmlWrites.push(String(value))
      original.set!.call(this, value)
    },
  })
  restoreInnerHtml = () => Object.defineProperty(owner, "innerHTML", original)
})

afterAll(async () => {
  for (const root of roots) root.unmount()
  // Let React's scheduler drain before the DOM globals go away.
  await new Promise(r => setTimeout(r, 200))
  restoreInnerHtml?.()
  await GlobalRegistrator.unregister()
})

describe("RichMarkdownEditor raw HTML", () => {
  let html: Rendered

  beforeAll(async () => {
    html = await renderEditor(HTML_FILE, el => el.querySelector("h1") !== null)
  })

  test("control: editor renders the file's markdown", () => {
    expect(html.editable.querySelector("h1")?.textContent).toBe("Control heading")
    expect(html.editable.textContent).toContain("Plain paragraph with")
  })

  test("HTML attributes from the file do not reach editor DOM elements", () => {
    expect(scriptAttributes(html.editable)).toEqual([])
    expect(html.editable.querySelectorAll("iframe").length).toBe(0)
  })

  test("a file with HTML blocks reports a parse error so it opens in the source editor", () => {
    expect(html.parseErrors).toBe(1)
  })

  test("an HTML <img> tag becomes an image node with the image attributes", async () => {
    const before = innerHtmlWrites.length
    const img = await renderEditor(
      imageFile('<img src="pic.png" alt="a picture" width="40">'),
      el => el.querySelector("[data-lexical-decorator]") !== null,
    )
    expect(img.parseErrors).toBe(0)
    expect(img.editable.querySelector("h1")?.textContent).toBe("Images")
    const writes = innerHtmlWrites.slice(before).filter(v => v.includes("<img"))
    expect(writes).toEqual(['<img src="pic.png" alt="a picture" width="40">'])
    expect(scriptAttributes(img.editable)).toEqual([])
  })

  // Each of these holds markup the image node cannot keep, so the file must
  // open in the source editor instead of losing it on save.
  const unsupported: [string, string][] = [
    ["an event handler attribute", '<img src="pic.png" alt="a picture" onerror="window.__flag4 = 1">'],
    ["a text line after the tag", '<img src="pic.png" alt="x">\nA line of text'],
    ["a second tag on the next line", '<img src="a.png">\n<img src="b.png">'],
    ["a class attribute", '<img src="pic.png" class="wide">'],
    ["align and style attributes", '<img src="pic.png" align="right" style="border: 0">'],
    ["a non-numeric width", '<img src="pic.png" width="50%">'],
  ]
  for (const [name, html] of unsupported) {
    test(`an HTML <img> with ${name} reports a parse error`, async () => {
      const before = innerHtmlWrites.length
      const img = await renderEditor(imageFile(html), el => el.querySelector("h1") !== null)
      expect(img.parseErrors).toBe(1)
      expect(innerHtmlWrites.slice(before).filter(v => v.includes("<img"))).toEqual([])
      expect(scriptAttributes(img.editable)).toEqual([])
    })
  }
})

type EditorRef = { getMarkdown(): string; focus(cb?: () => void, opts?: { defaultSelection?: "rootStart" | "rootEnd" }): void; insertMarkdown(md: string): void }

// Exports the markdown MDXEditor builds from `content` with the rich editor's
// HTML settings, before any edit. MDXEditor trims the document; the rich
// editor restores the final newline the same way.
async function exportMarkdown(content: string, edit?: (editor: EditorRef) => Promise<void>): Promise<string> {
  const React = await import("react")
  const { createRoot } = await import("react-dom/client")
  const { MDXEditor, headingsPlugin, linkPlugin, listsPlugin, quotePlugin, tablePlugin } = await import("@mdxeditor/editor")
  const { htmlImagePlugin, inlineHtmlTextPlugin, swarmEmbedPlugin } = await import("../rich-markdown-html")
  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = createRoot(host) as Root
  roots.push(root)
  const ref = React.createRef<EditorRef>()
  root.render(
    React.createElement(MDXEditor, {
      ref,
      markdown: content,
      suppressHtmlProcessing: true,
      toMarkdownOptions: { bullet: "-", rule: "-" },
      plugins: [headingsPlugin(), listsPlugin(), quotePlugin(), linkPlugin(), tablePlugin(), htmlImagePlugin(), inlineHtmlTextPlugin(), swarmEmbedPlugin()],
    } as never),
  )
  await waitFor(() => host.querySelector('[contenteditable="true"] h1'))
  if (edit) await edit(ref.current!)
  return ref.current!.getMarkdown() + "\n"
}

describe("RichMarkdownEditor inline HTML placeholders", () => {
  let rendered: Rendered

  beforeAll(async () => {
    rendered = await renderEditor(PLACEHOLDER_FILE, el => el.querySelector("table") !== null)
  })

  test("a file with <slug> placeholders opens without a parse error", () => {
    expect(rendered.parseErrors).toBe(0)
  })

  test("placeholders show as literal text, not as elements", () => {
    const text = rendered.editable.textContent ?? ""
    expect(rendered.editable.querySelector("h1")?.textContent).toBe("Route notes for <org>")
    expect(text).toContain("/blog/omnia/<slug>, the sitemap")
    expect(text).toContain("/file/<org>/<drive>/<path> to review")
    expect(text).toContain("line break here<br>and after")
    expect(rendered.editable.querySelector("table")?.textContent).toContain("<team>")
    // `path` is left out: the table UI draws SVG icons with <path> elements.
    for (const tag of ["slug", "org", "drive", "team", "br"]) {
      expect(rendered.editable.querySelectorAll(tag).length).toBe(0)
    }
  })

  // happy-dom has no layout, so this guards the class; the scroll itself is
  // covered by `tests/markdown-edit.spec.ts` in a browser.
  test("the editor root is bounded to its pane so the document scrolls", () => {
    const root = rendered.editable.closest(".mdxeditor")
    expect(root?.classList.contains("flex-1")).toBe(true)
    expect(root?.classList.contains("min-h-0")).toBe(true)
    expect(rendered.editable.closest(".mdxeditor-root-contenteditable")).not.toBeNull()
  })

  test("an unedited file exports byte-equal", async () => {
    expect(await exportMarkdown(PLACEHOLDER_FILE)).toBe(PLACEHOLDER_FILE)
  })

  test("formatted inline HTML exports byte-equal", async () => {
    expect(await exportMarkdown(FORMATTED_FILE)).toBe(FORMATTED_FILE)
  })

  test("an unrelated edit saves formatted inline HTML unchanged", async () => {
    const saved = await exportMarkdown(FORMATTED_FILE, async editor => {
      await new Promise<void>(r => editor.focus(r, { defaultSelection: "rootEnd" }))
      editor.insertMarkdown("Appended line.")
    })
    expect(saved).toContain("Appended line.")
    expect(saved.replace(/\n*Appended line\.\n$/, "\n")).toBe(FORMATTED_FILE)
  })

  test("formatted inline HTML opens as text and keeps no attribute", async () => {
    const formatted = await renderEditor(FORMATTED_FILE, el => el.querySelector("h1") !== null)
    expect(formatted.parseErrors).toBe(0)
    expect(formatted.editable.textContent).toContain('<span class="notice">warning</span>')
    expect(formatted.editable.querySelectorAll("span.notice").length).toBe(0)
    expect(formatted.editable.querySelector("strong, b")?.textContent).toContain('<span class="notice">')
  })

  test("inline HTML with attributes stays text and keeps no attribute", async () => {
    const file = '# Inline\n\nHover <span onmouseover="window.__flag5 = 1" class="x">here</span> please.\n'
    const inline = await renderEditor(file, el => el.querySelector("h1") !== null)
    expect(inline.parseErrors).toBe(0)
    expect(inline.editable.textContent).toContain('<span onmouseover="window.__flag5 = 1" class="x">here</span>')
    expect(inline.editable.querySelectorAll("span[onmouseover], span.x").length).toBe(0)
    expect(scriptAttributes(inline.editable)).toEqual([])
    expect((window as { __flag5?: number }).__flag5).toBeUndefined()
    expect(await exportMarkdown(file)).toBe(file)
  })
})

describe("RichMarkdownEditor swarm embeds", () => {
  let rendered: Rendered

  beforeAll(async () => {
    rendered = await renderEditor(EMBED_FILE, el => el.querySelector("h1") !== null)
  })

  test("a file with embed lines opens in the rich editor", () => {
    expect(rendered.parseErrors).toBe(0)
  })

  test("each embed is a label, not an element made from the tag", () => {
    const labels = Array.from(rendered.editable.querySelectorAll("[data-swarm-embed]"))
    expect(labels.map(el => el.textContent)).toEqual([
      "Swarm sheet · renders live in the swarm dashboard.",
      "Swarm board · renders live in the swarm dashboard.",
    ])
    expect(rendered.editable.querySelectorAll("swarmsheet, swarmboard, swarm-embed").length).toBe(0)
  })

  test("an unedited file exports byte-equal", async () => {
    expect(await exportMarkdown(EMBED_FILE)).toBe(EMBED_FILE)
  })

  test("an edit to a prose line saves both tag lines byte-for-byte", async () => {
    const saved = await exportMarkdown(EMBED_FILE, async editor => {
      await new Promise<void>(r => editor.focus(r, { defaultSelection: "rootEnd" }))
      editor.insertMarkdown("Appended line.")
    })
    expect(saved).toContain("Appended line.")
    expect(saved.split("\n")).toContain(SHEET_TAG)
    expect(saved.split("\n")).toContain(BOARD_TAG)
    expect(saved.replace(/\n*Appended line\.\n$/, "\n")).toBe(EMBED_FILE)
  })

  test("a tag in a block quote exports byte-equal", async () => {
    const quoted = ["# Nested", "", "> Quoted.", ">", `> ${SHEET_TAG}`, ""].join("\n")
    expect(await exportMarkdown(quoted)).toBe(quoted)
  })

  // The list writer normalizes a loose item's spacing, as it does for any
  // list; the tag itself comes back unchanged.
  test("a tag in a list item keeps its text", async () => {
    const listed = ["# Nested", "", "- item", "", `  ${BOARD_TAG}`, ""].join("\n")
    const saved = await exportMarkdown(listed)
    expect(saved.split("\n").map(line => line.trim())).toContain(BOARD_TAG)
  })

  test("a tag inside a paragraph stays inline text and round-trips", async () => {
    const file = `# Inline\n\nUse ${SHEET_TAG} to embed.\n`
    const inline = await renderEditor(file, el => el.querySelector("h1") !== null)
    expect(inline.parseErrors).toBe(0)
    expect(inline.editable.querySelectorAll("[data-swarm-embed]").length).toBe(0)
    expect(inline.editable.textContent).toContain(SHEET_TAG)
    expect(await exportMarkdown(file)).toBe(file)
  })

  // Anything that is not a valid tag keeps today's behaviour: the import
  // fails and the file opens in the source editor.
  const refused: [string, string][] = [
    ["an unknown attribute", '<SwarmSheet id="7f1c2a4e-9b3d-4e61-8a0f-5c2d1e3b4a67" onload="window.__flag6 = 1" />'],
    ["an expression", "<SwarmSheet id={uuid} />"],
    ["a missing id", "<SwarmBoard />"],
    ["another HTML block", "<details>x</details>"],
  ]
  for (const [name, tag] of refused) {
    test(`a block tag with ${name} reports a parse error`, async () => {
      const file = ["# Refused", "", "Prose.", "", tag, ""].join("\n")
      const result = await renderEditor(file, el => el.querySelector("h1") !== null)
      expect(result.parseErrors).toBe(1)
      expect(result.editable.querySelectorAll("[data-swarm-embed]").length).toBe(0)
      expect(scriptAttributes(result.editable)).toEqual([])
      expect((window as { __flag6?: number }).__flag6).toBeUndefined()
    })
  }
})
