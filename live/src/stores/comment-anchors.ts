import { useSyncExternalStore } from "react"
import type { AnchorStatus } from "@/lib/comment-anchor"
import { sidePanelStore } from "@/stores/side-panel"
import { uiChromeStore } from "@/stores/ui-chrome"

/**
 * Shared state between the viewer that resolves comment anchors and the
 * comment sidebar: each comment's resolved status/lines (so cards can show a
 * "moved"/"lost" badge), and which comment is hovered on either side (so the
 * card and its highlight pulse together), and which comment a highlight click
 * asked the sidebar to reveal.
 */
export interface AnchorInfo {
  status: AnchorStatus
  lineStart?: number
  lineEnd?: number
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

  /** Replace the anchors for `ids` (entries missing from `next` are cleared). */
  setAnchors(ids: string[], next: Map<string, AnchorInfo>) {
    let changed = false
    for (const id of ids) {
      const prev = this.anchors.get(id)
      const value = next.get(id)
      if (!value) {
        if (prev) { this.anchors.delete(id); changed = true }
      } else if (!prev || prev.status !== value.status || prev.lineStart !== value.lineStart || prev.lineEnd !== value.lineEnd) {
        this.anchors.set(id, value)
        changed = true
      }
    }
    if (changed) this.emit()
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
}

export const commentAnchors = new CommentAnchorStore()

export function useCommentAnchor(id: string): AnchorInfo | undefined {
  return useSyncExternalStore(
    (cb) => commentAnchors.subscribe(cb),
    () => commentAnchors.getAnchor(id),
  )
}

/** Open the Comments surface and scroll the comment's card into view. */
export function revealComment(id: string) {
  sidePanelStore.setTab("comments")
  uiChromeStore.openComments()
  commentAnchors.setFocused(id)
}

export function useFocusedComment(): string | null {
  return useSyncExternalStore(
    (cb) => commentAnchors.subscribe(cb),
    () => commentAnchors.getFocused(),
  )
}

export function useHoveredComment(): HoveredComment | null {
  return useSyncExternalStore(
    (cb) => commentAnchors.subscribe(cb),
    () => commentAnchors.getHovered(),
  )
}
