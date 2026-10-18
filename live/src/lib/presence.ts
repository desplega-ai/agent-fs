import type { PresenceQuote, PresenceSelection, PresenceSession, PresenceTextPos } from "@/api/types"
import type { HealthResponse } from "./upload-limit"
import { QUOTE_CONTEXT_CHARS, resolveAnchor, resolveAnchorInView, type AnchorInput, type TextSpace } from "./comment-anchor"
import { cleanPath } from "./paths"
import { formatUserDisplay } from "./user-display"

export const PRESENCE_FEATURE = "presence"

/** Servers with in-memory presence say so in `/health`. Older servers get no presence traffic at all. */
export function supportsPresence(health?: HealthResponse): boolean {
  return health?.features?.includes(PRESENCE_FEATURE) === true
}

// --- Colors -------------------------------------------------------------------

/** Number of presence colors (and of `presence-N` highlight / class names). */
export const PRESENCE_SLOTS = 8

function userHash(userId: string): number {
  let hash = 0
  for (let i = 0; i < userId.length; i++) hash = userId.charCodeAt(i) + ((hash << 5) - hash)
  return Math.abs(hash)
}

/** Color slot 0..7 of a user: the hue of the userId hash, rounded to 45 degrees. */
export function colorSlot(userId: string): number {
  return Math.round((userHash(userId) % 360) / 45) % PRESENCE_SLOTS
}

export function slotColor(slot: number, alpha?: number): string {
  const hue = slot * 45
  return alpha == null ? `oklch(0.65 0.15 ${hue})` : `oklch(0.65 0.15 ${hue} / ${alpha})`
}

/** One color per user, shared by avatars, cursors and selections. */
export function userColor(userId: string): string {
  return slotColor(colorSlot(userId))
}

// --- Sessions -----------------------------------------------------------------

/** A doc path in one form (no leading or trailing slash), or null for "no doc". */
export function presencePath(path: string | null | undefined): string | null {
  return path ? cleanPath(path) || null : null
}

export function presenceName(session: Pick<PresenceSession, "userId" | "email" | "displayName">): string {
  return formatUserDisplay(session.userId, session.displayName, { email: session.email, displayName: null })
}

/**
 * Other people, one entry per user and path: their most recently active tab
 * (newest `updatedAt`). The signed-in user is left out, all tabs included.
 */
export function groupSessions(sessions: readonly PresenceSession[], ownUserId: string | null | undefined): PresenceSession[] {
  const best = new Map<string, PresenceSession>()
  for (const s of sessions) {
    if (s.userId === ownUserId) continue
    const key = JSON.stringify([s.userId, presencePath(s.path)])
    const prev = best.get(key)
    if (!prev || Date.parse(s.updatedAt) > Date.parse(prev.updatedAt)) best.set(key, s)
  }
  return [...best.values()]
}

/** Other people on the doc at `path`, one per user, in a stable (name) order. */
export function docSessions(sessions: readonly PresenceSession[], ownUserId: string | null | undefined, path: string): PresenceSession[] {
  const doc = presencePath(path)
  if (!doc) return []
  return groupSessions(sessions, ownUserId)
    .filter((s) => presencePath(s.path) === doc)
    .sort((a, b) => presenceName(a).localeCompare(presenceName(b)) || a.userId.localeCompare(b.userId))
}

// --- Throttle -----------------------------------------------------------------

export interface Timers {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

const browserTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
}

/**
 * Coalesce sends. `request(ms)` asks for a send at most `ms` after the last
 * one (at once if that is already past). Requests inside the window share one
 * trailing send, and `send` reads the latest state when it runs, so the last
 * change always goes out. A shorter request pulls a pending send forward.
 */
export function createThrottle(send: () => void, timers: Timers = browserTimers) {
  let lastSent = -Infinity
  let timer: unknown = null
  let due = Infinity
  const fire = () => {
    timer = null
    due = Infinity
    lastSent = timers.now()
    send()
  }
  return {
    request(ms: number) {
      const now = timers.now()
      const at = Math.max(now, lastSent + ms)
      if (timer != null) {
        if (at >= due) return
        timers.clearTimeout(timer)
      }
      due = at
      timer = timers.setTimeout(fire, at - now)
    },
    cancel() {
      if (timer != null) timers.clearTimeout(timer)
      timer = null
      due = Infinity
    },
  }
}

// --- Positions ----------------------------------------------------------------

/** Longest `quote.exact` the server accepts. */
export const PRESENCE_EXACT_MAX = 256
/** Chars quoted before a caret to place it. */
const CARET_CHARS = 24
/** Longest stretch quoted on each side of the pointer, inside its word. */
const WORD_CHARS = 32

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch)

function context(text: string, start: number, end: number): Pick<PresenceQuote, "prefix" | "suffix"> {
  return {
    prefix: text.slice(Math.max(0, start - QUOTE_CONTEXT_CHARS), start) || undefined,
    suffix: text.slice(end, end + QUOTE_CONTEXT_CHARS) || undefined,
  }
}

/**
 * Quote for the selection [start, end), trimmed like `captureQuote`. A
 * selection longer than the server cap keeps its first chars: the receiver
 * extends it to `lineEnd`.
 */
export function selectionQuote(text: string, start: number, end: number): PresenceQuote | undefined {
  while (start < end && isSpace(text[start])) start++
  while (end > start && isSpace(text[end - 1])) end--
  if (start >= end) return undefined
  const stop = Math.min(end, start + PRESENCE_EXACT_MAX)
  return { exact: text.slice(start, stop), ...context(text, start, stop) }
}

/** Quote for a caret at `offset`: the text before it, so the caret is the quote's end. */
export function caretQuote(text: string, offset: number): PresenceQuote | undefined {
  let start = Math.max(0, offset - CARET_CHARS)
  // Reach back over blank stretches so the quote has text to match.
  while (start > 0 && !/\S/.test(text.slice(start, offset)) && offset - start < PRESENCE_EXACT_MAX) {
    start = Math.max(0, offset - PRESENCE_EXACT_MAX, start - CARET_CHARS)
  }
  const exact = text.slice(start, offset)
  if (!/\S/.test(exact)) return undefined
  return { exact, ...context(text, start, offset) }
}

/**
 * Presence selection for [start, end) of a text space (a caret when they are
 * equal). Null when there is nothing to quote, e.g. a caret at the very start.
 */
export function selectionAt(space: TextSpace, start: number, end: number, fileVersion?: number | null): PresenceSelection | null {
  if (start > end) [start, end] = [end, start]
  let collapsed = start === end
  let quote = collapsed ? undefined : selectionQuote(space.text, start, end)
  if (!quote) {
    // An empty or blank-only selection counts as a caret at its end.
    collapsed = true
    quote = caretQuote(space.text, end)
  }
  if (!quote) return null
  const lineStart = space.offsetToLine?.(start) ?? 0
  const lineEnd = collapsed ? lineStart : space.offsetToLine?.(Math.max(start, end - 1)) ?? lineStart
  return { quote, lineStart, lineEnd: Math.max(lineStart, lineEnd), fileVersion: fileVersion ?? null, collapsed }
}

/** Presence pointer at `offset`: the word under it plus the offset inside it. Null between words. */
export function pointerAt(space: TextSpace, offset: number, fileVersion?: number | null): PresenceTextPos | null {
  const text = space.text
  const inWord = (i: number) => i >= 0 && i < text.length && !isSpace(text[i])
  if (!inWord(offset) && !inWord(offset - 1)) return null
  let start = offset
  let end = offset
  while (start > 0 && offset - start < WORD_CHARS && inWord(start - 1)) start--
  while (end < text.length && end - offset < WORD_CHARS && inWord(end)) end++
  return {
    quote: { exact: text.slice(start, end), ...context(text, start, end) },
    charOffset: offset - start,
    lineStart: space.offsetToLine?.(offset) ?? 0,
    fileVersion: fileVersion ?? null,
  }
}

function isStale(fileVersion: number | null | undefined, currentVersion: number | undefined): boolean {
  return fileVersion != null && currentVersion != null && fileVersion !== currentVersion
}

/**
 * Resolve a presence quote like a comment anchor. `source` is the file text
 * when `view` shows a transformed view of it (JSON shown formatted). Only a
 * quote match counts: a line-range fallback would point at the wrong text.
 */
function resolveQuote(view: TextSpace, source: TextSpace | undefined, input: AnchorInput): [number, number] | null {
  const r = source ? resolveAnchorInView(view, source, input) : resolveAnchor(view, input)
  if (r.status === "lost" || r.method === "lines" || r.start == null || r.end == null) return null
  return [r.start, r.end]
}

export interface ResolvedSelection {
  start: number
  end: number
  /** Where the caret is drawn: the selection end. */
  caret: number
}

/** Offsets of a remote selection in `view`, or null when its text is gone. */
export function resolveSelection(
  view: TextSpace,
  source: TextSpace | undefined,
  sel: PresenceSelection,
  currentVersion: number | undefined,
): ResolvedSelection | null {
  const stale = isStale(sel.fileVersion, currentVersion)
  const hit = resolveQuote(view, source, {
    quote: sel.quote,
    lineStart: sel.lineStart || undefined,
    lineEnd: sel.lineEnd || undefined,
    stale,
  })
  if (!hit) return null
  const [start, quoteEnd] = hit
  if (sel.collapsed) {
    // The resolver drops whitespace at the quote's end. Step over the part of
    // that run the sender had before its caret: the run, minus what the
    // suffix (the text after the caret) starts with.
    let run = 0
    while (isSpace(view.text[quoteEnd + run])) run++
    const lead = /^\s*/.exec(sel.quote.suffix ?? "")![0].length
    const caret = quoteEnd + Math.max(0, run - lead)
    return { start: caret, end: caret, caret }
  }
  let end = quoteEnd
  // A selection longer than the quote cap runs on to the end of its last line.
  const endLine = view.offsetToLine?.(Math.max(start, quoteEnd - 1))
  if (sel.quote.exact.length >= PRESENCE_EXACT_MAX && !stale && !source && endLine != null && sel.lineEnd > endLine) {
    const last = view.lineRangeToOffsets?.(sel.lineEnd, sel.lineEnd)
    if (last && last[1] > end) end = last[1]
  }
  return { start, end, caret: end }
}

/** Offset of a remote pointer in `view`, or null when its word is gone. */
export function resolvePointer(
  view: TextSpace,
  source: TextSpace | undefined,
  pos: PresenceTextPos,
  currentVersion: number | undefined,
): number | null {
  const hit = resolveQuote(view, source, {
    quote: pos.quote,
    lineStart: pos.lineStart || undefined,
    lineEnd: pos.lineStart || undefined,
    stale: isStale(pos.fileVersion, currentVersion),
  })
  return hit ? Math.min(hit[1], hit[0] + pos.charOffset) : null
}
