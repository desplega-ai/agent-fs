import { useEffect, useRef, useState } from "react"
import type { OutlineItem } from "@/lib/outline"

export interface ActiveHeadings {
  /** The section the reader is currently "in" (last heading scrolled past). */
  activeId: string | null
  /** Sections with any part on screen. */
  visibleIds: Set<string>
}

const EMPTY: ActiveHeadings = { activeId: null, visibleIds: new Set() }

/**
 * One-shot computation of the active + visible headings from the live DOM. The
 * markdown scroll container is tagged `data-markdown-scroll`; headings carry
 * the ids assigned by `MarkdownViewer`.
 */
export function computeActiveHeadings(items: OutlineItem[]): ActiveHeadings {
  if (items.length === 0) return EMPTY
  const scroller = document.querySelector<HTMLElement>("[data-markdown-scroll]")
  if (!scroller) return EMPTY

  const cRect = scroller.getBoundingClientRect()
  // The section you're "in" is the last heading whose top has passed this line.
  const activationLine = cRect.top + 88
  const tops = items.map((it) => {
    const el = document.getElementById(it.id)
    return el ? el.getBoundingClientRect().top : Number.POSITIVE_INFINITY
  })

  let activeId = items[0].id
  const visibleIds = new Set<string>()
  for (let i = 0; i < items.length; i++) {
    const top = tops[i]
    if (!Number.isFinite(top)) continue
    const sectionBottom = i + 1 < items.length ? tops[i + 1] : cRect.bottom
    // Section spans [top, sectionBottom]; visible if it intersects the viewport.
    if (sectionBottom >= cRect.top && top <= cRect.bottom) visibleIds.add(items[i].id)
    if (top <= activationLine) activeId = items[i].id
  }
  return { activeId, visibleIds }
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

/**
 * Tracks the active + visible headings as the document scrolls. Cheap: the
 * scroll handler is rAF-throttled and only triggers a re-render when the
 * active/visible set actually changes (so constant scroll events are no-ops).
 */
export function useActiveHeadings(items: OutlineItem[]): ActiveHeadings {
  const [state, setState] = useState<ActiveHeadings>(EMPTY)
  const itemsRef = useRef(items)
  itemsRef.current = items

  useEffect(() => {
    if (items.length === 0) {
      setState(EMPTY)
      return
    }
    let raf = 0
    const update = () => {
      raf = 0
      const next = computeActiveHeadings(itemsRef.current)
      setState((prev) =>
        prev.activeId === next.activeId && sameSet(prev.visibleIds, next.visibleIds) ? prev : next,
      )
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    // capture=true so we catch the inner markdown scroller (scroll doesn't bubble).
    window.addEventListener("scroll", onScroll, true)
    window.addEventListener("resize", onScroll)
    return () => {
      window.removeEventListener("scroll", onScroll, true)
      window.removeEventListener("resize", onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [items])

  return state
}
