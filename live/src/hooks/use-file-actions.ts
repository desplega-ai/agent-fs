import { useCallback, useState } from "react"
import { useAuth } from "@/contexts/auth"
import { downloadFile } from "@/lib/download"
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

  const download = useCallback(() => {
    if (!orgId || !driveId) return
    void downloadFile(client, orgId, driveId, path, filename, { newWindow: true })
  }, [client, orgId, driveId, path, filename])

  return { copyPath, copyLink, download, copiedPath, copiedLink, canShare }
}
