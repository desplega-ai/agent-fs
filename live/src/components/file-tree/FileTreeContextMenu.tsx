import { useQuery } from "@tanstack/react-query"
import {
  ExternalLink,
  Download,
  Link as LinkIcon,
  Share2,
  FolderOpen as OpenIcon,
  FilePlus,
  FolderPlus,
  Pencil,
  Star,
  StarOff,
  Trash2,
} from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { useBrowser } from "@/contexts/browser"
import { treeExpansionStore } from "@/stores/tree-expansion"
import { toast } from "@/stores/toast"
import { downloadFile } from "@/lib/download"
import { supportsShareLinks } from "@/lib/share-link"
import { supportsHtmlSites } from "@/lib/html-view"
import { healthQueryOptions } from "@/lib/upload-limit"
import { useFavorites } from "@/hooks/use-favorites"
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
import { NewEntryDialog, type NewEntryKind } from "@/components/file-mutations/NewEntryDialog"
import { RenameDialog } from "@/components/file-mutations/RenameDialog"
import { DeleteDialog } from "@/components/file-mutations/DeleteDialog"
import { ShareDialog } from "@/components/ShareDialog"

/** The row a menu was opened on. */
export interface TreeMenuTarget {
  path: string
  parentPath: string
  name: string
  isDir: boolean
}

/** A dialog opened from a row's menu. It outlives the menu, so the tree owns it. */
export type TreeDialog = { kind: NewEntryKind | "rename" | "delete" | "share"; target: TreeMenuTarget }

/**
 * Items of a row's menu. Shared by the tree's right-click menu and the row's
 * "..." menu: both are Base UI menus, so the same items work in either.
 */
export function FileTreeMenuItems({
  target,
  onDialog,
}: {
  target: TreeMenuTarget
  onDialog: (dialog: TreeDialog) => void
}) {
  const { client, orgId, driveId } = useAuth()
  const { selectFile } = useBrowser()
  const { data: health } = useQuery(healthQueryOptions(client))
  const favorites = useFavorites()

  const { path: fullPath, name, isDir } = target

  const deepLink =
    orgId && driveId
      ? `${window.location.origin}/file/~/${orgId}/${driveId}/${fullPath}`
      : null

  const handleOpen = () => {
    if (isDir) {
      const expanded = treeExpansionStore.isExpanded(fullPath)
      treeExpansionStore.toggle(fullPath)
      if (!expanded) return
    }
    selectFile(fullPath)
  }

  const handleCopyLink = async () => {
    if (!deepLink) return
    try {
      await navigator.clipboard.writeText(deepLink)
      toast.success("Link copied")
    } catch {
      toast.error("Couldn't copy link")
    }
  }

  const handleOpenInNewTab = () => {
    if (!deepLink) return
    window.open(deepLink, "_blank", "noopener,noreferrer")
  }

  const canDownload = !isDir && !!orgId && !!driveId
  const handleDownload = () => {
    if (!canDownload) return
    void downloadFile(client, orgId!, driveId!, fullPath, name)
  }

  // A folder share is an HTML site (/site/<token>/), so folders need a server
  // that serves sites.
  const canShareLink =
    !!orgId && !!driveId && supportsShareLinks(health) && (!isDir || supportsHtmlSites(health))
  const favorited = favorites.isFavorite(fullPath)

  return (
    <>
      <ContextMenuItem onClick={handleOpen}>
        <OpenIcon className="h-4 w-4" />
        Open
      </ContextMenuItem>
      <ContextMenuItem onClick={handleCopyLink} disabled={!deepLink}>
        <LinkIcon className="h-4 w-4" />
        Copy link
      </ContextMenuItem>
      {canShareLink && (
        <ContextMenuItem onClick={() => onDialog({ kind: "share", target })}>
          <Share2 className="h-4 w-4" />
          {isDir ? "Share as site…" : "Share…"}
        </ContextMenuItem>
      )}
      {favorites.supported && (
        <ContextMenuItem onClick={() => favorites.toggleFavorite(fullPath, isDir ? "directory" : "file")}>
          {favorited ? <StarOff className="h-4 w-4" /> : <Star className="h-4 w-4" />}
          {favorited ? "Remove from favorites" : "Add to favorites"}
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={handleDownload} disabled={!canDownload}>
        <Download className="h-4 w-4" />
        Download
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onDialog({ kind: "file", target })} disabled={!driveId}>
        <FilePlus className="h-4 w-4" />
        New file…
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onDialog({ kind: "folder", target })} disabled={!driveId}>
        <FolderPlus className="h-4 w-4" />
        New folder…
      </ContextMenuItem>
      <ContextMenuSeparator />
      {/* mv and rm are single-file ops; folders stay read-only here. */}
      <ContextMenuItem
        onClick={() => onDialog({ kind: "rename", target })}
        disabled={isDir || !driveId}
      >
        <Pencil className="h-4 w-4" />
        Rename…
      </ContextMenuItem>
      <ContextMenuItem
        variant="destructive"
        onClick={() => onDialog({ kind: "delete", target })}
        disabled={isDir || !driveId}
      >
        <Trash2 className="h-4 w-4" />
        Delete…
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={handleOpenInNewTab} disabled={!deepLink}>
        <ExternalLink className="h-4 w-4" />
        Open in new tab
      </ContextMenuItem>
    </>
  )
}

/** The tree's right-click menu, for the row it opened on. */
export function FileTreeContextMenu({
  target,
  onDialog,
}: {
  target: TreeMenuTarget | null
  onDialog: (dialog: TreeDialog) => void
}) {
  if (!target) return null
  return (
    <ContextMenuContent>
      <FileTreeMenuItems target={target} onDialog={onDialog} />
    </ContextMenuContent>
  )
}

/** Dialogs opened from a row's menu. Mounted only while open. */
export function FileTreeDialogs({
  dialog,
  onClose,
}: {
  dialog: TreeDialog | null
  onClose: () => void
}) {
  if (!dialog) return null
  const closeDialog = (open: boolean) => {
    if (!open) onClose()
  }
  const { kind, target } = dialog
  if (kind === "file" || kind === "folder") {
    return (
      <NewEntryDialog
        kind={kind}
        // "New file" / "New folder" target the folder itself, or a file's parent.
        basePath={target.isDir ? target.path : target.parentPath}
        open
        onOpenChange={closeDialog}
      />
    )
  }
  if (kind === "rename") return <RenameDialog path={target.path} open onOpenChange={closeDialog} />
  if (kind === "delete") return <DeleteDialog path={target.path} open onOpenChange={closeDialog} />
  return <ShareDialog path={target.path} isDir={target.isDir} open onOpenChange={closeDialog} />
}
