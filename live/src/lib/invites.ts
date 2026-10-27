import type { DriveGrant, MemberRole } from "@/api/types"
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
 * Whether invite controls may show. A failed refetch keeps the last good
 * response in `data`, so the query's own status decides: only a health check
 * that currently succeeds counts.
 */
export function invitesAvailable(query: { isSuccess: boolean; data?: HealthResponse }): boolean {
  return query.isSuccess && supportsInvites(query.data)
}

/**
 * The link the admin sends. The accept page runs in a browser that may have no
 * saved account, so the API endpoint travels in `apiUrl`. The token rides in
 * the URL fragment, which browsers never send over HTTP, so it stays out of the
 * live host's logs and out of Referer headers. The server's own `acceptUrl`
 * wins when it has one (it knows the public address of this app).
 */
export function buildAcceptLink(opts: {
  token: string
  endpoint: string
  acceptUrl?: string
  origin?: string
}): string {
  const url = new URL(opts.acceptUrl ?? `${opts.origin ?? window.location.origin}/invite#${opts.token}`)
  url.searchParams.set("apiUrl", opts.endpoint.replace(/\/+$/, ""))
  return url.toString()
}

const TOKEN_CHARS = /^[A-Za-z0-9_-]+$/

/**
 * The token an accept link carries: the fragment (`/invite#<token>`) or, for
 * links issued before the fragment form, the path (`/invite/<token>`). The
 * fragment wins when both are present.
 */
export function inviteTokenFromUrl(pathToken: string | undefined, hash: string): string | null {
  const fromHash = hash.replace(/^#/, "")
  if (fromHash && TOKEN_CHARS.test(fromHash)) return fromHash
  return pathToken && TOKEN_CHARS.test(pathToken) ? pathToken : null
}

const TOKEN_STORAGE_KEY = "agent-fs-invite-token"

/**
 * The accept page strips the token from the address bar, so a reload or the
 * detour through the connect form would lose it. The tab keeps it in
 * sessionStorage: gone when the tab closes, never sent anywhere.
 */
export function rememberInviteToken(token: string, storage: Pick<Storage, "setItem"> = sessionStorage): void {
  try {
    storage.setItem(TOKEN_STORAGE_KEY, token)
  } catch {
    // Storage blocked: the page still works until it is reloaded.
  }
}

export function recallInviteToken(storage: Pick<Storage, "getItem"> = sessionStorage): string | null {
  try {
    const token = storage.getItem(TOKEN_STORAGE_KEY)
    return token && TOKEN_CHARS.test(token) ? token : null
  } catch {
    return null
  }
}

export function forgetInviteToken(storage: Pick<Storage, "removeItem"> = sessionStorage): void {
  try {
    storage.removeItem(TOKEN_STORAGE_KEY)
  } catch {
    // Nothing to clear.
  }
}

/** A `?next=` the connect form may return to: the accept page, with or without a legacy path token. */
export function isInviteReturnPath(next: string): boolean {
  return /^\/invite(\/[A-Za-z0-9_-]+)?(\?[^#]*)?$/.test(next)
}

/** The org member whose email is `email` (compared without case), if any. */
export function findOrgMember<T extends { email: string }>(members: T[] | undefined, email: string): T | undefined {
  const value = email.trim().toLowerCase()
  return value ? members?.find((m) => m.email.toLowerCase() === value) : undefined
}

/**
 * Split the drives an admin picked for an existing org member: the ones they
 * are not on yet get the grant, the ones they already have a role on are kept
 * exactly as they are. Adding to a drive overwrites a role, and a role change
 * (including demoting the last admin) belongs on the Members page, which has
 * the guard for it.
 */
export function splitDriveGrants(
  grants: DriveGrant[],
  currentRoles: Record<string, MemberRole | undefined>,
): { add: DriveGrant[]; kept: DriveGrant[] } {
  const add: DriveGrant[] = []
  const kept: DriveGrant[] = []
  for (const grant of grants) {
    const role = currentRoles[grant.driveId]
    if (role) kept.push({ driveId: grant.driveId, role })
    else add.push(grant)
  }
  return { add, kept }
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
