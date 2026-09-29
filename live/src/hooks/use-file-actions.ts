import { useCallback, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import { downloadFile } from "@/lib/download"
import { copyShareLink as copyShareLinkToClipboard, supportsShareLinks } from "@/lib/share-link"
import { healthQueryOptions } from "@/lib/upload-limit"
import { toast } from "@/stores/toast"

/**
 * Shared file actions (copy path, copy shareable link, download) used by the
 * viewer headers AND the file-scoped keyboard shortcuts (`y`, `shift+y`, `d`),
 * so a button click and its shortcut do exactly the same thing.
 */
export function useFileActions(path: string) {
  const { client, orgId, driveId } = useAuth()
  const [copiedPath, setCopiedPath] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)
  const [copiedShare, setCopiedShare] = useState(false)
  const { data: health } = useQuery(healthQueryOptions(client))
  const filename = path.split("/").pop() ?? path
  const canShare = !!orgId && !!driveId

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

  const copyShareLink = useCallback(async () => {
    if (!orgId || !driveId) return
    if (await copyShareLinkToClipboard(client, orgId, driveId, path)) {
      setCopiedShare(true)
      setTimeout(() => setCopiedShare(false), 1500)
    }
  }, [client, orgId, driveId, path])

  const download = useCallback(() => {
    if (!orgId || !driveId) return
    void downloadFile(client, orgId, driveId, path, filename, { newWindow: true })
  }, [client, orgId, driveId, path, filename])

  // Hidden on servers that cannot mint share links (older `/health`, or unreachable).
  const canShareLink = canShare && supportsShareLinks(health)

  return { copyPath, copyLink, copyShareLink, download, copiedPath, copiedLink, copiedShare, canShare, canShareLink }
}
