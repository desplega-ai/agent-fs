import { Check, AlertCircle, Info, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useToasts, toast, type ToastVariant } from "@/stores/toast"

const VARIANT_ICON = {
  default: Info,
  success: Check,
  error: AlertCircle,
} as const

const VARIANT_ICON_CLASS: Record<ToastVariant, string> = {
  default: "text-muted-foreground",
  success: "text-emerald-500",
  error: "text-destructive",
}

/**
 * Renders the toast stack (bottom-right). Mounted once at the app root; reads
 * from the global toast store.
 */
export function Toaster() {
  const toasts = useToasts()

  return (
    <div className="pointer-events-none fixed bottom-20 right-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 lg:bottom-4">
      {toasts.map((t) => {
        const Icon = VARIANT_ICON[t.variant]
        return (
          <div
            key={t.id}
            role="status"
            className={cn(
              "pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-popover px-3 py-2.5 shadow-lg",
              "animate-in slide-in-from-bottom-2 fade-in-0 duration-200",
            )}
          >
            <Icon className={cn("mt-px size-4 shrink-0", VARIANT_ICON_CLASS[t.variant])} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium leading-snug text-foreground">{t.message}</p>
              {t.description && (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{t.description}</p>
              )}
            </div>
            <button
              onClick={() => toast.dismiss(t.id)}
              className="-mr-1 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Dismiss"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
