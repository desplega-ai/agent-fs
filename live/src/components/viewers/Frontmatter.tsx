import { Fragment } from "react"
import { parse } from "yaml"
import { cn } from "@/lib/utils"

// A Map keeps the file's key order; an object would move keys like "2" first.
type FrontmatterRecord = Map<unknown, unknown>

/**
 * Split leading YAML frontmatter (between `---` lines) from the markdown body.
 * `frontmatter` is the parsed mapping, or the raw block text when it is not
 * valid YAML or not a mapping, or null when there is none.
 */
export function extractFrontmatter(content: string): { frontmatter: FrontmatterRecord | string | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (!match) return { frontmatter: null, body: content }
  const body = content.slice(match[0].length)
  let data: unknown
  try {
    data = parse(match[1], { logLevel: "error", mapAsMap: true })
  } catch {
    return { frontmatter: match[1], body }
  }
  if (data === null || data === undefined) return { frontmatter: null, body }
  if (!(data instanceof Map)) return { frontmatter: match[1], body }
  return { frontmatter: data.size ? data : null, body }
}

const KEY_CLASS = "text-[11px] font-medium uppercase leading-5 tracking-wide text-muted-foreground"

const isObject = (value: unknown) => typeof value === "object" && value !== null

/** A map of plain values: shown inline as `a 1 · b 2`. */
const isFlatMap = (value: unknown): value is FrontmatterRecord =>
  value instanceof Map && Array.from(value.values()).every(v => !isObject(v))

/** A list item shown on one line: a map of plain values and flat maps. */
const isLineItem = (value: unknown): value is FrontmatterRecord =>
  value instanceof Map && Array.from(value.values()).every(v => !isObject(v) || isFlatMap(v))

/** Fits on its key's line: a plain value, a flat list (chips) or a flat map. */
const isInline = (value: unknown) =>
  !isObject(value) || isFlatMap(value) || (Array.isArray(value) && !value.some(isObject))

/**
 * Keys and values in two columns. Below the top level (and at the top level on
 * a phone), a value that needs its own lines goes under its key, one plain
 * indent in.
 */
function MapGrid({ data, top = false }: { data: FrontmatterRecord; top?: boolean }) {
  return (
    <dl className={cn("grid grid-cols-[max-content_minmax(0,1fr)]", top ? "gap-x-4 gap-y-2" : "gap-x-3 gap-y-1")}>
      {Array.from(data, ([key, value], i) => {
        const block = !isInline(value)
        return (
          <Fragment key={i}>
            <dt className={cn(KEY_CLASS, block && (top ? "max-sm:col-span-2" : "col-span-2"))}>{String(key)}</dt>
            <dd className={cn("min-w-0", block && (top ? "max-sm:col-span-2 max-sm:pl-4" : "col-span-2 pl-4"))}>
              <FrontmatterValueDisplay value={value} />
            </dd>
          </Fragment>
        )
      })}
    </dl>
  )
}

/** `key value · key value` on one wrapping line; a flat map value nests the same way. */
function Pairs({ data }: { data: FrontmatterRecord }) {
  return (
    <span className="break-words">
      {Array.from(data, ([key, value], i) => (
        <Fragment key={i}>
          {i > 0 && <span className="text-muted-foreground"> · </span>}
          {value instanceof Map && value.size > 0 ? (
            <>
              <span className="text-muted-foreground">{String(key)}</span> <Pairs data={value} />
            </>
          ) : (
            // A pair moves to the next line as a unit; it only breaks inside when longer than the line.
            <span className="inline-block max-w-full align-top">
              <span className="text-muted-foreground">{String(key)}</span> <FrontmatterValueDisplay value={value} />
            </span>
          )}
        </Fragment>
      ))}
    </span>
  )
}

function FrontmatterValueDisplay({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground italic">null</span>
  }
  if ((Array.isArray(value) && value.length === 0) || (value instanceof Map && value.size === 0)) {
    return <span className="text-muted-foreground italic">empty</span>
  }
  if (value instanceof Map) return isFlatMap(value) ? <Pairs data={value} /> : <MapGrid data={value} />
  if (Array.isArray(value)) {
    if (value.some(isObject)) {
      return (
        <ul className="list-disc space-y-1 pl-4 marker:text-muted-foreground">
          {value.map((item, i) => (
            <li key={i}>
              {isLineItem(item) && item.size > 0 ? <Pairs data={item} /> : <FrontmatterValueDisplay value={item} />}
            </li>
          ))}
        </ul>
      )
    }
    return (
      <div className="flex flex-wrap gap-1.5">
        {value.map((item, i) => (
          <span
            key={i}
            className="inline-flex rounded-md bg-accent px-1.5 py-0.5 text-xs text-foreground"
          >
            {item === null ? "null" : String(item)}
          </span>
        ))}
      </div>
    )
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return <span className="font-mono text-xs">{String(value)}</span>
  }
  return <span className="break-words">{String(value)}</span>
}

export function FrontmatterBlock({ data }: { data: FrontmatterRecord | string }) {
  return (
    <div className="not-prose mb-6 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
      {typeof data === "string" ? (
        <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{data}</pre>
      ) : (
        <MapGrid data={data} top />
      )}
    </div>
  )
}
