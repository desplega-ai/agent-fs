import { useEffect, type ReactNode } from "react"
import { X, Download } from "lucide-react"
import { Dialog, DialogPortal, DialogBackdrop } from "@/components/ui/dialog"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface AssetLightboxProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  filename: string
  onDownload: () => void
  children: ReactNode
}

export function AssetLightbox({ open, onOpenChange, filename, onDownload, children }: AssetLightboxProps) {
  // Block body scroll while open — base-ui dialog handles focus trap, but we
  // want the lightbox itself to be the scroll surface.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogBackdrop className="bg-black/80 backdrop-blur-sm" />
        <DialogPrimitive.Popup
          className={cn(
            "fixed inset-0 z-50 flex flex-col outline-none",
            "data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          )}
        >
          <div className="flex items-center justify-between gap-3 px-4 py-3 text-white">
            <div className="truncate text-sm font-medium">{filename}</div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={onDownload}
                className="text-white hover:bg-white/10 hover:text-white"
              >
                <Download className="size-4" />
                Download
              </Button>
              <DialogPrimitive.Close
                aria-label="Close"
                className="rounded-sm p-2 text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none"
              >
                <X className="size-4" />
              </DialogPrimitive.Close>
            </div>
          </div>
          <div className="flex flex-1 items-center justify-center overflow-auto p-6">
            {children}
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  )
}
