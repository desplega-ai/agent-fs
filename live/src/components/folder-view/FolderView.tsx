import { useMemo } from "react"
import { useNavigate } from "react-router"
import { useQuery } from "@tanstack/react-query"
import { FolderOpen } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { useBrowser } from "@/contexts/browser"
import { Spinner } from "@/components/ui/spinner"
import { ListView } from "./ListView"
import { GridView } from "./GridView"
import { ViewModeToggle, useFolderViewMode } from "./ViewModeToggle"
import type { LsEntry, LsResult } from "@/api/types"

interface FolderViewProps {
  /**
   * The folder path inside the current drive. Empty string means the drive
   * root. Trailing slash is tolerated (and stripped).
   */
  path: string
}

/**
 * Renders the contents of a folder when no file is selected. Toggleable
 * between list and grid views (persisted to `liveui:browser:view`).
 *
 * Folders open by URL navigation (deep-linkable); files open via the existing
 * `selectFile` flow which navigates the SPA + selects the file.
 */
export function FolderView({ path }: FolderViewProps) {
  const { client, orgId, driveId } = useAuth()
  const { selectFile, setSelectedFile } = useBrowser()
  const navigate = useNavigate()
  const [mode] = useFolderViewMode()

  // Normalize: strip trailing/leading slashes so we have a canonical path.
  const currentPath = useMemo(() => {
    let p = path ?? ""
    while (p.endsWith("/")) p = p.slice(0, -1)
    while (p.startsWith("/")) p = p.slice(1)
    return p
  }, [path])

  const { data, isLoading, error } = useQuery({
    queryKey: ["ls", orgId, driveId, currentPath],
    queryFn: () =>
      client.callOp<LsResult>(orgId!, "ls", { path: currentPath }, driveId),
    enabled: !!orgId && !!driveId,
  })

  const sorted = useMemo(() => {
    if (!data) return []
    return [...data.entries].sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [data])

  const handleEntryClick = (entry: LsEntry) => {
    const childPath = currentPath ? `${currentPath}/${entry.name}` : entry.name
    if (entry.type === "directory") {
      if (!orgId || !driveId) return
      // Navigate to the folder URL (trailing slash flags it as a folder).
      // Clear the in-memory selection synchronously; RouteParamsSync will
      // sync `selectedFile` to the new splat (with trailing slash) which the
      // FileBrowserPage treats as folder-mode.
      setSelectedFile(null)
      navigate(`/file/~/${orgId}/${driveId}/${childPath}/`)
    } else {
      selectFile(childPath)
    }
  }

  return (
    <div className="flex h-full flex-col min-w-0">
      {/* Header: title (left) + view toggle (right) */}
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <FolderOpen className="size-4 shrink-0 text-amber-500" />
          <span className="truncate font-medium">
            {currentPath || "Drive root"}
          </span>
          {data && (
            <span className="shrink-0 text-xs text-muted-foreground">
              ({data.entries.length} {data.entries.length === 1 ? "item" : "items"})
            </span>
          )}
        </div>
        <ViewModeToggle />
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-3">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : error ? (
          <p className="p-3 text-sm text-destructive">
            Failed to load folder: {(error as Error).message}
          </p>
        ) : sorted.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <FolderOpen className="size-10 opacity-30" />
            <p className="text-sm">This folder is empty.</p>
          </div>
        ) : mode === "grid" ? (
          <GridView
            entries={sorted}
            currentPath={currentPath}
            onEntryClick={handleEntryClick}
          />
        ) : (
          <ListView
            entries={sorted}
            currentPath={currentPath}
            onEntryClick={handleEntryClick}
          />
        )}
      </div>
    </div>
  )
}
