import { useEffect } from "react"

const BASE_TITLE = "agent-fs"

/**
 * Sets `document.title` (the browser tab name) to `<title> — agent-fs`, and
 * restores the base title on unmount. Pass null/undefined for just the base.
 */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} — ${BASE_TITLE}` : BASE_TITLE
    return () => {
      document.title = BASE_TITLE
    }
  }, [title])
}
