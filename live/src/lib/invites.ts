import type { MemberRole } from "@/api/types"
import type { HealthResponse } from "./upload-limit"

/**
 * Org role the invite dialog starts with. The org role only governs managing
 * members and drives; file access comes from the per-drive roles. One constant,
 * so changing the default is a one-line edit.
 */
export const DEFAULT_INVITE_ORG_ROLE: MemberRole = "viewer"

/** Role a drive gets when its checkbox is ticked in the invite dialog. */
export const DEFAULT_INVITE_DRIVE_ROLE: MemberRole = "viewer"

/** Server features the invite dialog and accept page rely on. Both ship together. */
const INVITE_FEATURES = ["drive-invites", "pending-invites"] as const

/**
 * Older servers ignore `drives` on invite and silently grant the default drive,
 * so the dialog stays hidden unless `/health` advertises both features.
 */
export function supportsInvites(health?: HealthResponse): boolean {
  return INVITE_FEATURES.every((f) => health?.features?.includes(f) === true)
}

/**
 * The link the admin sends. The accept page runs in a browser that may have no
 * saved account, so the API endpoint travels in `apiUrl`. The server's own
 * `acceptUrl` wins when it has one (it knows the public address of this app).
 */
export function buildAcceptLink(opts: {
  token: string
  endpoint: string
  acceptUrl?: string
  origin?: string
}): string {
  const base = opts.acceptUrl ?? `${opts.origin ?? window.location.origin}/invite/${encodeURIComponent(opts.token)}`
  const url = new URL(base)
  url.searchParams.set("apiUrl", opts.endpoint.replace(/\/+$/, ""))
  return url.toString()
}

const DAY_MS = 24 * 3600 * 1000

/** "expired", "in 3 days", "in 5 hours": how long a link has left. */
export function describeTimeLeft(expiresAt: string, now: number = Date.now()): string {
  const left = new Date(expiresAt).getTime() - now
  if (left <= 0) return "expired"
  if (left >= DAY_MS) {
    const days = Math.floor(left / DAY_MS)
    return `in ${days} ${days === 1 ? "day" : "days"}`
  }
  const hours = Math.max(1, Math.floor(left / (3600 * 1000)))
  return `in ${hours} ${hours === 1 ? "hour" : "hours"}`
}

/** Local date and time of an expiry, e.g. "Nov 3, 2026, 12:40 PM". */
export function formatExpiry(expiresAt: string): string {
  return new Date(expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}
