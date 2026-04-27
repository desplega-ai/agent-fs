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

class UIChromeStore {
  private leftToggle: Toggle | null = null
  private rightToggle: Toggle | null = null
  private helpOpen = false
  private listeners = new Set<Listener>()

  private emit() {
    this.listeners.forEach((l) => l())
  }

  registerLeftToggle(fn: Toggle | null) {
    this.leftToggle = fn
    this.emit()
  }

  registerRightToggle(fn: Toggle | null) {
    this.rightToggle = fn
    this.emit()
  }

  toggleLeft() {
    this.leftToggle?.()
  }

  toggleRight() {
    this.rightToggle?.()
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
  registerRightToggle: (fn: Toggle | null) => store.registerRightToggle(fn),
  toggleLeft: () => store.toggleLeft(),
  toggleRight: () => store.toggleRight(),
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
