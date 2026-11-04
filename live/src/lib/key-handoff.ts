import {
  getActiveCredential,
  getCredentials,
  saveCredential,
  setActiveCredential,
} from "@/stores/credentials"

/**
 * "Continue with <swarm>": a browser with no key on an org deep link goes to
 * the org's agent-swarm dashboard, which mints a key for the signed-in user
 * and sends the browser back with `#key=<af_...>&apiUrl=<agent-fs API>`.
 *
 * The fragment never reaches a server, and index.html moves it out of the
 * address bar before any other script runs (see the inline script there).
 * The endpoint the key is saved with comes from the fragment, which only the
 * swarm writes, never from the query string: a crafted `?apiUrl=` on the
 * return URL would otherwise receive the freshly minted key.
 *
 * A handoff counts only for a flow this tab started. The Continue click keeps a
 * single-use nonce in sessionStorage for 10 minutes and puts it in the
 * `return_to` query as `?handoff=<nonce>`. A `#key=` without that nonce (a link
 * someone else crafted, signing the user in as them or pointing the app at
 * their server) is stripped and ignored.
 */

export interface KeyHandoff {
  apiKey: string
  /** The agent-fs API the swarm vouches for; null when the fragment has none. */
  endpoint: string | null
}

const KEY_PATTERN = /^af_[A-Za-z0-9_-]{16,256}$/

/** Absolute http(s) URL without a trailing slash, or null. */
export function normalizeEndpoint(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (url.username || url.password) return null
    return (url.origin + url.pathname).replace(/\/+$/, "")
  } catch {
    return null
  }
}

/** Parse `#key=<af_...>[&apiUrl=<url>]`; anything else is not a handoff. */
export function parseKeyHandoff(hash: string): KeyHandoff | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""))
  const apiKey = params.get("key")
  if (!apiKey || !KEY_PATTERN.test(apiKey)) return null
  return { apiKey, endpoint: normalizeEndpoint(params.get("apiUrl")) }
}

/** Query parameter of `return_to` that brings the Continue nonce back from the swarm. */
export const HANDOFF_PARAM = "handoff"
const NONCE_STORAGE_KEY = "agent-fs-key-handoff"
const NONCE_TTL_MS = 10 * 60 * 1000

interface SessionStorageHolder {
  sessionStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">
}

/** 128 random bits, base64url. */
export function newHandoffNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Keep the nonce of a Continue click in this tab: valid for 10 minutes and one return. */
export function rememberHandoffNonce(win: SessionStorageHolder, nonce: string, now = Date.now()): void {
  try {
    win.sessionStorage.setItem(NONCE_STORAGE_KEY, JSON.stringify({ nonce, expiresAt: now + NONCE_TTL_MS }))
  } catch {
    // Storage blocked: the return is then refused, which is the safe side.
  }
}

/** The pending nonce if it has not expired, or null. It is removed either way. */
function consumeHandoffNonce(win: SessionStorageHolder, now: number): string | null {
  try {
    const raw = win.sessionStorage.getItem(NONCE_STORAGE_KEY)
    win.sessionStorage.removeItem(NONCE_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as { nonce?: unknown; expiresAt?: unknown }
    if (typeof value.nonce !== "string" || typeof value.expiresAt !== "number") return null
    return now < value.expiresAt ? value.nonce : null
  } catch {
    return null
  }
}

interface HandoffWindow extends SessionStorageHolder {
  __agentFsKeyHandoff?: string
  location: { hash: string; pathname: string; search: string }
  history: Pick<History, "replaceState" | "state">
}

/**
 * Take the handoff fragment: the copy index.html saved, or the address bar if
 * that script did not run. The address bar loses the fragment and the
 * `handoff` nonce either way. The key comes back only when the nonce in the
 * query is the one this tab stored on the Continue click; that nonce is used up.
 */
export function takeKeyHandoff(win: HandoffWindow, now = Date.now()): KeyHandoff | null {
  const saved = win.__agentFsKeyHandoff
  delete win.__agentFsKeyHandoff
  const hash = saved ?? win.location.hash
  const hasKey = /(^#|&)key=/.test(hash)
  const query = new URLSearchParams(win.location.search)
  const nonce = query.get(HANDOFF_PARAM)
  if (!hasKey && nonce === null) return null

  if (nonce !== null || !saved) {
    query.delete(HANDOFF_PARAM)
    const rest = query.toString()
    const search = nonce === null ? win.location.search : rest ? `?${rest}` : ""
    win.history.replaceState(win.history.state, "", win.location.pathname + search + (hasKey ? "" : win.location.hash))
  }
  const expected = consumeHandoffNonce(win, now)
  if (!hasKey || !nonce || nonce !== expected) return null
  return parseKeyHandoff(hash)
}

/**
 * Save the handed-off key as the active credential. Without an endpoint in
 * the fragment the active credential's endpoint is used (a server this browser
 * already trusts); with neither, nothing is saved. A key already saved for the
 * same endpoint is reused, not duplicated.
 */
export function applyKeyHandoff(handoff: KeyHandoff): { ok: true; credentialId: string } | { ok: false } {
  const endpoint = normalizeEndpoint(handoff.endpoint) ?? normalizeEndpoint(getActiveCredential()?.endpoint)
  if (!endpoint) return { ok: false }

  const existing = getCredentials().find(
    (c) => normalizeEndpoint(c.endpoint) === endpoint && c.apiKey === handoff.apiKey,
  )
  const id = existing?.id ?? crypto.randomUUID()
  if (!existing) {
    saveCredential({ id, name: endpointHost(endpoint), endpoint, apiKey: handoff.apiKey })
  }
  setActiveCredential(id)
  // The deep link names the org and drive; a previous account's choice must not win.
  localStorage.removeItem("agent-fs-active-org")
  localStorage.removeItem("agent-fs-active-drive")
  return { ok: true, credentialId: id }
}

/** `host[:port]` of a URL, for labels. */
export function endpointHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const APP_PATH = /^\/(?:(?:file|detail)\/~\/[^/?#]+\/[^/?#]+(?:\/[^?#]*)?|(?:sql|members)\/~\/[^/?#]+\/[^/?#]+\/?|orgs\/[^/?#]+\/files(?:\/[^?#]*)?|keys|files)(?:\?[^#]*)?$/

/** A `.` or `..` path segment, also percent-encoded or after a backslash, which browsers read as `/`. */
const DOT_SEGMENT = /[/\\](?:\.|%2e){1,2}(?=[/\\]|$)/i

/** A `?next=` the connect form may return to: one of the app's own deep links. */
export function isAppReturnPath(next: string): boolean {
  return APP_PATH.test(next) && !DOT_SEGMENT.test(next.split("?")[0])
}

/** The org a deep link points into, if any. */
export function orgIdFromAppPath(path: string): string | null {
  const match = /^\/(?:(?:file|detail|sql|members)\/~\/([^/?#]+)|orgs\/([^/?#]+)\/files)/.exec(path)
  const raw = match?.[1] ?? match?.[2]
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

/**
 * Where the auth guard sends a browser without a working key: the connect
 * form, with the deep link kept in `next` so it opens after sign-in. The
 * query string is forwarded as before (`?apiUrl=&apiKey=` auto-connect). An
 * `apiKey` never goes into `next`, so it cannot come back into the address bar.
 */
export function credentialsRedirect(location: { pathname: string; search: string }): string {
  const params = new URLSearchParams(location.search)
  const inner = new URLSearchParams(location.search)
  inner.delete("apiKey")
  const innerSearch = inner.toString()
  const next = location.pathname + (innerSearch ? `?${innerSearch}` : "")
  if (isAppReturnPath(next) && location.pathname !== "/files") params.set("next", next)
  const search = params.toString()
  return `/credentials${search ? `?${search}` : ""}`
}

/** The swarm page that signs the user in and comes back to `liveUrl` with a key. */
export function continueWithSwarmHref(swarmUrl: string, liveUrl: string): string {
  return `${swarmUrl.replace(/\/+$/, "")}/fs/continue?return_to=${encodeURIComponent(liveUrl)}`
}

export interface ContinueLink {
  href: string
  /** The swarm host, for the button label. */
  host: string
  /** The agent-fs API host, when it did not come from a saved account. */
  apiHost: string | null
}

/**
 * The "Continue with <swarm host>" link back to `target` with `?handoff=<nonce>`,
 * or null. `swarmUrl` is what the agent-fs server at `endpoint` answered, so it
 * is checked again: a crafted `?apiUrl=` can point at any server, which must
 * not plant a `javascript:` link. That server also chose the swarm, so when no
 * saved account vouches for it, `apiHost` names it next to the swarm host.
 */
export function continueWithSwarmLink(opts: {
  swarmUrl: unknown
  target: string
  origin: string
  nonce: string
  endpoint: string
  endpointSaved: boolean
}): ContinueLink | null {
  const swarmUrl = typeof opts.swarmUrl === "string" ? normalizeEndpoint(opts.swarmUrl) : null
  if (!swarmUrl || !isAppReturnPath(opts.target)) return null
  const returnTo = new URL(opts.target, opts.origin)
  returnTo.searchParams.set(HANDOFF_PARAM, opts.nonce)
  return {
    href: continueWithSwarmHref(swarmUrl, returnTo.href),
    host: endpointHost(swarmUrl),
    apiHost: opts.endpointSaved ? null : endpointHost(opts.endpoint),
  }
}
