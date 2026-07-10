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
  selectFile: (path: string | null) => void
  setSelectedFile: (path: string | null) => void
}

const BrowserContext = createContext<BrowserContextValue | null>(null)

export function BrowserProvider({ children }: { children: ReactNode }) {
  const { credential, orgId, driveId } = useAuth()
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
    if (!recentScope || !selectedFile) return

    // Auth scope updates can briefly precede RouteParamsSync when switching
    // accounts or drives. Only record when the URL belongs to this scope so a
    // selection from the previous drive cannot leak into the new history.
    const routePrefixes = [
      `/file/~/${orgId}/${driveId}/`,
      `/detail/~/${orgId}/${driveId}/`,
    ]
    if (!routePrefixes.some((prefix) => location.pathname.startsWith(prefix))) return

    recordRecentFile(recentScope, selectedFile)
  }, [driveId, location.pathname, orgId, recentScope, selectedFile])

  const navigateToFolder = useCallback((path: string) => {
    setCurrentPath(path)
    setSelectedFile(null)
    if (orgId && driveId) {
      const clean = path.replace(/^\/+|\/+$/g, "")
      const target = clean
        ? `/file/~/${orgId}/${driveId}/${clean}/`
        : `/file/~/${orgId}/${driveId}/`
      navigate(target)
    } else {
      navigate("/files")
    }
  }, [navigate, orgId, driveId])

  const selectFile = useCallback((path: string | null) => {
    setSelectedFile(path)
    if (path && orgId && driveId) {
      navigate(`/file/~/${orgId}/${driveId}/${path}`)
    } else {
      navigate("/files")
    }
  }, [navigate, orgId, driveId])

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
