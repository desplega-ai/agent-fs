import { useSyncExternalStore } from "react"

/**
 * Tiny toast store — a singleton so `toast(...)` can be called from anywhere
 * (action functions, keyboard-shortcut handlers, stores) and a single
 * `<Toaster/>` mounted at the app root renders them. Used for feedback on
 * actions that are otherwise silent (clipboard copy, download, theme/drive
 * switch, comment added, …) so both a button click and its shortcut surface
 * the same confirmation.
 */
export type ToastVariant = "default" | "success" | "error"

export interface ToastItem {
  id: number
  message: string
  description?: string
  variant: ToastVariant
}

export interface ToastOptions {
  description?: string
  variant?: ToastVariant
  /** ms before auto-dismiss; 0 to keep until dismissed. */
  duration?: number
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
    this.items = [...this.items, {
      id,
      message,
      description: opts?.description,
      variant: opts?.variant ?? "default",
    }]
    // Cap the stack so a burst of actions can't fill the screen.
    if (this.items.length > 4) this.items = this.items.slice(-4)
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
    error: (message: string, opts?: ToastOptions) => store.add(message, { ...opts, variant: "error" }),
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
