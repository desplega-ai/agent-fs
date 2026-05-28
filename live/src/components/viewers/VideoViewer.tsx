import { useSignedUrl } from "@/hooks/use-signed-url"
import { cn } from "@/lib/utils"
import { Spinner } from "@/components/ui/spinner"

interface VideoViewerProps {
  path: string
  className?: string
}

export function VideoViewer({ path, className }: VideoViewerProps) {
  const { url, error, isLoading } = useSignedUrl(path)

  if (error) {
    return (
      <div className={cn("flex items-center justify-center p-8 text-sm text-destructive", className)}>
        Failed to load video: {error}
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
      <video
        src={url}
        controls
        playsInline
        className="max-w-full max-h-full rounded-md bg-black"
      >
        Your browser does not support playing this video. Use the download button to save it.
      </video>
    </div>
  )
}
