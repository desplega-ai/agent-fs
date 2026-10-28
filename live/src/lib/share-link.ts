import type { AgentFsClient, ShareCreateResult } from "@/api/client"
import { toast } from "@/stores/toast"
import type { HealthResponse } from "./upload-limit"

export const SHARE_LINKS_FEATURE = "share-links"

/** Expiry choices offered when sharing. The server allows 60 seconds to 7 days. */
export const SHARE_EXPIRY_CHOICES = [
  { label: "1 hour", seconds: 3600 },
  { label: "24 hours", seconds: 86_400 },
  { label: "3 days", seconds: 259_200 },
  { label: "7 days", seconds: 604_800 },
] as const

/** The server's own default, so a share without a choice behaves the same. */
export const DEFAULT_SHARE_EXPIRY_SECONDS = 86_400

/**
 * Servers that can mint public share links say so in `/health`. Older servers
 * omit the field, so an unreachable or older server hides the action instead of
 * offering a button that can only fail.
 */
export function supportsShareLinks(health?: HealthResponse): boolean {
  return health?.features?.includes(SHARE_LINKS_FEATURE) === true
}

/** share-create returned something no link can be built from: nothing is copied. */
export class InvalidShareResponseError extends Error {}

// The routes the server mints: `/share/<token>` for a file, `/site/<token>/`
// for a folder (the slash is part of it: the site's relative paths need it).
// Tokens are base64url.
const SHARE_PATH = /^\/(?:share\/[A-Za-z0-9_-]+|site\/[A-Za-z0-9_-]+\/)$/
const SHARE_PATH_SUFFIX = /\/(?:share\/[A-Za-z0-9_-]+|site\/[A-Za-z0-9_-]+\/)$/

/**
 * A configured link, parsed once: it must already be the canonical absolute
 * http(s) form of itself (no surrounding whitespace, credentials, query,
 * fragment, `..` or `//`), end in a share route, and end in `sharePath` when
 * the response has one. Returns the parsed URL's `href`.
 */
function parseConfiguredLink(url: unknown, sharePath: unknown): string {
  if (typeof url !== "string" || /[?#]/.test(url)) throw new InvalidShareResponseError()
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new InvalidShareResponseError()
  }
  const ok = (parsed.protocol === "http:" || parsed.protocol === "https:") && !!parsed.hostname &&
    !parsed.username && !parsed.password && parsed.href === url && !parsed.pathname.includes("//") &&
    SHARE_PATH_SUFFIX.test(parsed.pathname) &&
    (sharePath === undefined || (typeof sharePath === "string" && SHARE_PATH.test(sharePath) && parsed.pathname.endsWith(sharePath)))
  if (!ok) throw new InvalidShareResponseError()
  return parsed.href
}

/**
 * The link the user copies. When the server built `url` on its configured
 * public address (`urlSource: "configured"`), that `url`, checked: the API
 * may be reachable here only on a private address. Otherwise from the endpoint
 * this app talks to and the share route, not the server's own idea of its
 * address, so it stays right behind a proxy that rewrites `Host`. Older
 * servers send no `urlSource` and get that endpoint behaviour, so a private
 * endpoint still gives a private link there. Anything malformed is refused,
 * never replaced.
 */
export function resolveShareUrl(endpoint: string, result: Pick<ShareCreateResult, "url" | "sharePath" | "urlSource">): string {
  if (result.urlSource === "configured") return parseConfiguredLink(result.url, result.sharePath)
  if (result.urlSource === "request") {
    if (typeof result.sharePath !== "string" || !SHARE_PATH.test(result.sharePath)) throw new InvalidShareResponseError()
    return `${endpoint.replace(/\/+$/, "")}${result.sharePath}`
  }
  if (result.urlSource !== undefined) throw new InvalidShareResponseError()
  return result.sharePath ? `${endpoint.replace(/\/+$/, "")}${result.sharePath}` : result.url
}

export function describeExpiry(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} minutes`
  if (seconds < 48 * 3600) {
    const hours = Math.round(seconds / 3600)
    return hours === 1 ? "1 hour" : `${hours} hours`
  }
  return `${Math.round(seconds / 86400)} days`
}

/** An older server rejects an op it does not know as a plain "Unknown operation" error. */
export function isUnknownOpError(err: unknown): boolean {
  return err instanceof Error && /unknown operation/i.test(err.message)
}

/**
 * Mint a share link and put it on the clipboard. Safari only allows the write
 * inside the click's user activation, so when the browser supports it the
 * clipboard item is handed over as a promise before the request finishes.
 */
async function mintAndCopy(
  client: AgentFsClient,
  orgId: string,
  driveId: string,
  path: string,
  expiresIn?: number,
): Promise<ShareCreateResult & { link: string }> {
  // The endpoint this request goes to, fixed before it is sent.
  const endpoint = client.endpoint
  const request = client
    .createShare(orgId, driveId, path, expiresIn === undefined ? undefined : { expiresIn })
    .then((result) => ({ ...result, link: resolveShareUrl(endpoint, result) }))

  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    const item = new ClipboardItem({
      "text/plain": request.then((r) => new Blob([r.link], { type: "text/plain" })),
    })
    await navigator.clipboard.write([item])
    return request
  }

  const result = await request
  await navigator.clipboard.writeText(result.link)
  return result
}

/**
 * Copy a fresh share link for `path` and report the outcome as a toast. The
 * link lives `expiresIn` seconds, or the server's default of 24 hours. For a
 * folder the server returns a site share, and `sharePath` is `/site/<token>/`.
 * Returns the copied link, or null when it failed.
 */
export async function copyShareLink(
  client: AgentFsClient,
  orgId: string,
  driveId: string,
  path: string,
  options: { expiresIn?: number } = {},
): Promise<string | null> {
  try {
    const result = await mintAndCopy(client, orgId, driveId, path, options.expiresIn)
    toast.success(result.kind === "site" ? "Site link copied" : "Share link copied", {
      description: `Anyone with the link can view it for ${describeExpiry(result.expiresIn)}`,
    })
    return result.link
  } catch (err) {
    if (err instanceof InvalidShareResponseError) {
      toast.error("Couldn't create a share link", { description: "The server returned an invalid link." })
    } else if (isUnknownOpError(err)) {
      toast.error("This server doesn't support share links yet")
    } else {
      toast.error("Couldn't create a share link", {
        description: err instanceof Error ? err.message : undefined,
      })
    }
    return null
  }
}
