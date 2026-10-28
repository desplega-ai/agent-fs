import { useCallback, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import { useFileStat } from "@/hooks/use-file-stat"
import { copyability, writeClipboardText } from "@/lib/copy-contents"
import { downloadFile } from "@/lib/download"
import { downloadFileText, fileContentKey, loadFileContent, type CachedFileContent } from "@/lib/file-content-cache"
import { supportsShareLinks } from "@/lib/share-link"
import { healthQueryOptions } from "@/lib/upload-limit"
import { toast } from "@/stores/toast"

/**
 * Shared file actions (copy contents, copy path, copy shareable link, download)
 * used by the viewer headers AND the file-scoped keyboard shortcuts (`y`,
 * `shift+y`, `d`), so a button click and its shortcut do exactly the same thing.
 */
export function useFileActions(path: string) {
  const { client, orgId, driveId } = useAuth()
  const queryClient = useQueryClient()
  const { data: stat } = useFileStat(path)
  const [copiedContents, setCopiedContents] = useState(false)
  const [copiedPath, setCopiedPath] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)
  const { data: health } = useQuery(healthQueryOptions(client))
  const filename = path.split("/").pop() ?? path
  const canShare = !!orgId && !!driveId

  const contents = copyability(path, stat)

  // Must stay synchronous up to the clipboard write: Safari drops the click's
  // permission across an await. The body the viewer already loaded is reused
  // when it is still the file's current content.
  const copyContents = useCallback(() => {
    if (!contents.ok || !stat || !orgId || !driveId) return
    const cached = queryClient.getQueryData<CachedFileContent>(fileContentKey(orgId, driveId, path))
    const text = loadFileContent(cached, stat, () => downloadFileText(client, orgId, driveId, path))
      .then((entry) => entry.content)
    writeClipboardText(text).then(
      () => {
        setCopiedContents(true)
        setTimeout(() => setCopiedContents(false), 1500)
        toast.success("Contents copied", { description: filename })
      },
      () => toast.error("Couldn't copy contents"),
    )
  }, [contents.ok, stat, orgId, driveId, queryClient, client, path, filename])

  const copyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(path)
      setCopiedPath(true)
      setTimeout(() => setCopiedPath(false), 1500)
      toast.success("Path copied", { description: path })
    } catch {
      toast.error("Couldn't copy path")
    }
  }, [path])

  const copyLink = useCallback(async () => {
    if (!orgId || !driveId) return
    const cleanPath = path.startsWith("/") ? path.slice(1) : path
    const url = `${window.location.origin}/file/~/${orgId}/${driveId}/${cleanPath}`
    try {
      await navigator.clipboard.writeText(url)
      setCopiedLink(true)
      setTimeout(() => setCopiedLink(false), 1500)
      toast.success("Link copied")
    } catch {
      toast.error("Couldn't copy link")
    }
  }, [path, orgId, driveId])

  const download = useCallback(() => {
    if (!orgId || !driveId) return
    void downloadFile(client, orgId, driveId, path, filename, { newWindow: true })
  }, [client, orgId, driveId, path, filename])

  // Hidden on servers that cannot mint share links (older `/health`, or unreachable).
  const canShareLink = canShare && supportsShareLinks(health)

  return { copyContents, copyPath, copyLink, download, contents, copiedContents, copiedPath, copiedLink, canShare, canShareLink }
}
