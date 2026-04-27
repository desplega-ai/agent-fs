import { useQuery } from "@tanstack/react-query"
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  ExternalLink,
  Download,
  Link as LinkIcon,
  FolderOpen as OpenIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useAuth } from "@/contexts/auth"
import { useBrowser } from "@/contexts/browser"
import {
  useExpanded,
  useToggleExpanded,
  useFocusedPath,
  useSetFocusedPath,
} from "@/stores/tree-expansion"
import { useFileSearch, isPathVisible, hasMatchingDescendant } from "@/stores/file-search"
import { MiddleEllipsis } from "@/lib/middle-ellipsis"
import { isUuidLike, useUuidName } from "@/lib/uuid-resolver"
import { glyphFor } from "@/lib/file-glyphs"
import { downloadFile } from "@/lib/download"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
import type { LsEntry, LsResult } from "@/api/types"

interface FileTreeNodeProps {
  entry: LsEntry
  path: string
  depth: number
  /**
   * When true and no other tree row holds focus, this row is the roving
   * tabindex anchor (i.e. tabIndex={0}). Used to make the tree initially
   * tabbable from outside.
   */
  isDefaultFocus?: boolean
}

export function FileTreeNode({ entry, path, depth, isDefaultFocus = false }: FileTreeNodeProps) {
  const { client, orgId, driveId } = useAuth()
  const { selectedFile, selectFile } = useBrowser()
  const fullPath = path ? `${path}/${entry.name}` : entry.name
  const isDir = entry.type === "directory"
  const isSelected = selectedFile === fullPath
  const userExpanded = useExpanded(fullPath)
  const toggleExpanded = useToggleExpanded()
  // When the in-tree search filter is active, hide nodes outside the match
  // path and force-expand folders that contain matching descendants. Subscribe
  // to the store so re-renders fire on every keystroke.
  const filter = useFileSearch()
  const filterActive = filter.query.length > 0
  const visible = isPathVisible(fullPath)
  const expandedByFilter = filterActive && isDir && hasMatchingDescendant(fullPath)
  const expanded = userExpanded || expandedByFilter
  const focusedPath = useFocusedPath()
  const setFocusedPath = useSetFocusedPath()
  const isFocused = focusedPath === fullPath
  // Roving tabindex: only one row in the tree is tabbable at a time.
  const tabIndex = isFocused || (focusedPath === null && isDefaultFocus) ? 0 : -1
  const isUuidDir = isDir && isUuidLike(entry.name)
  const resolvedUuidName = useUuidName(path, isUuidDir ? entry.name : "")

  const { data: children } = useQuery({
    queryKey: ["ls", orgId, driveId, fullPath],
    queryFn: () =>
      client.callOp<LsResult>(orgId!, "ls", { path: fullPath }, driveId),
    enabled: isDir && expanded && !!driveId,
  })

  const handleClick = () => {
    if (isDir) {
      // While the filter is force-expanding this folder, treat the click as
      // a no-op for expansion (the user can't really "collapse" a filter
      // expansion); just move focus.
      if (!expandedByFilter) toggleExpanded(fullPath)
    } else {
      selectFile(fullPath)
    }
    setFocusedPath(fullPath)
  }

  if (filterActive && !visible) return null

  const deepLink =
    orgId && driveId
      ? `${window.location.origin}/file/~/${orgId}/${driveId}/${fullPath}`
      : null

  const handleOpen = () => {
    if (isDir) {
      toggleExpanded(fullPath)
      if (!expanded) return
    }
    selectFile(fullPath)
  }

  const handleCopyLink = async () => {
    if (!deepLink) return
    try {
      await navigator.clipboard.writeText(deepLink)
    } catch {
      // ignore — older browsers may block this; nothing useful to surface here.
    }
  }

  const handleOpenInNewTab = () => {
    if (!deepLink) return
    window.open(deepLink, "_blank", "noopener,noreferrer")
  }

  const canDownload = !isDir && !!orgId && !!driveId
  const handleDownload = () => {
    if (!canDownload) return
    void downloadFile(client, orgId!, driveId!, fullPath, entry.name)
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

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <button
              type="button"
              data-tree-path={fullPath}
              data-tree-is-dir={isDir ? "true" : "false"}
              data-tree-expanded={expanded ? "true" : "false"}
              tabIndex={tabIndex}
              onClick={handleClick}
              onFocus={() => setFocusedPath(fullPath)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-sm hover:bg-sidebar-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
                isSelected &&
                  "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
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
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="flex min-w-0 flex-1 items-baseline">
                      {labelNode}
                    </span>
                  }
                />
                <TooltipContent side="right" align="center">
                  {tooltipText}
                </TooltipContent>
              </Tooltip>
            </button>
          }
        />
        <ContextMenuContent>
          <ContextMenuItem onClick={handleOpen}>
            <OpenIcon className="h-4 w-4" />
            Open
          </ContextMenuItem>
          <ContextMenuItem onClick={handleCopyLink} disabled={!deepLink}>
            <LinkIcon className="h-4 w-4" />
            Copy link
          </ContextMenuItem>
          <ContextMenuItem onClick={handleDownload} disabled={!canDownload}>
            <Download className="h-4 w-4" />
            Download
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={handleOpenInNewTab}
            disabled={!deepLink}
          >
            <ExternalLink className="h-4 w-4" />
            Open in new tab
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {isDir && expanded && children && (
        <div>
          {children.entries
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === "directory" ? -1 : 1
              return a.name.localeCompare(b.name)
            })
            .map((child) => (
              <FileTreeNode
                key={child.name}
                entry={child}
                path={fullPath}
                depth={depth + 1}
              />
            ))}
          {children.entries.length === 0 && (
            <p
              className="px-2 py-1 text-xs text-muted-foreground italic"
              style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
            >
              Empty folder
            </p>
          )}
        </div>
      )}
    </div>
  )
}
