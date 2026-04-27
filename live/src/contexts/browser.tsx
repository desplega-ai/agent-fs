import { createContext, useContext, useState, useCallback, type ReactNode } from "react"
import { useNavigate } from "react-router"
import { useAuth } from "./auth"

interface BrowserContextValue {
  activeDriveId: string
  currentPath: string
  selectedFile: string | null
  navigateToFolder: (path: string) => void
  selectFile: (path: string | null) => void
  setSelectedFile: (path: string | null) => void
}

const BrowserContext = createContext<BrowserContextValue | null>(null)

export function BrowserProvider({ children }: { children: ReactNode }) {
  const { orgId, driveId } = useAuth()
  const navigate = useNavigate()
  const [currentPath, setCurrentPath] = useState("")
  const [selectedFile, setSelectedFile] = useState<string | null>(null)

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
