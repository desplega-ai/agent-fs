import type { ShareCreateResult } from "@/api/client"

// Free of React and app stores, so the server's tests can run the whole
// share-create response path through it.

/** share-create returned something no link can be built from: nothing is copied. */
export class InvalidShareResponseError extends Error {}

// The routes the server mints: `/share/<token>` for a file, `/site/<token>/`
// for a folder (the slash is part of it: the site's relative paths need it).
// Tokens are base64url.
const SHARE_PATH = /^\/(?:share\/[A-Za-z0-9_-]+|site\/[A-Za-z0-9_-]+\/)$/
const SHARE_PATH_SUFFIX = /\/(?:share\/[A-Za-z0-9_-]+|site\/[A-Za-z0-9_-]+\/)$/

/**
 * A server-built link, parsed once: it must already be the canonical absolute
 * http(s) form of itself (no surrounding whitespace, credentials, query,
 * fragment, `..` or `//`) and end in a share route, `sharePath` when given.
 * Returns the parsed URL's `href`.
 */
function parseServerLink(url: unknown, sharePath?: string): string {
  if (typeof url !== "string" || /[?#]/.test(url)) throw new InvalidShareResponseError()
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new InvalidShareResponseError()
  }
  const ok = (parsed.protocol === "http:" || parsed.protocol === "https:") && !!parsed.hostname &&
    !parsed.username && !parsed.password && parsed.href === url && !parsed.pathname.includes("//") &&
    SHARE_PATH_SUFFIX.test(parsed.pathname) && (sharePath === undefined || parsed.pathname.endsWith(sharePath))
  if (!ok) throw new InvalidShareResponseError()
  return parsed.href
}

/** `sharePath` when it is exactly a share route; otherwise the response is refused. */
function checkedSharePath(sharePath: unknown): string {
  if (typeof sharePath !== "string" || !SHARE_PATH.test(sharePath)) throw new InvalidShareResponseError()
  return sharePath
}

/**
 * The link the user copies. When the server built `url` on its configured
 * public address (`urlSource: "configured"`), that `url`, checked: the API
 * may be reachable here only on a private address. Otherwise from the endpoint
 * this app talks to and the share route, not the server's own idea of its
 * address, so it stays right behind a proxy that rewrites `Host`. Older
 * servers send no `urlSource` and get that endpoint behaviour, so a private
 * endpoint still gives a private link there. Every branch validates what it
 * copies; anything malformed is refused, never replaced.
 */
export function resolveShareUrl(endpoint: string, result: Pick<ShareCreateResult, "url" | "sharePath" | "urlSource">): string {
  const onEndpoint = (sharePath: unknown) => `${endpoint.replace(/\/+$/, "")}${checkedSharePath(sharePath)}`
  if (result.urlSource === "configured") return parseServerLink(result.url, checkedSharePath(result.sharePath))
  if (result.urlSource === "request") return onEndpoint(result.sharePath)
  if (result.urlSource !== undefined) throw new InvalidShareResponseError()
  // Older servers: the endpoint route, or the server's own url if it sent no route.
  return result.sharePath === undefined || result.sharePath === "" ? parseServerLink(result.url) : onEndpoint(result.sharePath)
}
