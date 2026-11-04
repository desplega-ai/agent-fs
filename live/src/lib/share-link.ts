import type { AgentFsClient, ShareCreateResult } from "@/api/client"
import { toast } from "@/stores/toast"
import type { HealthResponse } from "./upload-limit"
import { InvalidShareResponseError, resolveShareUrl } from "./share-url"

export { InvalidShareResponseError, resolveShareUrl }

export const SHARE_LINKS_FEATURE = "share-links"
export const SHARE_NO_EXPIRY_FEATURE = "share-no-expiry"

/**
 * Expiry choices offered when sharing. The server allows 60 seconds to 7 days,
 * or `null` for a link that never expires (only servers with `share-no-expiry`).
 */
export const SHARE_EXPIRY_CHOICES = [
  { label: "1 hour", seconds: 3600 },
  { label: "24 hours", seconds: 86_400 },
  { label: "3 days", seconds: 259_200 },
  { label: "7 days", seconds: 604_800 },
  { label: "Never", seconds: null },
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

/** Servers that accept `expiresIn: null` say so in `/health`; older ones would reject it. */
export function supportsNoExpiry(health?: HealthResponse): boolean {
  return health?.features?.includes(SHARE_NO_EXPIRY_FEATURE) === true
}

/**
 * The expiry to send for a choice: "Never" (`null`) only while the server
 * offers it. A Never chosen before the server changed, or before its health
 * answered, falls back to the default instead of a request the server rejects.
 */
export function effectiveShareExpiry(selected: number | null, health?: HealthResponse): number | null {
  return selected === null && !supportsNoExpiry(health) ? DEFAULT_SHARE_EXPIRY_SECONDS : selected
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
  expiresIn?: number | null,
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
 * link lives `expiresIn` seconds, the server's default of 24 hours, or
 * forever when `expiresIn` is null. For a folder the server returns a site share,
 * and `sharePath` is `/site/<token>/`. Returns the copied link, or null when
 * it failed.
 */
export async function copyShareLink(
  client: AgentFsClient,
  orgId: string,
  driveId: string,
  path: string,
  options: { expiresIn?: number | null } = {},
): Promise<string | null> {
  try {
    const result = await mintAndCopy(client, orgId, driveId, path, options.expiresIn)
    toast.success(result.kind === "site" ? "Site link copied" : "Share link copied", {
      description: result.expiresIn === null
        ? "Anyone with the link can view it until it is revoked"
        : `Anyone with the link can view it for ${describeExpiry(result.expiresIn)}`,
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
