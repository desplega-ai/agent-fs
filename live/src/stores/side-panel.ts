import { useSyncExternalStore } from "react"

/**
 * Which tab the right-side panel (Comments | Outline) is showing. Lifted into a
 * tiny store so the global keyboard shortcuts (`C` / `O`, registered in Shell)
 * can switch tabs even though the tab UI lives in `SidePanel`.
 */
export type SidePanelTab = "comments" | "outline"

type Listener = () => void

class SidePanelStore {
  private tab: SidePanelTab = "comments"
  // A pending "open the add-comment form" request, set by the `n` shortcut and
  // consumed by the CommentSidebar (which owns the form's open state). A flag
  // rather than a callback so it survives the rail mounting after it's set.
  private pendingAddComment = false
  private listeners = new Set<Listener>()

  private emit() {
    this.listeners.forEach((l) => l())
  }

  getTab(): SidePanelTab {
    return this.tab
  }

  setTab(tab: SidePanelTab) {
    if (this.tab === tab) return
    this.tab = tab
    this.emit()
  }

  /** Switch to Comments and request the add-comment form to open. */
  requestAddComment() {
    this.pendingAddComment = true
    this.tab = "comments"
    this.emit()
  }

  isAddCommentPending(): boolean {
    return this.pendingAddComment
  }

  consumeAddComment() {
    if (!this.pendingAddComment) return
    this.pendingAddComment = false
    this.emit()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

const store = new SidePanelStore()

export const sidePanelStore = {
  getTab: () => store.getTab(),
  setTab: (tab: SidePanelTab) => store.setTab(tab),
  requestAddComment: () => store.requestAddComment(),
  consumeAddComment: () => store.consumeAddComment(),
}

export function useSidePanelTab(): SidePanelTab {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getTab(),
    () => "comments",
  )
}

/** Subscribe to the pending add-comment request flag. */
export function useAddCommentPending(): boolean {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.isAddCommentPending(),
    () => false,
  )
}
