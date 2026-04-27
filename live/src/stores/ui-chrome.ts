import { useSyncExternalStore } from "react"

/**
 * Tiny singleton store for cross-component UI chrome state that needs to be
 * reachable from the keyboard-shortcuts hook (which is mounted globally) but
 * driven by sibling components (Shell owns the left sidebar, MainWithComments
 * owns the right rail, TopBar/HelpOverlay own help-open).
 *
 * Each "registered" toggle is a callback owned by the component that knows
 * how to flip the corresponding `useResizableSidebar` open flag. The hook
 * registers on mount and unregisters on unmount.
 */
type Listener = () => void

type Toggle = () => void
type SetOpen = (open: boolean) => void

class UIChromeStore {
  private leftToggle: Toggle | null = null
  private leftSetOpen: SetOpen | null = null
  private rightToggle: Toggle | null = null
  private rightSetOpen: SetOpen | null = null
  private helpOpen = false
  private listeners = new Set<Listener>()

  private emit() {
    this.listeners.forEach((l) => l())
  }

  registerLeftToggle(fn: Toggle | null) {
    this.leftToggle = fn
    this.emit()
  }

  registerLeftSetOpen(fn: SetOpen | null) {
    this.leftSetOpen = fn
    this.emit()
  }

  registerRightToggle(fn: Toggle | null) {
    this.rightToggle = fn
    this.emit()
  }

  registerRightSetOpen(fn: SetOpen | null) {
    this.rightSetOpen = fn
    this.emit()
  }

  toggleLeft() {
    this.leftToggle?.()
  }

  setLeft(open: boolean) {
    this.leftSetOpen?.(open)
  }

  toggleRight() {
    this.rightToggle?.()
  }

  setRight(open: boolean) {
    this.rightSetOpen?.(open)
  }

  isHelpOpen() {
    return this.helpOpen
  }

  setHelpOpen(open: boolean) {
    if (this.helpOpen === open) return
    this.helpOpen = open
    this.emit()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

const store = new UIChromeStore()

export const uiChromeStore = {
  registerLeftToggle: (fn: Toggle | null) => store.registerLeftToggle(fn),
  registerLeftSetOpen: (fn: SetOpen | null) => store.registerLeftSetOpen(fn),
  registerRightToggle: (fn: Toggle | null) => store.registerRightToggle(fn),
  registerRightSetOpen: (fn: SetOpen | null) => store.registerRightSetOpen(fn),
  toggleLeft: () => store.toggleLeft(),
  setLeft: (open: boolean) => store.setLeft(open),
  toggleRight: () => store.toggleRight(),
  setRight: (open: boolean) => store.setRight(open),
  setHelpOpen: (open: boolean) => store.setHelpOpen(open),
  isHelpOpen: () => store.isHelpOpen(),
}

export function useHelpOpen(): boolean {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.isHelpOpen(),
    () => false
  )
}

export function useSetHelpOpen(): (open: boolean) => void {
  return (open: boolean) => store.setHelpOpen(open)
}
