import type { AgentFsClient } from "@/api/client"

/**
 * Trigger a browser download for the given file path.
 *
 * Strategy:
 * 1. Try to fetch a signed URL via the `signed-url` op — if available, use a
 *    plain `<a download>` click which lets the browser stream the file
 *    directly (works for binaries like PDFs/PNGs without text-decoding).
 * 2. Fall back to `client.fetchRaw(...)` which returns a Blob; convert via
 *    `URL.createObjectURL` and trigger an `<a>` click. Always revoke the
 *    object URL afterwards.
 *
 * The `filename` argument overrides the inferred filename (last path
 * segment). Useful when the path doesn't end in something the user wants
 * (e.g. for UUID-named files).
 */
export async function downloadFile(
  client: AgentFsClient,
  orgId: string,
  driveId: string,
  path: string,
  filename?: string,
): Promise<void> {
  const inferredName = filename ?? path.split("/").filter(Boolean).pop() ?? "download"

  // Try signed URL first — preferred path; lets the browser stream binaries.
  try {
    const { url } = await client.getSignedUrl(orgId, driveId, path)
    triggerAnchorDownload(url, inferredName)
    return
  } catch {
    // fall through to raw fetch
  }

  // Fallback: fetch raw bytes as a Blob and trigger via object URL.
  const blob = await client.fetchRaw(orgId, driveId, path)
  const url = URL.createObjectURL(blob)
  try {
    triggerAnchorDownload(url, inferredName)
  } finally {
    // Defer revoke slightly to give the browser a chance to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

function triggerAnchorDownload(href: string, filename: string): void {
  const a = document.createElement("a")
  a.href = href
  a.download = filename
  a.rel = "noopener"
  document.body.appendChild(a)
  a.click()
  a.remove()
}
