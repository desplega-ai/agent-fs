import { useEffect } from "react"
import { useBrowser } from "@/contexts/browser"

export function useKeyboardShortcuts() {
  const { selectFile } = useBrowser()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Escape → deselect file
      if (e.key === "Escape") {
        selectFile(null)
      }
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [selectFile])
}
