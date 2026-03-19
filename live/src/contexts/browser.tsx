import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react"
import { useNavigate } from "react-router"
import { useAuth } from "./auth"

interface BrowserContextValue {
  activeDriveId: string
  currentPath: string
  selectedFile: string | null
  navigateToFolder: (path: string) => void
  selectFile: (path: string | null) => void
}

const BrowserContext = createContext<BrowserContextValue | null>(null)

export function BrowserProvider({ children, initialFile }: { children: ReactNode; initialFile?: string | null }) {
  const { orgId, driveId } = useAuth()
  const navigate = useNavigate()
  const [currentPath, setCurrentPath] = useState("")
  const [selectedFile, setSelectedFile] = useState<string | null>(initialFile ?? null)

  // Sync with URL params (handles browser back/forward)
  useEffect(() => {
    setSelectedFile(initialFile ?? null)
  }, [initialFile])

  const navigateToFolder = useCallback((path: string) => {
    setCurrentPath(path)
  }, [])

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
