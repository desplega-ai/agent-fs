import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react"
import { useLocation, useNavigate } from "react-router"
import { useAuth } from "./auth"
import {
  recentFilesScope,
  recordRecentFile,
  useRecentFiles,
} from "@/stores/recent-files"

interface BrowserContextValue {
  activeDriveId: string
  currentPath: string
  selectedFile: string | null
  recentFiles: readonly string[]
  navigateToFolder: (path: string) => void
  /** `page` opens a PDF at that page through `?page=N`. */
  selectFile: (path: string | null, options?: { page?: number }) => void
  setSelectedFile: (path: string | null) => void
}

const BrowserContext = createContext<BrowserContextValue | null>(null)

export function BrowserProvider({ children }: { children: ReactNode }) {
  const { credential, orgId, driveId, drivePath } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [currentPath, setCurrentPath] = useState("")
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const recentScope = orgId && driveId
    ? recentFilesScope(credential.id, orgId, driveId)
    : null
  const recentFiles = useRecentFiles(recentScope)

  // Observe selection rather than only selectFile() so cold deep links and
  // detail routes are recorded too. The store ignores folder paths.
  useEffect(() => {
    if (!recentScope || !selectedFile || !orgId || !driveId) return

    // Auth scope updates can briefly precede RouteParamsSync when switching
    // accounts or drives. Only record when the URL belongs to this scope so a
    // selection from the previous drive cannot leak into the new history.
    const routePrefixes = [
      `/file/~/${orgId}/${driveId}/`,
      `/detail/~/${orgId}/${driveId}/`,
      drivePath("file", orgId, driveId),
      drivePath("detail", orgId, driveId),
    ]
    if (!routePrefixes.some((prefix) => location.pathname.startsWith(prefix))) return

    recordRecentFile(recentScope, selectedFile)
  }, [driveId, drivePath, location.pathname, orgId, recentScope, selectedFile])

  const navigateToFolder = useCallback((path: string) => {
    setCurrentPath(path)
    setSelectedFile(null)
    if (orgId && driveId) {
      const clean = path.replace(/^\/+|\/+$/g, "")
      navigate(drivePath("file", orgId, driveId, clean ? `${clean}/` : ""))
    } else {
      navigate("/files")
    }
  }, [navigate, orgId, driveId, drivePath])

  const selectFile = useCallback((path: string | null, options?: { page?: number }) => {
    setSelectedFile(path)
    if (path && orgId && driveId) {
      const query = options?.page ? `?page=${options.page}` : ""
      navigate(`${drivePath("file", orgId, driveId, path)}${query}`)
    } else {
      navigate("/files")
    }
  }, [navigate, orgId, driveId, drivePath])

  return (
    <BrowserContext.Provider
      value={{
        activeDriveId: driveId,
        currentPath,
        selectedFile,
        recentFiles,
        navigateToFolder,
        selectFile,
        setSelectedFile,
      }}
    >
      {children}
    </BrowserContext.Provider>
  )
}

export function useBrowser() {
  const ctx = useContext(BrowserContext)
  if (!ctx) throw new Error("useBrowser must be used within BrowserProvider")
  return ctx
}
