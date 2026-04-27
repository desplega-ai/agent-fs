import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { XIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * `Sheet` — a side-anchored dialog (slide-in drawer) built on
 * `@base-ui/react/dialog`. Mirrors shadcn's `Sheet` API so future docs map
 * cleanly. Animations are pure Tailwind data-state utilities; no Framer
 * Motion. Backdrop + esc-to-close are inherited from the underlying Dialog.
 */

type Side = "left" | "right" | "top" | "bottom"

function Sheet({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetBackdrop({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="sheet-backdrop"
      className={cn(
        "fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px]",
        "data-open:animate-in data-open:fade-in-0",
        "data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  )
}

const sideClasses: Record<Side, string> = {
  left: cn(
    "fixed inset-y-0 left-0 h-full w-[280px] max-w-[85vw] border-r",
    "transition-transform duration-200 ease-out",
    "data-open:translate-x-0 data-closed:-translate-x-full",
  ),
  right: cn(
    "fixed inset-y-0 right-0 h-full w-[320px] max-w-[85vw] border-l",
    "transition-transform duration-200 ease-out",
    "data-open:translate-x-0 data-closed:translate-x-full",
  ),
  top: cn(
    "fixed inset-x-0 top-0 w-full max-h-[85vh] border-b",
    "transition-transform duration-200 ease-out",
    "data-open:translate-y-0 data-closed:-translate-y-full",
  ),
  bottom: cn(
    "fixed inset-x-0 bottom-0 w-full max-h-[85vh] border-t",
    "transition-transform duration-200 ease-out",
    "data-open:translate-y-0 data-closed:translate-y-full",
  ),
}

function SheetContent({
  className,
  children,
  side = "left",
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  side?: Side
  showCloseButton?: boolean
}) {
  return (
    <SheetPortal>
      <SheetBackdrop />
      <DialogPrimitive.Popup
        data-slot="sheet-content"
        className={cn(
          "z-50 flex flex-col bg-sidebar text-sidebar-foreground border-border shadow-xl outline-none",
          sideClasses[side],
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="sheet-close-icon"
            className={cn(
              "absolute top-2 right-2 inline-flex items-center justify-center",
              "min-h-[44px] min-w-[44px] rounded-md text-muted-foreground",
              "hover:bg-accent hover:text-foreground transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              "disabled:pointer-events-none",
            )}
            aria-label="Close"
          >
            <XIcon className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </SheetPortal>
  )
}

function SheetHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn(
        "flex flex-col gap-1 border-b border-border px-4 py-3",
        className,
      )}
      {...props}
    />
  )
}

function SheetTitle({
  className,
  ...props
}: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-sm font-semibold leading-none", className)}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetPortal,
  SheetClose,
  SheetBackdrop,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
}
