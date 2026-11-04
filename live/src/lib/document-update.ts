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

export interface DocumentUpdateNotice {
  /** Changes when the toast text changes, so the old toast is replaced. */
  id: string
  /** Identifies the version; a dismissal applies until a newer version appears. */
  versionKey: string
  description: string
  canLoad: boolean
}

/** Null when no toast is needed: no update, or auto reload loads it now. */
export function documentUpdateNotice(opts: {
  key: string
  hasUpdate: boolean
  autoUpdate: boolean
  isEditing: boolean
  latest: { currentVersion?: number; etag?: string | null } | undefined
}): DocumentUpdateNotice | null {
  const { key, hasUpdate, autoUpdate, isEditing, latest } = opts
  if (!hasUpdate || latest?.currentVersion == null || (autoUpdate && !isEditing)) return null
  const versionKey = `${key}@${latest.currentVersion}:${normalizeEtag(latest.etag) ?? ""}`
  const description = !isEditing
    ? `Version ${latest.currentVersion} is ready to load.`
    : autoUpdate
      ? "It loads when you finish editing."
      : "Finish editing to load it."
  return { id: `${versionKey}:${isEditing ? "editing" : "viewing"}`, versionKey, description, canLoad: !isEditing }
}
