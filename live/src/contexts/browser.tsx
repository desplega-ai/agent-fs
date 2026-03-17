import { createContext, useContext, useState, useCallback, type ReactNode } from "react"
import { useAuth } from "./auth"

interface BrowserContextValue {
  activeDriveId: string
  currentPath: string
  selectedFile: string | null
  navigateToFolder: (path: string) => void
  selectFile: (path: string | null) => void
}

const BrowserContext = createContext<BrowserContextValue | null>(null)

export function BrowserProvider({ children }: { children: ReactNode }) {
  const { driveId } = useAuth()
  const [currentPath, setCurrentPath] = useState("")
  const [selectedFile, setSelectedFile] = useState<string | null>(
    () => sessionStorage.getItem("agent-fs-selected-file")
  )

  const navigateToFolder = useCallback((path: string) => {
    setCurrentPath(path)
  }, [])

  const selectFile = useCallback((path: string | null) => {
    setSelectedFile(path)
    if (path) {
      sessionStorage.setItem("agent-fs-selected-file", path)
    } else {
      sessionStorage.removeItem("agent-fs-selected-file")
    }
  }, [])

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
