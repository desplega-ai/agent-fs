import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react"
import { useFileStat } from "@/hooks/use-file-stat"
import { buildDomTextSpace, type DomTextSpace } from "@/lib/dom-text-space"
import { scrollBehavior } from "@/lib/outline"
import {
  PRESENCE_SLOTS,
  colorSlot,
  pointerAt,
  presenceName,
  resolvePointer,
  resolveSelection,
  selectionAt,
  slotColor,
} from "@/lib/presence"
import { presenceStore, useDocPresence, usePresenceEnabled, usePresenceMode, usePresenceSettings } from "@/stores/presence"
import { POINTER_PATH } from "./pointer"

// Same feature test as the comment highlights. Without it, selections are not
// painted (carets and pointers still are).
const supportsHighlights = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined"
const POINTER_IDLE_MS = 5_000

interface MarkdownPresenceProps {
  /** The preview's scroll container (positioned). The layer renders inside it. */
  containerRef: RefObject<HTMLDivElement | null>
  path: string
  /** The markdown source: a change means the rendered text changed. */
  content: string
}

/**
 * Presence in the rendered markdown preview: publishes this tab's selection
 * (a click is a caret) and mouse pointer, and draws other people's
 * selections (Custom Highlight API), carets and pointers. Renders nothing
 * when presence is off.
 */
export function MarkdownPresence(props: MarkdownPresenceProps) {
  return usePresenceEnabled() ? <MarkdownPresenceLayer {...props} /> : null
}

interface Mark {
  key: string
  kind: "caret" | "pointer"
  x: number
  y: number
  h: number
  color: string
  name: string
}

function MarkdownPresenceLayer({ containerRef, path, content }: MarkdownPresenceProps) {
  const layerRef = useRef<HTMLDivElement>(null)
  const { data: stat } = useFileStat(path)
  const version = stat?.currentVersion
  const versionRef = useRef(version)
  useEffect(() => { versionRef.current = version }, [version])

  // The rendered text (this layer is aria-hidden, so it is left out).
  const [space, setSpace] = useState<DomTextSpace | null>(null)
  const spaceRef = useRef<DomTextSpace | null>(null)
  useEffect(() => {
    const next = containerRef.current ? buildDomTextSpace(containerRef.current) : null
    spaceRef.current = next
    setSpace(next)
  }, [containerRef, content])

  // Publish: the selection, and the text under the mouse.
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    const owner = {}
    let selRaf = 0
    let moveRaf = 0
    let idle: ReturnType<typeof setTimeout> | undefined
    let point: { x: number; y: number } | null = null

    const onSelectionChange = () => {
      if (selRaf) return
      selRaf = requestAnimationFrame(() => {
        selRaf = 0
        const sel = document.getSelection()
        const space = spaceRef.current
        if (!sel?.rangeCount) {
          presenceStore.clearSelection(owner)
          return
        }
        // Focus moved elsewhere (e.g. into a comment box): keep the last
        // selection in the doc, as an editor would.
        if (!space || !root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return
        const range = sel.getRangeAt(0)
        const start = space.pointToOffset(range.startContainer, range.startOffset)
        const end = space.pointToOffset(range.endContainer, range.endOffset)
        presenceStore.setSelection(start == null || end == null ? null : selectionAt(space, start, end, versionRef.current), owner)
      })
    }

    const clearPointer = () => {
      point = null
      clearTimeout(idle)
      presenceStore.clearPointer(owner)
    }
    const updatePointer = () => {
      moveRaf = 0
      const space = spaceRef.current
      if (!point || !space) return
      clearTimeout(idle)
      idle = setTimeout(clearPointer, POINTER_IDLE_MS)
      const offset = offsetAtPoint(root, layerRef.current, space, point.x, point.y)
      presenceStore.setPointer(offset == null ? null : pointerAt(space, offset, versionRef.current), owner)
    }
    const onMouseMove = (e: MouseEvent) => {
      point = { x: e.clientX, y: e.clientY }
      if (!moveRaf) moveRaf = requestAnimationFrame(updatePointer)
    }
    const onMouseLeave = () => {
      cancelAnimationFrame(moveRaf)
      moveRaf = 0
      clearPointer()
    }

    document.addEventListener("selectionchange", onSelectionChange)
    root.addEventListener("mousemove", onMouseMove)
    root.addEventListener("mouseleave", onMouseLeave)
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange)
      root.removeEventListener("mousemove", onMouseMove)
      root.removeEventListener("mouseleave", onMouseLeave)
      cancelAnimationFrame(selRaf)
      cancelAnimationFrame(moveRaf)
      clearTimeout(idle)
      presenceStore.clearSelection(owner)
      presenceStore.clearPointer(owner)
    }
  }, [containerRef])

  // Draw: other people on this doc, resolved in this view.
  const users = useDocPresence(path)
  const settings = usePresenceSettings()
  const mode = usePresenceMode()
  const resolved = useMemo(() => {
    if (!space) return []
    return users.map((s) => ({
      userId: s.userId,
      slot: colorSlot(s.userId),
      name: presenceName(s),
      selection: s.selection ? resolveSelection(space, undefined, s.selection, version) : null,
      pointer: s.pointer ? resolvePointer(space, undefined, s.pointer, version) : null,
    }))
  }, [space, users, version])
  const resolvedRef = useRef(resolved)
  useEffect(() => { resolvedRef.current = resolved }, [resolved])

  // Selections: one highlight per color slot, next to the comment highlights.
  useEffect(() => {
    if (!supportsHighlights || !space || !settings.showSelections) return
    const groups: Range[][] = Array.from({ length: PRESENCE_SLOTS }, () => [])
    for (const r of resolved) {
      if (!r.selection || r.selection.start === r.selection.end) continue
      const range = space.toRange(r.selection.start, r.selection.end)
      if (range) groups[r.slot].push(range)
    }
    groups.forEach((ranges, slot) => {
      if (ranges.length) CSS.highlights.set(`presence-${slot}`, new Highlight(...ranges))
    })
    return () => {
      for (let slot = 0; slot < PRESENCE_SLOTS; slot++) CSS.highlights.delete(`presence-${slot}`)
    }
  }, [space, resolved, settings.showSelections])

  // Carets and pointers: measured from the text, in scroll-content coordinates,
  // again whenever the container or the document resizes (width, images).
  const [layoutTick, setLayoutTick] = useState(0)
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    let raf = 0
    const observer = new ResizeObserver(() => {
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; setLayoutTick((n) => n + 1) })
    })
    observer.observe(root)
    if (root.firstElementChild) observer.observe(root.firstElementChild)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [containerRef])

  const [marks, setMarks] = useState<Mark[]>([])
  useLayoutEffect(() => {
    const root = containerRef.current
    if (!root || !space || !settings.showCursors) {
      setMarks((prev) => (prev.length ? [] : prev))
      return
    }
    const origin = root.getBoundingClientRect()
    const at = (offset: number) => {
      const r = caretRect(space, offset)
      return r ? { x: r.left - origin.left + root.scrollLeft, y: r.top - origin.top + root.scrollTop, h: r.height } : null
    }
    const next: Mark[] = []
    for (const r of resolved) {
      const color = slotColor(r.slot)
      const caret = r.selection ? at(r.selection.caret) : null
      if (caret) next.push({ key: `caret:${r.userId}`, kind: "caret", ...caret, color, name: r.name })
      // The snapshot poll is too slow for a moving pointer.
      const pointer = r.pointer != null && mode === "stream" ? at(r.pointer) : null
      if (pointer) next.push({ key: `pointer:${r.userId}`, kind: "pointer", ...pointer, color, name: r.name })
    }
    setMarks(next)
  }, [containerRef, space, resolved, settings.showCursors, mode, layoutTick])

  // The header's people list scrolls to someone's selection, else their pointer.
  useEffect(() => {
    return presenceStore.registerRevealer((userId) => {
      const root = containerRef.current
      const space = spaceRef.current
      const r = resolvedRef.current.find((x) => x.userId === userId)
      const offset = r?.selection?.caret ?? r?.pointer
      const rect = root && space && offset != null ? caretRect(space, offset) : null
      if (!root || !rect) return false
      const origin = root.getBoundingClientRect()
      root.scrollTo({ top: root.scrollTop + rect.top - origin.top - root.clientHeight / 2, behavior: scrollBehavior() })
      return true
    })
  }, [containerRef])

  return (
    <div ref={layerRef} aria-hidden="true" data-presence-layer className="pointer-events-none absolute left-0 top-0 z-10 select-none">
      {marks.map((m) =>
        m.kind === "caret" ? (
          <div key={m.key} className="absolute" style={{ left: m.x, top: m.y, height: m.h }}>
            <div className="absolute inset-y-0 -left-px w-0.5 rounded-full" style={{ background: m.color }} />
            <span className="presence-tag absolute bottom-full -left-px" style={{ background: m.color }}>
              {m.name}
            </span>
          </div>
        ) : (
          <div
            key={m.key}
            className="presence-pointer absolute left-0 top-0"
            style={{ transform: `translate(${m.x - 1}px, ${m.y + m.h / 2 - 1}px)` }}
          >
            <svg width="12" height="17" viewBox="0 0 12 17">
              <path d={POINTER_PATH} fill={m.color} stroke="white" strokeWidth="1" />
            </svg>
            <span className="presence-tag" style={{ background: m.color }}>
              {m.name}
            </span>
          </div>
        ),
      )}
    </div>
  )
}

/** Visible rects of a range, skipping empty ones (block separators, collapsed ends). */
function rectsOf(range: Range): DOMRect[] {
  return [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0)
}

/** Where a caret at `offset` is drawn: after the char before it, else before the char after it. */
function caretRect(space: DomTextSpace, offset: number): DOMRect | null {
  const before = offset > 0 ? space.toRange(offset - 1, offset) : null
  const b = before ? rectsOf(before).pop() : undefined
  if (b) return new DOMRect(b.right, b.top, 0, b.height)
  const after = space.toRange(offset, offset + 1)
  const a = after ? rectsOf(after)[0] : undefined
  return a ? new DOMRect(a.left, a.top, 0, a.height) : null
}

function caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  if (typeof document.caretPositionFromPoint === "function") {
    const pos = document.caretPositionFromPoint(x, y)
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null
  }
  if (typeof document.caretRangeFromPoint === "function") {
    const range = document.caretRangeFromPoint(x, y)
    return range ? { node: range.startContainer, offset: range.startOffset } : null
  }
  return null
}

/** Text offset under the mouse, or null when it is not over document text. */
function offsetAtPoint(root: HTMLElement, layer: HTMLElement | null, space: DomTextSpace, x: number, y: number): number | null {
  const hit = caretFromPoint(x, y)
  if (!hit || hit.node.nodeType !== Node.TEXT_NODE || !root.contains(hit.node) || layer?.contains(hit.node)) return null
  // Over a margin or past a line end the browser still reports the nearest
  // caret position: count it only when the mouse is on the text beside it.
  const text = hit.node as Text
  const range = document.createRange()
  range.setStart(text, Math.max(0, hit.offset - 1))
  range.setEnd(text, Math.min(text.data.length, hit.offset + 1))
  const onText = rectsOf(range).some((r) => x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 2 && y <= r.bottom + 2)
  return onText ? space.pointToOffset(text, hit.offset) : null
}
