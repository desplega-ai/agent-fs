import { addImportVisitor$, realmPlugin, type MdastImportVisitor } from "@mdxeditor/editor"

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
 * tag is parsed with `DOMParser`, whose document is inert: nothing loads and
 * no handler runs. Returns `null` when the markup holds no `<img>`.
 */
export function cleanHtmlImageTag(html: string): string | null {
  const img = new DOMParser().parseFromString(html, "text/html").querySelector("img")
  if (!img) return null
  const attrs = IMAGE_ATTRIBUTES.flatMap((name) => {
    const value = img.getAttribute(name)
    return value === null ? [] : [`${name}="${escapeAttribute(value)}"`]
  })
  return `<img ${attrs.join(" ")}>`
}

// MDXEditor's own HTML image visitor reads the tag through `innerHTML` on an
// element of the page document, which keeps every attribute of the source
// markup. This visitor runs first and hands it a rebuilt tag instead.
const htmlImageVisitor: MdastImportVisitor<MdastHtml> = {
  testNode: (node) => node.type === "html" && node.value.trim().startsWith("<img"),
  priority: 100,
  visitNode({ mdastNode, actions }) {
    const tag = cleanHtmlImageTag(mdastNode.value)
    if (!tag) throw new Error("Invalid HTML image")
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
