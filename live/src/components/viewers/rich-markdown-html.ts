import {
  addImportVisitor$,
  realmPlugin,
  UnrecognizedMarkdownConstructError,
  type MdastImportVisitor,
} from "@mdxeditor/editor"

// The mdast node types, taken from MDXEditor's own signature.
type MdastNode = Parameters<Exclude<MdastImportVisitor<never>["testNode"], string>>[0]
type MdastHtml = Extract<MdastNode, { type: "html" }>

// Attributes the rich editor's image node keeps from an HTML `<img>` tag.
const IMAGE_ATTRIBUTES = ["src", "alt", "title", "width", "height"] as const

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * Rebuilds an HTML `<img>` tag from the attributes the image node uses. The
 * markup is parsed with `DOMParser`, whose document is inert: nothing loads
 * and no handler runs. Returns `null` unless the markup is exactly one `<img>`
 * (whitespace around it is fine) carrying only {@link IMAGE_ATTRIBUTES}, with
 * a numeric `width`/`height`. Anything else would be lost on save, so the
 * caller fails the import and the file opens in the source editor.
 */
export function cleanHtmlImageTag(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html")
  if (doc.head.childNodes.length > 0) return null
  const nodes = Array.from(doc.body.childNodes).filter(
    (node) => !(node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() === ""),
  )
  const img = nodes[0]
  if (nodes.length !== 1 || !(img instanceof Element) || img.tagName !== "IMG") return null
  const allowed: readonly string[] = IMAGE_ATTRIBUTES
  if (!img.getAttributeNames().every((name) => allowed.includes(name))) return null
  for (const name of ["width", "height"]) {
    const value = img.getAttribute(name)
    if (value !== null && !/^\d+$/.test(value.trim())) return null
  }
  const attrs = IMAGE_ATTRIBUTES.flatMap((name) => {
    const value = img.getAttribute(name)
    return value === null ? [] : [`${name}="${escapeAttribute(value)}"`]
  })
  return `<img ${attrs.join(" ")}>`
}

// MDXEditor's own HTML image visitor reads the tag through `innerHTML` on an
// element of the page document, which keeps every attribute of the source
// markup. This visitor runs first and hands it a rebuilt tag instead. Its
// `testNode` matches the same nodes as MDXEditor's, so none reach it unchecked.
const htmlImageVisitor: MdastImportVisitor<MdastHtml> = {
  testNode: (node) => node.type === "html" && node.value.trim().startsWith("<img"),
  priority: 100,
  visitNode({ mdastNode, actions }) {
    const tag = cleanHtmlImageTag(mdastNode.value)
    // MDXEditor reports only its own import errors through `onError`; any
    // other error escapes the import and breaks the editor.
    if (!tag) throw new UnrecognizedMarkdownConstructError(`Unsupported HTML image: ${mdastNode.value}`)
    mdastNode.value = tag
    actions.nextVisitor()
  },
}

/** Registers {@link htmlImageVisitor}. Pair it with `suppressHtmlProcessing`. */
export const htmlImagePlugin = realmPlugin({
  init(realm) {
    realm.pub(addImportVisitor$, htmlImageVisitor)
  },
})
