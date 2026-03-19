import { useSignedUrl } from "@/hooks/use-signed-url"
import { cn } from "@/lib/utils"
import { Spinner } from "@/components/ui/spinner"

interface ImageViewerProps {
  path: string
  className?: string
}

export function ImageViewer({ path, className }: ImageViewerProps) {
  const { url, error, isLoading } = useSignedUrl(path)

  if (error) {
    return (
      <div className={cn("flex items-center justify-center p-8 text-sm text-destructive", className)}>
        Failed to load image: {error}
      </div>
    )
  }

  if (isLoading || !url) {
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
