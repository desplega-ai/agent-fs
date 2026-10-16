import { useSignedUrl } from "@/hooks/use-signed-url"
import { cn } from "@/lib/utils"
import { Spinner } from "@/components/ui/spinner"

interface AudioViewerProps {
  path: string
  className?: string
}

export function AudioViewer({ path, className }: AudioViewerProps) {
  const { url, error, isLoading } = useSignedUrl(path)

  if (error) {
    return (
      <div className={cn("flex items-center justify-center p-8 text-sm text-destructive", className)}>
        Failed to load audio: {error}
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
      <audio src={url} controls preload="metadata" className="w-full max-w-xl">
        Your browser does not support playing this audio. Use the download button to save it.
      </audio>
    </div>
  )
}
