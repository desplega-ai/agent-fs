// `<SwarmSheet id="…" />` and `<SwarmBoard id="…" />` in Markdown files. The
// swarm dashboard renders them live; live shows a placeholder and keeps the
// line byte-for-byte in the rich editor.
//
// The tag is data: never JSX, never evaluated, never raw HTML. A remark plugin
// recognises it on a whole HTML block and replaces the node before anything
// can turn it into an element.
//
// shortcut: this grammar is duplicated in the agent-swarm dashboard
// (`apps/ui/src/lib/markdown/swarm-embed.ts`), kept in step by the shared
// fixture `swarm-embed-cases.json`; extract a package when a third consumer
// appears.

export type SwarmEmbedTag = "SwarmSheet" | "SwarmBoard"

export interface SwarmEmbedProps {
  id: string
  tab?: string
  range?: string
  height?: number
  readonly?: boolean
  fit?: boolean
}

export type SwarmEmbedMatch =
  | { status: "embed"; tag: SwarmEmbedTag; props: SwarmEmbedProps }
  // The text is the shape of a tag but breaks a rule. `error` is the exact
  // message the dashboard shows in its error chip.
  | { status: "invalid"; tag: SwarmEmbedTag; error: string }
  // Not a tag: some other HTML, which stays whatever it is today.
  | { status: "none" }

const MAX_TAG_LENGTH = 512
const TAG_PATTERN = /^<(SwarmSheet|SwarmBoard)((?:\s+[a-z][a-zA-Z]{0,19}="[^"<>&{}\n]{0,200}")*)\s*\/>$/
const ATTRIBUTE_PATTERN = /\s+([a-z][a-zA-Z]{0,19})="([^"<>&{}\n]{0,200})"/g

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// A cell (`B2`), a range (`A1:C10`) or whole columns (`A:C`).
const RANGE = /^(?:[A-Z]{1,3}[1-9][0-9]{0,6}(?::[A-Z]{1,3}[1-9][0-9]{0,6})?|[A-Z]{1,3}:[A-Z]{1,3})$/

const ALLOWED: Record<SwarmEmbedTag, readonly string[]> = {
  SwarmSheet: ["id", "tab", "range", "height", "readonly"],
  SwarmBoard: ["id", "height", "readonly", "fit"],
}

/** Checks one attribute value. Returns the typed value, or the reason it is wrong. */
function readValue(name: string, raw: string): { value: string | number | boolean } | { error: string } {
  switch (name) {
    case "id":
      return UUID.test(raw) ? { value: raw } : { error: "id must be a uuid" }
    case "tab":
      return raw.length >= 1 && raw.length <= 100 ? { value: raw } : { error: "tab must be 1 to 100 characters" }
    case "range":
      return RANGE.test(raw) ? { value: raw } : { error: "range must be an A1 range" }
    case "height": {
      const height = /^[0-9]{1,4}$/.test(raw) ? Number(raw) : NaN
      return height >= 160 && height <= 1200 ? { value: height } : { error: "height must be an integer from 160 to 1200" }
    }
    case "readonly":
      return raw === "true" || raw === "false" ? { value: raw === "true" } : { error: 'readonly must be "true" or "false"' }
    default: // fit: the only attribute left after the allow list
      return raw === "true" ? { value: true } : { error: 'fit must be "true"' }
  }
}

/**
 * Reads the value of one `html` mdast node as a swarm embed tag. The caller
 * passes only block-level HTML (see {@link remarkSwarmEmbed}).
 */
export function matchSwarmEmbed(html: string): SwarmEmbedMatch {
  const text = html.trim()
  if (text.length > MAX_TAG_LENGTH) return { status: "none" }
  const match = TAG_PATTERN.exec(text)
  if (!match) return { status: "none" }
  const tag = match[1] as SwarmEmbedTag
  const invalid = (reason: string): SwarmEmbedMatch => ({ status: "invalid", tag, error: `Invalid ${tag} tag: ${reason}` })

  const props: Record<string, string | number | boolean> = {}
  for (const [, name, raw] of match[2].matchAll(ATTRIBUTE_PATTERN)) {
    if (!ALLOWED[tag].includes(name)) return invalid(`unknown attribute \`${name}\``)
    if (name in props) return invalid(`duplicate attribute \`${name}\``)
    const read = readValue(name, raw)
    if ("error" in read) return invalid(read.error)
    props[name] = read.value
  }
  if (!("id" in props)) return invalid("id is required")
  return { status: "embed", tag, props: props as unknown as SwarmEmbedProps }
}

// ---- remark plugin ----

interface MdastNode {
  type: string
  value?: string
  children?: MdastNode[]
  data?: { hName?: string; hProperties?: Record<string, string> }
}

// Parents whose children are inline text. Raw HTML under one of them is not a
// block, so a tag there is not an embed.
const PHRASING_PARENTS = new Set([
  "paragraph", "heading", "emphasis", "strong", "delete", "link", "linkReference", "tableCell",
])

/** The hast element a valid tag becomes; the viewer's components map renders it. */
export const SWARM_EMBED_ELEMENT = "swarm-embed"

function toHastProperties(tag: SwarmEmbedTag, props: SwarmEmbedProps): Record<string, string> {
  const properties: Record<string, string> = {
    dataKind: tag === "SwarmSheet" ? "sheet" : "board",
    dataObjectId: props.id,
  }
  if (props.tab !== undefined) properties.dataTab = props.tab
  if (props.range !== undefined) properties.dataRange = props.range
  if (props.height !== undefined) properties.dataHeight = String(props.height)
  if (props.readonly !== undefined) properties.dataReadonly = String(props.readonly)
  if (props.fit !== undefined) properties.dataFit = String(props.fit)
  return properties
}

/**
 * The embed a `swarm-embed` element stands for, read back from its rendered
 * `data-*` props with the same checks as the Markdown text. `null` when
 * anything is off, so a hand-built element cannot pass bad values on.
 */
export function embedFromElementProps(props: Record<string, unknown>): { tag: SwarmEmbedTag; props: SwarmEmbedProps } | null {
  const tag = props["data-kind"] === "sheet" ? "SwarmSheet" : props["data-kind"] === "board" ? "SwarmBoard" : null
  if (!tag) return null
  const attributes = [
    ["id", props["data-object-id"]],
    ["tab", props["data-tab"]],
    ["range", props["data-range"]],
    ["height", props["data-height"]],
    ["readonly", props["data-readonly"]],
    ["fit", props["data-fit"]],
  ].flatMap(([name, value]) => (typeof value === "string" ? [`${name}="${value}"`] : []))
  const match = matchSwarmEmbed(`<${tag} ${attributes.join(" ")} />`)
  return match.status === "embed" ? { tag: match.tag, props: match.props } : null
}

/**
 * Replaces each block-level `<SwarmSheet … />` and `<SwarmBoard … />` HTML
 * node with a `swarm-embed` element. Every other HTML node, and every tag
 * that is not valid, is left alone: it shows as text, as it does today.
 */
export function remarkSwarmEmbed() {
  const visit = (parent: MdastNode) => {
    if (!parent.children || PHRASING_PARENTS.has(parent.type)) return
    for (const node of parent.children) {
      if (node.type === "html" && typeof node.value === "string") {
        const match = matchSwarmEmbed(node.value)
        if (match.status === "embed") {
          // An unknown node type with a `hName` becomes that element; `value`
          // is dropped so the text cannot reach the output.
          node.type = "swarmEmbed"
          delete node.value
          node.data = { hName: SWARM_EMBED_ELEMENT, hProperties: toHastProperties(match.tag, match.props) }
        }
      } else {
        visit(node)
      }
    }
  }
  return (tree: MdastNode) => visit(tree)
}

/**
 * The swarm dashboard's view of a drive file, on the org's swarm host. `null`
 * when the org has no swarm URL or it is not an http(s) URL.
 */
export function swarmFileHref(swarmUrl: string | null | undefined, orgId: string, driveId: string, path: string): string | null {
  if (!swarmUrl) return null
  let base: URL
  try {
    base = new URL(swarmUrl)
  } catch {
    return null
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return null
  const filePath = path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/")
  return `${base.href.replace(/\/+$/, "")}/file/~/${encodeURIComponent(orgId)}/${encodeURIComponent(driveId)}/${filePath}`
}
