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

interface HandoffWindow {
  __agentFsKeyHandoff?: string
  location: { hash: string; pathname: string; search: string }
  history: Pick<History, "replaceState" | "state">
}

/**
 * Take the handoff fragment: the copy index.html saved, or the address bar if
 * that script did not run. The address bar loses the fragment either way.
 */
export function takeKeyHandoff(win: HandoffWindow): KeyHandoff | null {
  const saved = win.__agentFsKeyHandoff
  delete win.__agentFsKeyHandoff
  const hash = saved ?? win.location.hash
  if (!/(^#|&)key=/.test(hash)) return null
  if (!saved) {
    win.history.replaceState(win.history.state, "", win.location.pathname + win.location.search)
  }
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

/** A `?next=` the connect form may return to: one of the app's own deep links. */
export function isAppReturnPath(next: string): boolean {
  return APP_PATH.test(next)
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
