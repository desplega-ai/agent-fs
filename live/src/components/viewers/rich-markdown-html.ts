import {
  addExportVisitor$,
  addImportVisitor$,
  addLexicalNode$,
  IS_BOLD,
  IS_CODE,
  IS_HIGHLIGHT,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  IS_SUBSCRIPT,
  IS_SUPERSCRIPT,
  IS_UNDERLINE,
  realmPlugin,
  UnrecognizedMarkdownConstructError,
  type LexicalExportVisitor,
  type MdastImportVisitor,
} from "@mdxeditor/editor"
import { $isTextNode, TextNode, type LexicalNode, type NodeKey, type SerializedTextNode } from "lexical"

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

// Mdast parents whose children are inline (phrasing) content. Raw HTML under
// any other parent is an HTML block.
const PHRASING_PARENTS = new Set([
  "paragraph", "heading", "emphasis", "strong", "delete", "link", "linkReference", "tableCell",
])

/**
 * Inline raw HTML (`<slug>`, `<br>`, `<span …>`) shown as literal text. It
 * never becomes an HTML element in the editor, so none of its attributes
 * reach the DOM. The node is a token: it is kept, moved or deleted as a
 * whole, and writes back as the exact markup it was read from (a plain text
 * node would come back escaped, `\<slug>`).
 */
export class RawHtmlTextNode extends TextNode {
  static getType(): string {
    return "raw-html-text"
  }

  static clone(node: RawHtmlTextNode): RawHtmlTextNode {
    return new RawHtmlTextNode(node.__text, node.__key)
  }

  static importJSON(serializedNode: SerializedTextNode): RawHtmlTextNode {
    return $createRawHtmlTextNode(serializedNode.text).updateFromJSON(serializedNode)
  }

  constructor(text = "", key?: NodeKey) {
    super(text, key)
  }
}

export function $createRawHtmlTextNode(text: string): RawHtmlTextNode {
  return new RawHtmlTextNode(text).setMode("token")
}

export function $isRawHtmlTextNode(node: LexicalNode | null | undefined): node is RawHtmlTextNode {
  return node instanceof RawHtmlTextNode
}

// Runs after `htmlImageVisitor` (whose `testNode` it excludes anyway). HTML
// blocks go on to the next visitor, so they still fail the import and the
// file opens in the source editor.
const inlineHtmlVisitor: MdastImportVisitor<MdastHtml> = {
  testNode: (node) => node.type === "html" && !node.value.trim().startsWith("<img"),
  priority: 50,
  visitNode({ mdastNode, mdastParent, actions }) {
    if (!mdastParent || !PHRASING_PARENTS.has(mdastParent.type)) {
      actions.nextVisitor()
      return
    }
    const node = $createRawHtmlTextNode(mdastNode.value)
    node.setFormat(actions.getParentFormatting())
    actions.addAndStepInto(node)
  },
}

type ExportParams = Parameters<NonNullable<LexicalExportVisitor<TextNode, MdastNode>["visitLexicalNode"]>>[0]
type MdastParent = ExportParams["mdastParent"]

// The mdast wrapper each text format writes, in the order MDXEditor's text
// visitor opens them (`u`, `sup` and `sub` are JSX elements there too).
const FORMAT_WRAPPERS: [number, () => MdastParent][] = [
  [IS_UNDERLINE, () => ({ type: "mdxJsxTextElement", name: "u", children: [], attributes: [] }) as never],
  [IS_SUPERSCRIPT, () => ({ type: "mdxJsxTextElement", name: "sup", children: [], attributes: [] }) as never],
  [IS_SUBSCRIPT, () => ({ type: "mdxJsxTextElement", name: "sub", children: [], attributes: [] }) as never],
  [IS_ITALIC, () => ({ type: "emphasis", children: [] })],
  [IS_BOLD, () => ({ type: "strong", children: [] })],
  [IS_STRIKETHROUGH, () => ({ type: "delete", children: [] })],
  [IS_HIGHLIGHT, () => ({ type: "highlight", children: [] }) as never],
]

function wrapperFormat(node: MdastNode | undefined): number {
  if (!node) return 0
  switch (node.type) {
    case "emphasis": return IS_ITALIC
    case "strong": return IS_BOLD
    case "delete": return IS_STRIKETHROUGH
    case "highlight" as string: return IS_HIGHLIGHT
    case "mdxJsxTextElement": {
      const el = node as { name?: string; attributes?: unknown[] }
      if (el.attributes?.length) return 0
      return el.name === "u" ? IS_UNDERLINE : el.name === "sup" ? IS_SUPERSCRIPT : el.name === "sub" ? IS_SUBSCRIPT : 0
    }
    default: return 0
  }
}

/**
 * Appends `leaf` under the wrappers for `lexicalNode`'s format. Formats it
 * shares with the previous sibling continue the wrappers that sibling opened,
 * in whatever order they nest; MDXEditor's text visitor reopens them in a
 * fixed order, which splits `**a *<x> b* c**` once a token node sits between
 * two text nodes.
 */
function appendFormatted({ lexicalNode, mdastParent, actions }: ExportParams, leaf: MdastNode): void {
  const previous = lexicalNode.getPreviousSibling()
  const format = lexicalNode.getFormat()
  let shared = ($isTextNode(previous) ? previous.getFormat() : 0) & format
  let open = format
  let parent = mdastParent
  for (;;) {
    const last = parent.children.at(-1) as MdastNode | undefined
    const flag = wrapperFormat(last)
    if (!(shared & flag)) break
    parent = last as MdastParent
    shared &= ~flag
    open &= ~flag
  }
  for (const [flag, wrapper] of FORMAT_WRAPPERS) {
    if (open & flag) parent = actions.appendToParent(parent, wrapper() as never) as MdastParent
  }
  actions.appendToParent(parent, leaf as never)
}

function followsRawHtml(node: TextNode): boolean {
  for (let prev = node.getPreviousSibling(); prev; prev = prev.getPreviousSibling()) {
    if ($isRawHtmlTextNode(prev)) return true
  }
  return false
}

// Writes a raw HTML token back as the markup it was read from, inside its
// formatting (`**<span class="notice">warning</span>**`), and writes the text
// nodes after a token in the same paragraph with the same nesting logic.
// Code and styled text go to MDXEditor's text visitor: code writes the token
// as an inline code span, which is what the user asked for. shortcut: a
// styled token saves escaped; the editor has no style control, upgrade if one
// is added.
const rawHtmlTextExportVisitor: LexicalExportVisitor<TextNode, MdastNode> = {
  testLexicalNode: (node): node is TextNode =>
    $isRawHtmlTextNode(node) || ($isTextNode(node) && followsRawHtml(node)),
  priority: 50,
  visitLexicalNode(params) {
    const { lexicalNode, actions } = params
    if (lexicalNode.getFormat() & IS_CODE || lexicalNode.getStyle() !== "") {
      actions.nextVisitor()
      return
    }
    const value = lexicalNode.getTextContent()
    appendFormatted(params, $isRawHtmlTextNode(lexicalNode) ? { type: "html", value } : { type: "text", value })
  },
}

/** Registers {@link RawHtmlTextNode} and its import and export visitors. */
export const inlineHtmlTextPlugin = realmPlugin({
  init(realm) {
    realm.pubIn({
      [addLexicalNode$]: RawHtmlTextNode,
      [addImportVisitor$]: inlineHtmlVisitor,
      [addExportVisitor$]: rawHtmlTextExportVisitor,
    })
  },
})
