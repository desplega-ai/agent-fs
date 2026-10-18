import { useEffect, useSyncExternalStore } from "react"
import type { PresenceSelection, PresenceSession, PresenceState, PresenceTextPos } from "@/api/types"
import { docSessions, presencePath } from "@/lib/presence"

/**
 * Presence state of this tab, shared by the connection (which fills in the
 * remote sessions and publishes the local state) and the surfaces that draw
 * or report it (doc header, viewers, comment cards).
 *
 * Remote: every session on the active drive as the server last reported it,
 * the connection mode, and the two view toggles (persisted per browser).
 * Local: what this tab publishes. The selection and the pointer each have an
 * owner (the viewer that reported them), so a viewer only clears its own.
 */
export type PresenceMode = "stream" | "poll" | "off"

export interface PresenceSettings {
  showCursors: boolean
  showSelections: boolean
}

/** What changed in the local state: pointer moves are throttled harder than the rest. */
export type LocalChange = "pointer" | "other"

type CommentActivity = "hover" | "focus" | "reply"

const SETTINGS_KEY = "liveui:presence"
const DEFAULT_SETTINGS: PresenceSettings = { showCursors: true, showSelections: true }

function readSettings(): PresenceSettings {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(SETTINGS_KEY)
    const parsed = raw ? (JSON.parse(raw) as Partial<PresenceSettings>) : {}
    return {
      showCursors: typeof parsed.showCursors === "boolean" ? parsed.showCursors : DEFAULT_SETTINGS.showCursors,
      showSelections: typeof parsed.showSelections === "boolean" ? parsed.showSelections : DEFAULT_SETTINGS.showSelections,
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

type Listener = () => void

class PresenceStore {
  // Remote
  private enabled = false
  private userId: string | null = null
  private sessions: readonly PresenceSession[] = []
  // Per-path result of `getDocSessions`, kept while its sessions are unchanged.
  private docCache = new Map<string, PresenceSession[]>()
  private mode: PresenceMode = "off"
  private settings: PresenceSettings = readSettings()
  private listeners = new Set<Listener>()

  // Local
  private doc: { path: string | null; mode: "view" | "edit" } = { path: null, mode: "view" }
  private selection: { value: PresenceSelection; owner: object } | null = null
  private pointer: { value: PresenceTextPos; owner: object } | null = null
  private comment: Record<CommentActivity, string | null> = { hover: null, focus: null, reply: null }
  private localListeners = new Set<(change: LocalChange) => void>()
  private revealers = new Set<(userId: string) => boolean>()

  private emit() {
    this.listeners.forEach((l) => l())
  }

  private changed(change: LocalChange) {
    this.localListeners.forEach((l) => l(change))
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  // --- Remote ---------------------------------------------------------------

  /** Called by the connection: presence runs for `userId` on the active drive. */
  start(userId: string) {
    this.enabled = true
    this.userId = userId
    this.sessions = []
    this.docCache.clear()
    this.mode = "off"
    this.emit()
  }

  stop() {
    this.enabled = false
    this.sessions = []
    this.docCache.clear()
    this.mode = "off"
    this.emit()
  }

  isEnabled() { return this.enabled }
  getMode() { return this.mode }

  /**
   * Other people on the doc at `path`, one per user. The same array comes back
   * while those sessions are unchanged, so a subscriber only re-renders for
   * activity on its own doc, not for every pointer move on the drive.
   */
  getDocSessions(path: string): PresenceSession[] {
    const next = docSessions(this.sessions, this.userId, path)
    const prev = this.docCache.get(path)
    if (prev && prev.length === next.length && next.every((s, i) => s === prev[i])) return prev
    this.docCache.set(path, next)
    return next
  }
  getSettings() { return this.settings }

  setMode(mode: PresenceMode) {
    if (this.mode === mode) return
    this.mode = mode
    this.emit()
  }

  // The signed-in user's own sessions (this tab's echo, other tabs) are never
  // drawn, so they are not kept: their updates cost no re-render.
  setSessions(sessions: readonly PresenceSession[]) {
    this.sessions = sessions.filter((s) => s.userId !== this.userId)
    this.emit()
  }

  upsertSession(session: PresenceSession) {
    if (session.userId === this.userId) return
    this.sessions = [...this.sessions.filter((s) => s.sessionId !== session.sessionId), session]
    this.emit()
  }

  removeSession(sessionId: string) {
    if (!this.sessions.some((s) => s.sessionId === sessionId)) return
    this.sessions = this.sessions.filter((s) => s.sessionId !== sessionId)
    this.emit()
  }

  setSettings(patch: Partial<PresenceSettings>) {
    this.settings = { ...this.settings, ...patch }
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings))
    } catch {
      // ignore quota / privacy errors
    }
    this.emit()
  }

  /** A viewer that can scroll to a user's pointer or selection. Returns an unregister function. */
  registerRevealer(fn: (userId: string) => boolean) {
    this.revealers.add(fn)
    return () => { this.revealers.delete(fn) }
  }

  /** Scroll the open viewer to the user's pointer or selection. False when none is shown. */
  reveal(userId: string): boolean {
    for (const fn of this.revealers) if (fn(userId)) return true
    return false
  }

  // --- Local ----------------------------------------------------------------

  subscribeLocal(listener: (change: LocalChange) => void) {
    this.localListeners.add(listener)
    return () => { this.localListeners.delete(listener) }
  }

  /** The PUT body for this tab. */
  getLocalState(): PresenceState {
    const { path, mode } = this.doc
    const replying = this.comment.reply
    const viewing = this.comment.focus ?? this.comment.hover
    return {
      path,
      mode,
      selection: path ? this.selection?.value ?? null : null,
      pointer: path ? this.pointer?.value ?? null : null,
      commentId: path ? replying ?? viewing : null,
      commentState: !path ? null : replying ? "replying" : viewing ? "viewing" : null,
    }
  }

  /** The open doc. Opening another doc drops the selection, pointer and comment state. */
  setDoc(path: string | null, mode: "view" | "edit") {
    const next = presencePath(path)
    if (next === this.doc.path && mode === this.doc.mode) return
    if (next !== this.doc.path) {
      this.selection = null
      this.pointer = null
      this.comment = { hover: null, focus: null, reply: null }
    }
    this.doc = { path: next, mode }
    this.changed("other")
  }

  setSelection(value: PresenceSelection | null, owner: object) {
    if (!value) return this.clearSelection(owner)
    this.selection = { value, owner }
    this.changed("other")
  }

  clearSelection(owner: object) {
    if (this.selection?.owner !== owner) return
    this.selection = null
    this.changed("other")
  }

  setPointer(value: PresenceTextPos | null, owner: object) {
    if (!value) return this.clearPointer(owner)
    this.pointer = { value, owner }
    this.changed("pointer")
  }

  clearPointer(owner: object) {
    if (this.pointer?.owner !== owner) return
    this.pointer = null
    this.changed("pointer")
  }

  /** Clear the pointer whoever reported it (the tab was hidden). */
  dropPointer() {
    if (!this.pointer) return
    this.pointer = null
    this.changed("pointer")
  }

  /** Hovering, focusing or replying to a comment thread. `null` ends that activity. */
  setCommentActivity(kind: CommentActivity, commentId: string | null) {
    if (this.comment[kind] === commentId) return
    this.comment = { ...this.comment, [kind]: commentId }
    this.changed("other")
  }

  /** End an activity only if it is still about `commentId`. */
  endCommentActivity(kind: CommentActivity, commentId: string) {
    if (this.comment[kind] === commentId) this.setCommentActivity(kind, null)
  }
}

export const presenceStore = new PresenceStore()

const subscribe = (cb: Listener) => presenceStore.subscribe(cb)

/** Presence runs for the active drive (the server has the feature). */
export function usePresenceEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => presenceStore.isEnabled())
}

export function usePresenceMode(): PresenceMode {
  return useSyncExternalStore(subscribe, () => presenceStore.getMode())
}

export function usePresenceSettings(): PresenceSettings {
  return useSyncExternalStore(subscribe, () => presenceStore.getSettings())
}

/** Other people on the doc at `path`, one per user. Empty when presence is off. */
export function useDocPresence(path: string): PresenceSession[] {
  return useSyncExternalStore(subscribe, () => presenceStore.getDocSessions(path))
}

/** Publish the open doc (path + view or edit) while the calling viewer is mounted. */
export function usePresenceDoc(path: string, mode: "view" | "edit") {
  useEffect(() => presenceStore.setDoc(path, mode), [path, mode])
  useEffect(() => () => presenceStore.setDoc(null, "view"), [])
}
