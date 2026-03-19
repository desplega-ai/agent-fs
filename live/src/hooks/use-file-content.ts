import { useState, useEffect } from "react"
import { useAuth } from "@/contexts/auth"

interface FileContentData {
  content: string
  totalLines: number
  truncated: boolean
}

export function useFileContent(path: string | null, _offset = 0, _limit = 200) {
  const { client, orgId, driveId } = useAuth()
  const [data, setData] = useState<FileContentData | undefined>(undefined)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!path || !orgId || !driveId) {
      setData(undefined)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)

    client.getSignedUrl(orgId, driveId, path).then(async (result) => {
      const res = await fetch(result.url)
      if (!res.ok) throw new Error(`Failed to fetch: ${res.statusText}`)
      const text = await res.text()
      if (!cancelled) {
        const lines = text.split("\n")
        setData({ content: text, totalLines: lines.length, truncated: false })
        setIsLoading(false)
      }
    }).catch((err) => {
      if (!cancelled) {
        setError(err as Error)
        setIsLoading(false)
      }
    })

    return () => { cancelled = true }
  }, [path, orgId, driveId, client])

  return { data, isLoading, error }
}
