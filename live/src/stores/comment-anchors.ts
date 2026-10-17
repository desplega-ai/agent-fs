import { useSyncExternalStore } from "react"
import type { AnchorStatus } from "@/lib/comment-anchor"
import { sidePanelStore } from "@/stores/side-panel"
import { uiChromeStore } from "@/stores/ui-chrome"

/**
 * Shared state between the viewer that resolves comment anchors and the
 * comment sidebar: each comment's resolved status/lines (so cards can show a
 * "moved"/"lost" badge, and the sidebar can sort by position), and which
 * comment is hovered on either side (so the card and its highlight pulse
 * together), and which comment a highlight click asked the sidebar to reveal.
 */
export interface AnchorInfo {
  status: AnchorStatus
  lineStart?: number
  lineEnd?: number
  /** Offset in the viewer's text, to order comments that share a line. */
  start?: number
}

export interface HoveredComment {
  id: string
  source: "card" | "doc"
}

type Listener = () => void

class CommentAnchorStore {
  private anchors = new Map<string, AnchorInfo>()
  private hovered: HoveredComment | null = null
  // A pending "reveal this card" request, set by a highlight click and consumed
  // by the matching card. A flag rather than an event so it survives the rail
  // mounting (or the comments loading) after it is set.
  private focused: string | null = null
  // The comment a highlight click revealed. Its card and highlight stay marked
  // until the next pointer press or Escape.
  private active: string | null = null
  private listeners = new Set<Listener>()

  private emit() {
    this.listeners.forEach((l) => l())
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getAnchor(id: string): AnchorInfo | undefined {
    return this.anchors.get(id)
  }

  /** Every resolved anchor. A new Map whenever one of them changes. */
  getAnchors(): ReadonlyMap<string, AnchorInfo> {
    return this.anchors
  }

  /** Replace the anchors for `ids` (entries missing from `next` are cleared). */
  setAnchors(ids: string[], next: Map<string, AnchorInfo>) {
    const anchors = new Map(this.anchors)
    let changed = false
    for (const id of ids) {
      const prev = anchors.get(id)
      const value = next.get(id)
      if (!value) {
        if (prev) { anchors.delete(id); changed = true }
      } else if (!prev || prev.status !== value.status || prev.lineStart !== value.lineStart || prev.lineEnd !== value.lineEnd || prev.start !== value.start) {
        anchors.set(id, value)
        changed = true
      }
    }
    if (!changed) return
    this.anchors = anchors
    this.emit()
  }

  getHovered(): HoveredComment | null {
    return this.hovered
  }

  setHovered(id: string | null, source: HoveredComment["source"]) {
    if (!id) {
      if (!this.hovered || this.hovered.source !== source) return
      this.hovered = null
    } else {
      if (this.hovered?.id === id && this.hovered.source === source) return
      this.hovered = { id, source }
    }
    this.emit()
  }

  getFocused(): string | null {
    return this.focused
  }

  setFocused(id: string | null) {
    if (this.focused === id) return
    this.focused = id
    this.emit()
  }

  getActive(): string | null {
    return this.active
  }

  setActive(id: string | null) {
    if (this.active === id) return
    this.active = id
    this.emit()
  }
}

export const commentAnchors = new CommentAnchorStore()

export function useCommentAnchor(id: string): AnchorInfo | undefined {
  return useSyncExternalStore(
    (cb) => commentAnchors.subscribe(cb),
    () => commentAnchors.getAnchor(id),
  )
}

export function useCommentAnchorMap(): ReadonlyMap<string, AnchorInfo> {
  return useSyncExternalStore(
    (cb) => commentAnchors.subscribe(cb),
    () => commentAnchors.getAnchors(),
  )
}

// Any pointer press or Escape ends the mark. A press on another highlight still
// marks that comment: its click (or mouseup) comes after this pointerdown.
function clearActive(e: PointerEvent | KeyboardEvent) {
  if (e instanceof KeyboardEvent && e.key !== "Escape") return
  commentAnchors.setActive(null)
  document.removeEventListener("pointerdown", clearActive, true)
  document.removeEventListener("keydown", clearActive, true)
}

/**
 * Open the Comments surface, scroll the comment's card into view, and keep the
 * card and its highlight marked until the next pointer press or Escape.
 */
export function revealComment(id: string) {
  sidePanelStore.setTab("comments")
  uiChromeStore.openComments()
  commentAnchors.setFocused(id)
  commentAnchors.setActive(id)
  // Same listener and options: adding it again is a no-op.
  document.addEventListener("pointerdown", clearActive, true)
  document.addEventListener("keydown", clearActive, true)
}

export function useFocusedComment(): string | null {
  return useSyncExternalStore(
    (cb) => commentAnchors.subscribe(cb),
    () => commentAnchors.getFocused(),
  )
}

export function useActiveComment(): string | null {
  return useSyncExternalStore(
    (cb) => commentAnchors.subscribe(cb),
    () => commentAnchors.getActive(),
  )
}

export function useHoveredComment(): HoveredComment | null {
  return useSyncExternalStore(
    (cb) => commentAnchors.subscribe(cb),
    () => commentAnchors.getHovered(),
  )
}
