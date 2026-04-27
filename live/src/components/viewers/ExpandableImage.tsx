import { useCallback, useState } from "react"
import { Maximize2, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { downloadUrl } from "@/lib/download"
import { AssetLightbox } from "./AssetLightbox"

interface ExpandableImageProps {
  src: string
  alt?: string
  title?: string
}

function inferFilename(src: string, alt?: string): string {
  try {
    const u = new URL(src, window.location.href)
    const last = u.pathname.split("/").filter(Boolean).pop()
    if (last) return last
  } catch {
    // not a URL — fall through
  }
  return alt?.trim() || "image"
}

export function ExpandableImage({ src, alt, title }: ExpandableImageProps) {
  const [open, setOpen] = useState(false)
  const filename = inferFilename(src, alt)

  const handleDownload = useCallback(() => {
    void downloadUrl(src, filename)
  }, [src, filename])

  return (
    <>
      <span className="group relative my-2 inline-block max-w-full align-top">
        <img
          src={src}
          alt={alt ?? ""}
          title={title}
          className="max-w-full cursor-zoom-in rounded-md"
          onClick={() => setOpen(true)}
        />
        <span className="pointer-events-none absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
          <Button
            variant="secondary"
            size="icon-xs"
            onClick={(e) => {
              e.stopPropagation()
              setOpen(true)
            }}
            aria-label="Expand image"
            className="shadow-sm"
          >
            <Maximize2 />
          </Button>
          <Button
            variant="secondary"
            size="icon-xs"
            onClick={(e) => {
              e.stopPropagation()
              handleDownload()
            }}
            aria-label="Download image"
            className="shadow-sm"
          >
            <Download />
          </Button>
        </span>
      </span>
      <AssetLightbox
        open={open}
        onOpenChange={setOpen}
        filename={filename}
        onDownload={handleDownload}
      >
        <img
          src={src}
          alt={alt ?? ""}
          className="max-h-full max-w-full object-contain"
        />
      </AssetLightbox>
    </>
  )
}
