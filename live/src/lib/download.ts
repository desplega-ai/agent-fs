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
  options?: { newWindow?: boolean },
): Promise<void> {
  const inferredName = filename ?? path.split("/").filter(Boolean).pop() ?? "download"
  const newWindow = options?.newWindow ?? false

  // Try signed URL first — preferred path; lets the browser stream binaries.
  try {
    const { url } = await client.getSignedUrl(orgId, driveId, path)
    triggerAnchorDownload(url, inferredName, newWindow)
    return
  } catch {
    // fall through to raw fetch
  }

  // Fallback: fetch raw bytes as a Blob and trigger via object URL.
  const blob = await client.fetchRaw(orgId, driveId, path)
  const url = URL.createObjectURL(blob)
  try {
    triggerAnchorDownload(url, inferredName, newWindow)
  } finally {
    // Defer revoke slightly to give the browser a chance to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

/**
 * Trigger a download for an in-memory Blob (e.g. SVG generated client-side).
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  try {
    triggerAnchorDownload(url, filename, false)
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

/**
 * Trigger a download for an arbitrary URL. Tries `<a download>` first; if the
 * browser ignores `download` (typical for cross-origin), fetches and re-saves
 * as a Blob so the user still gets a save-as instead of a navigate.
 */
export async function downloadUrl(url: string, filename: string): Promise<void> {
  // Same-origin and most blob: / data: URLs honor `download` directly.
  if (url.startsWith("blob:") || url.startsWith("data:") || isSameOrigin(url)) {
    triggerAnchorDownload(url, filename, false)
    return
  }
  try {
    const res = await fetch(url, { mode: "cors" })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    downloadBlob(blob, filename)
  } catch {
    // Last resort: open in new tab so the user can save manually.
    triggerAnchorDownload(url, filename, true)
  }
}

function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin
  } catch {
    return false
  }
}

function triggerAnchorDownload(href: string, filename: string, newWindow: boolean): void {
  const a = document.createElement("a")
  a.href = href
  a.download = filename
  a.rel = "noopener"
  if (newWindow) a.target = "_blank"
  document.body.appendChild(a)
  a.click()
  a.remove()
}
