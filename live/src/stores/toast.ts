import { useSyncExternalStore } from "react"
import { pushToast } from "@/lib/toast-stack"

/**
 * Tiny toast store — a singleton so `toast(...)` can be called from anywhere
 * (action functions, keyboard-shortcut handlers, stores) and a single
 * `<Toaster/>` mounted at the app root renders them. Used for feedback on
 * actions that are otherwise silent (clipboard copy, download, theme/drive
 * switch, comment added, …) so both a button click and its shortcut surface
 * the same confirmation.
 */
export type ToastVariant = "default" | "success" | "error"

/** A button inside the toast; clicking it runs `onClick` and dismisses the toast. */
export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastItem {
  id: number
  message: string
  description?: string
  variant: ToastVariant
  action?: ToastAction
  onClose?: () => void
  sticky?: boolean
}

export interface ToastOptions {
  description?: string
  variant?: ToastVariant
  action?: ToastAction
  /** Runs when the user closes the toast with its X button (not on auto-dismiss). */
  onClose?: () => void
  /** ms before auto-dismiss; 0 to keep until dismissed. */
  duration?: number
  /** Survives the stack cap: newer toasts evict older non-sticky ones first. */
  sticky?: boolean
}

type Listener = () => void

let nextId = 1

class ToastStore {
  private items: ToastItem[] = []
  private listeners = new Set<Listener>()

  private emit() {
    this.listeners.forEach((l) => l())
  }

  getItems(): ToastItem[] {
    return this.items
  }

  add(message: string, opts?: ToastOptions): number {
    const id = nextId++
    this.items = pushToast(this.items, {
      id,
      message,
      description: opts?.description,
      variant: opts?.variant ?? "default",
      action: opts?.action,
      onClose: opts?.onClose,
      sticky: opts?.sticky,
    })
    this.emit()
    const duration = opts?.duration ?? 2600
    if (duration > 0) {
      setTimeout(() => this.dismiss(id), duration)
    }
    return id
  }

  dismiss(id: number) {
    const next = this.items.filter((i) => i.id !== id)
    if (next.length === this.items.length) return
    this.items = next
    this.emit()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

const store = new ToastStore()

export const toast = Object.assign(
  (message: string, opts?: ToastOptions) => store.add(message, opts),
  {
    success: (message: string, opts?: ToastOptions) => store.add(message, { ...opts, variant: "success" }),
    // Errors stay until dismissed so they can be read; pass `duration` to override.
    error: (message: string, opts?: ToastOptions) => store.add(message, { duration: 0, ...opts, variant: "error" }),
    dismiss: (id: number) => store.dismiss(id),
  },
)

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getItems(),
    () => store.getItems(),
  )
}
