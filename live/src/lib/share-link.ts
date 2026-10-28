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

/**
 * The link the user copies. Built from the server's configured public address
 * (`AGENT_FS_PUBLIC_URL`, from `/health`) when it has one, since the endpoint
 * this app talks to may be private. Otherwise from that endpoint, not from the
 * server's own idea of its address, so it stays right behind a proxy that
 * rewrites `Host`. Falls back to the server's `url`.
 */
export function resolveShareUrl(
  endpoint: string,
  result: Pick<ShareCreateResult, "url" | "sharePath">,
  publicUrl?: string,
): string {
  return result.sharePath ? `${(publicUrl || endpoint).replace(/\/+$/, "")}${result.sharePath}` : result.url
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
/** The server's current public address could not be read. */
class PublicUrlUnconfirmed extends Error {}

/**
 * The server's public address for a new link, read fresh. If the read fails,
 * the server may have set or changed one since this tab last asked, so the
 * link is refused rather than built on a stale or private address.
 */
function readPublicUrl(getPublicUrl?: () => Promise<string | undefined>): Promise<string | undefined> | undefined {
  return getPublicUrl?.().catch(() => {
    throw new PublicUrlUnconfirmed()
  })
}

async function mintAndCopy(
  client: AgentFsClient,
  orgId: string,
  driveId: string,
  path: string,
  expiresIn?: number,
  getPublicUrl?: () => Promise<string | undefined>,
): Promise<ShareCreateResult & { link: string }> {
  const request = Promise.all([
    client.createShare(orgId, driveId, path, expiresIn === undefined ? undefined : { expiresIn }),
    readPublicUrl(getPublicUrl),
  ]).then(([result, publicUrl]) => ({ ...result, link: resolveShareUrl(client.endpoint, result, publicUrl) }))

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
 * `publicUrl` reads the server's public address alongside the request, so a
 * cached value from before the server changed it is never used.
 * Returns the copied link, or null when it failed.
 */
export async function copyShareLink(
  client: AgentFsClient,
  orgId: string,
  driveId: string,
  path: string,
  options: { expiresIn?: number; getPublicUrl?: () => Promise<string | undefined> } = {},
): Promise<string | null> {
  try {
    const result = await mintAndCopy(client, orgId, driveId, path, options.expiresIn, options.getPublicUrl)
    toast.success(result.kind === "site" ? "Site link copied" : "Share link copied", {
      description: `Anyone with the link can view it for ${describeExpiry(result.expiresIn)}`,
    })
    return result.link
  } catch (err) {
    if (err instanceof PublicUrlUnconfirmed) {
      toast.error("Couldn't confirm the server's public address. Try again.")
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
