import type { AgentFsClient } from "@/api/client"
import type { HealthResponse } from "./upload-limit"

export const HTML_SITES_FEATURE = "html-sites"

/** localStorage key of the per-folder site share cache. */
export const SITE_TOKENS_KEY = "liveui:site-tokens"
/** localStorage key of the drive-root HTML files the user agreed to render. */
export const HTML_ROOT_OK_KEY = "liveui:html-root-ok"

/**
 * Page scripts can read the site token from `location`, so the viewer's share
 * lives only 15 minutes. That bounds the damage if a page sends it out.
 */
export const VIEWER_SITE_TTL_SECONDS = 900
/** A cached share with less than this left is replaced by a new one. */
export const REMINT_BEFORE_MS = 3 * 60_000

/** Servers that serve `/site/<token>/` say so in `/health`. Older servers show HTML as source. */
export function supportsHtmlSites(health?: HealthResponse): boolean {
  return health?.features?.includes(HTML_SITES_FEATURE) === true
}

export function isHtmlPath(path: string): boolean {
  const name = path.split("/").pop() ?? ""
  const dot = name.lastIndexOf(".")
  const ext = dot === -1 ? "" : name.slice(dot + 1).toLowerCase()
  return ext === "html" || ext === "htm"
}

/** The folder of a file, normalized like a drive path: `/` for the root, `/a/b` when nested. */
export function folderOf(path: string): string {
  const parts = path.split("/").filter(Boolean)
  parts.pop()
  return `/${parts.join("/")}`
}

export function fileNameOf(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? ""
}

/**
 * The URL of `fileName` inside a site share. `sharePath` is `/site/<token>/`.
 * Each segment of the name is percent-encoded, so spaces, `#` and `?` stay part
 * of the path and unicode survives.
 */
export function siteUrlFor(endpoint: string, sharePath: string, fileName: string): string {
  const base = `${endpoint.replace(/\/+$/, "")}${sharePath.endsWith("/") ? sharePath : `${sharePath}/`}`
  return base + fileName.split("/").filter(Boolean).map(encodeURIComponent).join("/")
}

type KeyValueStorage = Pick<Storage, "getItem" | "setItem">

/** Injectable for tests. Defaults to `localStorage`, `fetch` and `Date.now`. */
export interface HtmlViewDeps {
  storage?: KeyValueStorage | null
  fetch?: (url: string, init: RequestInit) => Promise<Pick<Response, "status">>
  now?: () => number
}

interface SiteTokenEntry {
  /** The site's base URL, `<endpoint>/site/<token>/`. */
  url: string
  /** Epoch milliseconds. */
  expiresAt: number
}

/** Mints in flight, by cache key; resolve to the site's base URL. */
const inflightMints = new Map<string, Promise<string>>()

function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function readJson<T extends object>(storage: KeyValueStorage | null, key: string): T {
  try {
    const raw = storage?.getItem(key)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : ({} as T)
  } catch {
    return {} as T
  }
}

function writeJson(storage: KeyValueStorage | null, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value))
  } catch {
    // ignore quota / privacy errors
  }
}

/** Read the cache with expired entries dropped (and the drop persisted). */
function readSiteTokens(storage: KeyValueStorage | null, now: number): Record<string, SiteTokenEntry> {
  const cache = readJson<Record<string, SiteTokenEntry>>(storage, SITE_TOKENS_KEY)
  let dropped = false
  for (const [key, entry] of Object.entries(cache)) {
    if (!entry || typeof entry.url !== "string" || !(entry.expiresAt > now)) {
      delete cache[key]
      dropped = true
    }
  }
  if (dropped) writeJson(storage, SITE_TOKENS_KEY, cache)
  return cache
}

export function siteCacheKey(endpoint: string, orgId: string, driveId: string, folder: string): string {
  return `${endpoint.replace(/\/+$/, "")}/${orgId}/${driveId}${folder}`
}

async function headStatus(deps: HtmlViewDeps, url: string): Promise<number | null> {
  const doFetch = deps.fetch ?? globalThis.fetch
  try {
    return (await doFetch(url, { method: "HEAD", cache: "no-store" })).status
  } catch {
    // Unreachable right now: keep the cached link; the frame shows the failure.
    return null
  }
}

/**
 * The iframe URL for an HTML file: the file inside a site share of its folder,
 * so relative paths resolve. Shares are cached per folder in localStorage, so
 * reloads and other tabs reuse them. A cached share is checked with `HEAD`
 * first, because the parent page cannot see the status of a cross-origin frame
 * load: a revoked or expired one (404/410) is dropped and minted again once.
 */
export async function resolveHtmlViewUrl(
  client: Pick<AgentFsClient, "endpoint" | "createShare">,
  orgId: string,
  driveId: string,
  path: string,
  deps: HtmlViewDeps = {},
): Promise<string> {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage
  const now = deps.now ?? Date.now
  const folder = folderOf(path)
  const fileName = fileNameOf(path)
  const key = siteCacheKey(client.endpoint, orgId, driveId, folder)

  const hit = readSiteTokens(storage, now())[key]
  if (hit && hit.expiresAt - now() > REMINT_BEFORE_MS) {
    const url = siteUrlFor(hit.url, "/", fileName)
    const status = await headStatus(deps, url)
    if (status !== 404 && status !== 410) return url
  }

  // Views that start together (two files of one folder, React's dev double
  // effect) share one mint.
  let minting = inflightMints.get(key)
  if (!minting) {
    minting = (async () => {
      const result = await client.createShare(orgId, driveId, folder, { expiresIn: VIEWER_SITE_TTL_SECONDS })
      const mintedAt = now()
      const expiresAt = Date.parse(result.expiresAt)
      const entry: SiteTokenEntry = {
        url: siteUrlFor(client.endpoint, result.sharePath, ""),
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : mintedAt + result.expiresIn * 1000,
      }
      // Re-read so a share minted meanwhile by another tab for another folder is kept.
      const cache = readSiteTokens(storage, mintedAt)
      cache[key] = entry
      writeJson(storage, SITE_TOKENS_KEY, cache)
      return entry.url
    })().finally(() => inflightMints.delete(key))
    inflightMints.set(key, minting)
  }
  return siteUrlFor(await minting, "/", fileName)
}

function rootOkKey(orgId: string, driveId: string, path: string): string {
  return `${orgId}/${driveId}/${path.replace(/^\/+/, "")}`
}

/** True once the user chose Render for this drive-root HTML file. */
export function isRootHtmlApproved(orgId: string, driveId: string, path: string, storage = defaultStorage()): boolean {
  return readJson<Record<string, boolean>>(storage, HTML_ROOT_OK_KEY)[rootOkKey(orgId, driveId, path)] === true
}

export function approveRootHtml(orgId: string, driveId: string, path: string, storage = defaultStorage()): void {
  const approved = readJson<Record<string, boolean>>(storage, HTML_ROOT_OK_KEY)
  approved[rootOkKey(orgId, driveId, path)] = true
  writeJson(storage, HTML_ROOT_OK_KEY, approved)
}
