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

/** Local date and time for a tooltip or a table cell. */
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

/** Who made the link, for rows that are not the caller's own. */
export function creatorLabel(item: Pick<ShareListItem, "createdBy">): string {
  return item.createdBy.displayName || item.createdBy.email || "a former member"
}

/** Drive names of the loaded rows, for the drive filter on the global page. */
export function driveOptions(items: readonly Pick<ShareListItem, "drive">[]): { id: string; name: string }[] {
  const seen = new Map<string, string>()
  for (const item of items) {
    if (!seen.has(item.drive.id)) seen.set(item.drive.id, item.drive.name ?? item.drive.id)
  }
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
}
