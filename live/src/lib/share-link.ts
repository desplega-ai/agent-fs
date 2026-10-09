import type { AgentFsClient, ShareCreateResult } from "@/api/client"
import { toast } from "@/stores/toast"
import type { HealthResponse } from "./upload-limit"

export const SHARE_LINKS_FEATURE = "share-links"

/**
 * Servers that can mint public share links say so in `/health`. Older servers
 * omit the field, so an unreachable or older server hides the action instead of
 * offering a button that can only fail.
 */
export function supportsShareLinks(health?: HealthResponse): boolean {
  return health?.features?.includes(SHARE_LINKS_FEATURE) === true
}

/**
 * The link the user copies. Built from the endpoint this app already talks to,
 * not from the server's own idea of its address, so it stays right behind a
 * proxy that rewrites `Host`. Falls back to the server's `url`.
 */
export function resolveShareUrl(endpoint: string, result: Pick<ShareCreateResult, "url" | "sharePath">): string {
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
async function mintAndCopy(client: AgentFsClient, orgId: string, driveId: string, path: string): Promise<ShareCreateResult & { link: string }> {
  const request = client
    .createShare(orgId, driveId, path)
    .then((result) => ({ ...result, link: resolveShareUrl(client.endpoint, result) }))

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
 * Copy a fresh 24-hour share link for `path` and report the outcome as a toast.
 * For a folder the server returns a site share, and `sharePath` is `/site/<token>/`.
 */
export async function copyShareLink(client: AgentFsClient, orgId: string, driveId: string, path: string): Promise<boolean> {
  try {
    const result = await mintAndCopy(client, orgId, driveId, path)
    toast.success(result.kind === "site" ? "Site link copied" : "Share link copied", {
      description: `Anyone with the link can view it for ${describeExpiry(result.expiresIn)}`,
    })
    return true
  } catch (err) {
    if (isUnknownOpError(err)) {
      toast.error("This server doesn't support share links yet")
    } else {
      toast.error("Couldn't create a share link", {
        description: err instanceof Error ? err.message : undefined,
      })
    }
    return false
  }
}
