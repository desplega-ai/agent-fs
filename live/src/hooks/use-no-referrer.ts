import { useEffect } from "react"

/**
 * Sends no Referer header from this page while it is mounted. The accept page
 * holds a bearer token; nothing it loads or links to should learn its address.
 */
export function useNoReferrer(): void {
  useEffect(() => {
    const meta = document.createElement("meta")
    meta.name = "referrer"
    meta.content = "no-referrer"
    document.head.appendChild(meta)
    return () => meta.remove()
  }, [])
}
