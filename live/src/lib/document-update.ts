import { normalizeEtag } from "./file-content-cache"

export interface DisplayedDocument {
  key: string
  version: number
  etag: string | null
}

/** Compare against the displayed bytes, not a shared stat that may have refreshed. */
export function hasDocumentUpdate(
  key: string,
  displayed: DisplayedDocument | null,
  latest: { currentVersion?: number; etag?: string | null } | undefined,
): boolean {
  if (!displayed || displayed.key !== key || latest?.currentVersion == null) return false
  if (latest.currentVersion > displayed.version) return true
  const etag = normalizeEtag(latest.etag)
  return latest.currentVersion === displayed.version && !!displayed.etag && !!etag && etag !== displayed.etag
}
