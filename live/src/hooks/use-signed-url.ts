import { useState, useEffect } from "react"
import { useAuth } from "@/contexts/auth"

export function useSignedUrl(path: string | null) {
  const { client, orgId, driveId } = useAuth()
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!path || !orgId) {
      setUrl(null)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)

    client.getSignedUrl(orgId, driveId, path).then((result) => {
      if (!cancelled) {
        setUrl(result.url)
        setIsLoading(false)
      }
    }).catch((err) => {
      if (!cancelled) {
        setError((err as Error).message)
        setIsLoading(false)
      }
    })

    return () => { cancelled = true }
  }, [path, orgId, driveId, client])

  return { url, error, isLoading }
}
