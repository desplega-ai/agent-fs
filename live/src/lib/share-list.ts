import type { ShareListItem, ShareListStatus } from "@/api/types"
import type { HealthResponse } from "./upload-limit"

export const SHARE_LIST_FEATURE = "share-list"

/** Servers that can list share links say so in `/health`. Older servers hide both views. */
export function supportsShareList(health?: HealthResponse): boolean {
  return health?.features?.includes(SHARE_LIST_FEATURE) === true
}

/**
 * One cache entry family per account and org. Every share-list query starts
 * with this prefix, so a revoke from either view refreshes both.
 */
export function shareListQueryPrefix(accountId: string, endpoint: string, orgId: string | null) {
  return ["share-list", accountId, endpoint, orgId] as const
}

const STATUS_LABELS: Record<ShareListStatus, string> = {
  active: "Active",
  expired: "Expired",
  exhausted: "Used up",
  revoked: "Revoked",
}

export function statusLabel(status: ShareListStatus): string {
  return STATUS_LABELS[status] ?? status
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

/** "Never", "in 3 hours", "2 days ago": coarse on purpose, the exact time is in the tooltip. */
export function expiryLabel(expiresAt: string | null, now: number = Date.now()): string {
  if (expiresAt === null) return "Never"
  const ms = Date.parse(expiresAt) - now
  if (Number.isNaN(ms)) return "Unknown"
  const abs = Math.abs(ms)
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
    abs < 3_600_000 ? [Math.round(ms / 60_000), "minute"]
    : abs < 48 * 3_600_000 ? [Math.round(ms / 3_600_000), "hour"]
    : [Math.round(ms / 86_400_000), "day"]
  return RELATIVE.format(value, unit)
}

/** When a link expires or expired. Revoked rows show `auditLines` instead: the expiry they never reached says nothing. */
export function lifetimeLabel(item: Pick<ShareListItem, "status" | "expiresAt">, now: number = Date.now()): string {
  if (item.expiresAt === null) return "Never expires"
  const when = expiryLabel(item.expiresAt, now)
  return item.status === "expired" ? `Expired ${when}` : `Expires ${when}`
}

/** Tooltip for `lifetimeLabel`: the exact time behind the relative one, if there is one. */
export function lifetimeTitle(item: Pick<ShareListItem, "expiresAt">): string | undefined {
  return item.expiresAt ? formatWhen(item.expiresAt) : undefined
}

/** Local date and time (the viewer's timezone) for a tooltip or an audit line. */
export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

export function viewsLabel(views: number, maxViews: number | null): string {
  if (maxViews === null) return views === 1 ? "1 view" : `${views} views`
  return `${views} of ${maxViews} ${maxViews === 1 ? "view" : "views"}`
}

/** For a link on a parent folder that also publishes this path. Null for a link on the path itself. */
export function coveringLabel(item: Pick<ShareListItem, "relation" | "path">): string | null {
  if (item.relation !== "covering") return null
  return `Shared via folder ${item.path === "/" ? "/ (whole drive)" : item.path}`
}

type Person = ShareListItem["createdBy"]

/** "you" for the viewer, otherwise their name or email. */
export function personLabel(person: Person, viewerId?: string): string {
  if (person.userId === viewerId) return "you"
  return person.displayName || person.email || "a former member"
}

/**
 * Audit trail of a link: who created it and when, and who revoked it and when.
 * Links revoked before revokers were recorded read "Revoked <time>" with no name.
 */
export function auditLines(
  item: Pick<ShareListItem, "createdAt" | "createdBy" | "revokedAt" | "revokedBy">,
  viewerId?: string,
): string[] {
  const lines = [`Created ${formatWhen(item.createdAt)} by ${personLabel(item.createdBy, viewerId)}`]
  if (item.revokedAt) {
    const by = item.revokedBy ? ` by ${personLabel(item.revokedBy, viewerId)}` : ""
    lines.push(`Revoked ${formatWhen(item.revokedAt)}${by}`)
  }
  return lines
}

/** Drive names of the loaded rows, for the drive filter on the global page. */
export function driveOptions(items: readonly Pick<ShareListItem, "drive">[]): { id: string; name: string }[] {
  const seen = new Map<string, string>()
  for (const item of items) {
    if (!seen.has(item.drive.id)) seen.set(item.drive.id, item.drive.name ?? item.drive.id)
  }
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
}
