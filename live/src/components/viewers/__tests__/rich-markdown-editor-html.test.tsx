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

const IMAGE_FILE = [
  "# Images",
  "",
  '<img src="pic.png" alt="a picture" width="40" onerror="window.__flag4 = 1">',
  "",
].join("\n")

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

  test("an HTML <img> tag becomes an image node with only the image attributes", async () => {
    const before = innerHtmlWrites.length
    const img = await renderEditor(IMAGE_FILE, el => el.querySelector("[data-lexical-decorator]") !== null)
    expect(img.parseErrors).toBe(0)
    expect(img.editable.querySelector("h1")?.textContent).toBe("Images")
    const writes = innerHtmlWrites.slice(before).filter(v => v.includes("<img"))
    expect(writes).toEqual(['<img src="pic.png" alt="a picture" width="40">'])
    expect(scriptAttributes(img.editable)).toEqual([])
  })
})
