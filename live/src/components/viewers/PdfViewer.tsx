import { useSignedUrl } from "@/hooks/use-signed-url"
import { cn } from "@/lib/utils"
import { Spinner } from "@/components/ui/spinner"

interface PdfViewerProps {
  path: string
  className?: string
}

export function PdfViewer({ path, className }: PdfViewerProps) {
  const { url, error, isLoading } = useSignedUrl(path)

  if (error) {
    return (
      <div className={cn("flex items-center justify-center p-8 text-sm text-destructive", className)}>
        Failed to load PDF: {error}
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
    <iframe
      src={url}
      title={path}
      className={cn("w-full h-full border-0", className)}
    />
  )
}
