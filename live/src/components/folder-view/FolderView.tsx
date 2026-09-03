import { useCallback, useMemo } from "react"
import { useNavigate } from "react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useDropzone } from "react-dropzone"
import { FolderOpen, FilePlus, Upload } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { useBrowser } from "@/contexts/browser"
import { Spinner } from "@/components/ui/spinner"
import { FolderActions } from "@/components/file-mutations/FolderActions"
import { MAX_UPLOAD_BYTES, toUploadInputs, uploadStore } from "@/stores/upload"
import { cleanPath } from "@/lib/paths"
import { ListView } from "./ListView"
import { GridView } from "./GridView"
import { ViewModeToggle, useFolderViewMode } from "./ViewModeToggle"
import { RecentActivity } from "./RecentActivity"
import type { LsEntry, LsResult } from "@/api/types"

interface FolderViewProps {
  /**
   * The folder path inside the current drive. Empty string means the drive
   * root. Trailing slash is tolerated (and stripped).
   */
  path: string
}

const UPLOAD_LIMIT_LABEL = `${MAX_UPLOAD_BYTES / 1024 / 1024} MB`

/**
 * Renders the contents of a folder when no file is selected. Toggleable
 * between list and grid views (persisted to `liveui:browser:view`).
 *
 * Folders open by URL navigation (deep-linkable); files open via the existing
 * `selectFile` flow which navigates the SPA + selects the file.
 *
 * The whole pane is a drop zone: dropped files and folders upload into the
 * current folder. The header carries the New and Upload dropdowns.
 */
export function FolderView({ path }: FolderViewProps) {
  const { client, orgId, driveId } = useAuth()
  const { selectFile, setSelectedFile } = useBrowser()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [mode] = useFolderViewMode()
  const canMutate = !!orgId && !!driveId

  // Normalize: strip trailing/leading slashes so we have a canonical path.
  const currentPath = useMemo(() => cleanPath(path ?? ""), [path])

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

  const enqueueFiles = useCallback(
    (files: File[]) => {
      if (!orgId || !driveId || files.length === 0) return
      uploadStore.enqueue({ client, orgId, driveId, queryClient }, currentPath, toUploadInputs(files))
    },
    [client, orgId, driveId, queryClient, currentPath],
  )

  // react-dropzone traverses dropped folders via `webkitGetAsEntry` and keeps
  // each file's relative path. The pickers live in `FolderActions`, so the
  // root only reacts to drops (its default `preventDropOnDocument` also stops
  // a missed drop from navigating away). Paste-to-upload stays off: the
  // dialogs render inside this React tree and a pasted image while typing a
  // path should not start an upload.
  const { getRootProps, isDragActive } = useDropzone({
    onDrop: enqueueFiles,
    noClick: true,
    noKeyboard: true,
    noPaste: true,
    multiple: true,
    useFsAccessApi: false,
    disabled: !canMutate,
  })

  return (
    <div
      {...getRootProps({
        className: "relative flex h-full flex-col min-w-0 outline-none",
        role: "region",
        "aria-label": `Folder ${currentPath || "drive root"}`,
      })}
    >
      {/* Header: title (left) + actions and view toggle (right) */}
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
        <div className="flex shrink-0 items-center gap-1.5">
          <FolderActions folder={currentPath} />
          <ViewModeToggle />
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-3">
        {currentPath === "" && <RecentActivity />}

        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : error ? (
          <p className="p-3 text-sm text-destructive">
            Failed to load folder: {(error as Error).message}
          </p>
        ) : sorted.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
            <FilePlus className="size-8 text-muted-foreground/60" strokeWidth={1.5} />
            <div className="space-y-1">
              <p className="text-sm font-medium">
                {currentPath ? "This folder is empty" : "This drive is empty"}
              </p>
              <p className="text-xs text-muted-foreground">
                Create a file, or drop files here to upload (up to {UPLOAD_LIMIT_LABEL} each).
              </p>
            </div>
          </div>
        ) : mode === "grid" ? (
          <>
            {currentPath === "" && <AllFilesHeading />}
            <GridView
              entries={sorted}
              currentPath={currentPath}
              onEntryClick={handleEntryClick}
            />
          </>
        ) : (
          <>
            {currentPath === "" && <AllFilesHeading />}
            <ListView
              entries={sorted}
              currentPath={currentPath}
              onEntryClick={handleEntryClick}
            />
          </>
        )}
      </div>

      {isDragActive && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-background/85">
          <div className="flex flex-col items-center gap-2 text-center">
            <Upload className="size-6 text-primary" />
            <p className="text-sm font-medium">
              Drop to upload into {currentPath || "the drive root"}
            </p>
            <p className="text-xs text-muted-foreground">
              Folders keep their structure. Files over {UPLOAD_LIMIT_LABEL} are skipped.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function AllFilesHeading() {
  return (
    <h2 className="px-3 py-1 text-xs font-medium text-muted-foreground">
      All files
    </h2>
  )
}
