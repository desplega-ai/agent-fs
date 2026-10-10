import { useState } from "react"
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
import { copyShareLink, supportsShareLinks } from "@/lib/share-link"
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

/** The row a context menu was opened on. */
export interface TreeMenuTarget {
  path: string
  parentPath: string
  name: string
  isDir: boolean
}

type NodeDialog = { kind: NewEntryKind | "rename" | "delete"; target: TreeMenuTarget }

/**
 * Items for the tree's single context menu, plus the mutation dialogs they
 * open. Dialogs are mounted only while open and outlive the menu, so they sit
 * next to it rather than inside it.
 */
export function FileTreeContextMenu({ target }: { target: TreeMenuTarget | null }) {
  const { client, orgId, driveId } = useAuth()
  const { selectFile } = useBrowser()
  const { data: health } = useQuery(healthQueryOptions(client))
  const [dialog, setDialog] = useState<NodeDialog | null>(null)
  const favorites = useFavorites()
  const closeDialog = (open: boolean) => {
    if (!open) setDialog(null)
  }

  const dialogs = (
    <>
      {dialog && (dialog.kind === "file" || dialog.kind === "folder") && (
        <NewEntryDialog
          kind={dialog.kind}
          // "New file" / "New folder" target the folder itself, or a file's parent.
          basePath={dialog.target.isDir ? dialog.target.path : dialog.target.parentPath}
          open
          onOpenChange={closeDialog}
        />
      )}
      {dialog?.kind === "rename" && (
        <RenameDialog path={dialog.target.path} open onOpenChange={closeDialog} />
      )}
      {dialog?.kind === "delete" && (
        <DeleteDialog path={dialog.target.path} open onOpenChange={closeDialog} />
      )}
    </>
  )

  if (!target) return dialogs

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
  // that serves sites. copyShareLink uses the returned sharePath either way.
  const canShareLink =
    !!orgId && !!driveId && supportsShareLinks(health) && (!isDir || supportsHtmlSites(health))
  const favorited = favorites.isFavorite(fullPath)

  const handleCopyShareLink = () => {
    if (canShareLink) void copyShareLink(client, orgId!, driveId!, fullPath)
  }

  return (
    <>
      <ContextMenuContent>
        <ContextMenuItem onClick={handleOpen}>
          <OpenIcon className="h-4 w-4" />
          Open
        </ContextMenuItem>
        <ContextMenuItem onClick={handleCopyLink} disabled={!deepLink}>
          <LinkIcon className="h-4 w-4" />
          Copy link
        </ContextMenuItem>
        {canShareLink && (
          <ContextMenuItem onClick={handleCopyShareLink}>
            <Share2 className="h-4 w-4" />
            {isDir ? "Copy site link" : "Copy share link"}
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
        <ContextMenuItem onClick={() => setDialog({ kind: "file", target })} disabled={!driveId}>
          <FilePlus className="h-4 w-4" />
          New file…
        </ContextMenuItem>
        <ContextMenuItem onClick={() => setDialog({ kind: "folder", target })} disabled={!driveId}>
          <FolderPlus className="h-4 w-4" />
          New folder…
        </ContextMenuItem>
        <ContextMenuSeparator />
        {/* mv and rm are single-file ops; folders stay read-only here. */}
        <ContextMenuItem
          onClick={() => setDialog({ kind: "rename", target })}
          disabled={isDir || !driveId}
        >
          <Pencil className="h-4 w-4" />
          Rename…
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          onClick={() => setDialog({ kind: "delete", target })}
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
      </ContextMenuContent>
      {dialogs}
    </>
  )
}
