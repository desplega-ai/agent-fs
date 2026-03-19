import { useEffect, useState } from "react"
import { useAuth } from "@/contexts/auth"
import { cn } from "@/lib/utils"
import { Spinner } from "@/components/ui/spinner"

interface ImageViewerProps {
  path: string
  className?: string
}

export function ImageViewer({ path, className }: ImageViewerProps) {
  const { client, orgId, driveId } = useAuth()
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let revoked = false

    client.fetchRaw(orgId!, driveId, path).then((blob) => {
      if (revoked) return
      const objectUrl = URL.createObjectURL(blob)
      setUrl(objectUrl)
    }).catch((err) => {
      if (!revoked) setError((err as Error).message)
    })

    return () => {
      revoked = true
      if (url) URL.revokeObjectURL(url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, orgId, driveId])

  if (error) {
    return (
      <div className={cn("flex items-center justify-center p-8 text-sm text-destructive", className)}>
        Failed to load image: {error}
      </div>
    )
  }

  if (!url) {
    return (
      <div className={cn("flex items-center justify-center p-8", className)}>
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <div className={cn("flex items-center justify-center overflow-auto p-8", className)}>
      <img
        src={url}
        alt={path}
        className="max-w-full max-h-full object-contain rounded-md"
      />
    </div>
  )
}
