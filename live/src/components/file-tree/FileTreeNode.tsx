import { memo } from "react"
import { Folder, FolderOpen, ChevronRight, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { useBrowser } from "@/contexts/browser"
import { treeExpansionStore } from "@/stores/tree-expansion"
import { MiddleEllipsis } from "@/lib/middle-ellipsis"
import { isUuidLike, useUuidName } from "@/lib/uuid-resolver"
import { glyphFor } from "@/lib/file-glyphs"
import { TooltipTrigger, type TooltipHandle } from "@/components/ui/tooltip"
import { FavoriteToggle } from "@/components/FavoriteToggle"
import type { LsEntry } from "@/api/types"

interface FileTreeNodeProps {
  entry: LsEntry
  /** Folder that contains `entry` ("" for the drive root). */
  parentPath: string
  fullPath: string
  depth: number
  isDir: boolean
  expanded: boolean
  isSelected: boolean
  /** Roving tabindex: FileTree picks the single row that is tabbable. */
  tabIndex: 0 | -1
  /** The tree's one shared tooltip; each row is a detached trigger for it. */
  tooltip: TooltipHandle
  favorited: boolean
  /** Absent when the server has no favorites: the row shows no star. */
  onToggleFavorite?: (path: string, isDir: boolean) => void
}

/**
 * One tree row. Children, the context menu, dialogs and the tooltip popup all
 * live in FileTree, so a row only renders its own button and is skipped by
 * React unless one of its props changes.
 */
export const FileTreeNode = memo(function FileTreeNode({
  entry,
  parentPath,
  fullPath,
  depth,
  isDir,
  expanded,
  isSelected,
  tabIndex,
  tooltip,
  favorited,
  onToggleFavorite,
}: FileTreeNodeProps) {
  const { selectFile } = useBrowser()
  const isUuidDir = isDir && isUuidLike(entry.name)
  const resolvedUuidName = useUuidName(parentPath, isUuidDir ? entry.name : "")

  const handleClick = () => {
    if (isDir) {
      treeExpansionStore.toggle(fullPath)
    } else {
      selectFile(fullPath)
    }
    treeExpansionStore.setFocusedPath(fullPath)
  }

  const glyph = !isDir ? glyphFor(fullPath) : null

  // Label content: UUID-aware when applicable, otherwise middle-ellipsis.
  const labelNode = (() => {
    if (isUuidDir && resolvedUuidName) {
      const hint = entry.name.slice(0, 8)
      return (
        <span className="flex min-w-0 items-baseline">
          <span className="min-w-0 flex-1 truncate">{resolvedUuidName}</span>
          <span className="ml-1 flex-shrink-0 text-[11px] text-muted-foreground/70">
            · {hint}
          </span>
        </span>
      )
    }
    return <MiddleEllipsis text={entry.name} className="flex-1" />
  })()

  const tooltipText =
    isUuidDir && resolvedUuidName
      ? `${resolvedUuidName} (${entry.name})`
      : entry.name

  // The star is a sibling of the row button, never inside it, so a click on
  // it cannot open the file or toggle the folder. It stays out of the tab
  // order (the tree uses a roving tabindex); keyboard users star from the
  // context menu or the file header.
  return (
    <div className="group/row relative">
      <button
        type="button"
        data-tree-path={fullPath}
        data-tree-is-dir={isDir ? "true" : "false"}
        data-tree-expanded={expanded ? "true" : "false"}
        tabIndex={tabIndex}
        onClick={handleClick}
        onFocus={() => treeExpansionStore.setFocusedPath(fullPath)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-sm hover:bg-sidebar-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
          isSelected &&
            "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
          onToggleFavorite && "pr-7",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {isDir ? (
          <>
            {expanded ? (
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            {expanded ? (
              <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
            ) : (
              <Folder className="h-4 w-4 shrink-0 text-amber-500" />
            )}
          </>
        ) : (
          <>
            <span className="w-3" />
            {glyph ? (
              <glyph.Icon className={cn("h-4 w-4 shrink-0", glyph.className)} />
            ) : null}
          </>
        )}
        <TooltipTrigger
          handle={tooltip}
          payload={tooltipText}
          render={
            <span className="flex min-w-0 flex-1 items-baseline">
              {labelNode}
            </span>
          }
        />
      </button>
      {onToggleFavorite && (
        <FavoriteToggle
          favorited={favorited}
          onToggle={() => onToggleFavorite(fullPath, isDir)}
          name={entry.name}
          tabIndex={-1}
          className={cn(
            "absolute right-1 top-1/2 size-5 -translate-y-1/2",
            !favorited && "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100",
          )}
        />
      )}
    </div>
  )
})
