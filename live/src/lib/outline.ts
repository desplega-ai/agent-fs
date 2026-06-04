/**
 * Document outline (gdoc-style) for rendered markdown.
 *
 * `OutlineItem`s are extracted from the rendered headings in the markdown
 * preview (see `MarkdownViewer`), which also assigns the matching element
 * `id`s so `scrollToHeading` can jump to them from the outline UI (desktop
 * tab and mobile selector).
 */
export interface OutlineItem {
  /** The DOM id assigned to the heading element (slug + dedupe suffix). */
  id: string
  /** Visible heading text. */
  text: string
  /** Heading level, 1–6. */
  level: number
}

/** Slugify heading text into a DOM-id-safe anchor. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** Restart the arrival-flash animation on a heading. */
function flashHeading(el: HTMLElement): void {
  el.classList.remove("flash-heading-highlight")
  // Force reflow so re-adding the class restarts the CSS animation.
  void el.offsetWidth
  el.classList.add("flash-heading-highlight")
  window.setTimeout(() => el.classList.remove("flash-heading-highlight"), 1400)
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

// Single in-flight scroll animation so rapid clicks don't fight each other.
let activeScrollRaf = 0

/**
 * Scroll the heading with the given element id to the top of the markdown
 * scroll container and flash it **on arrival** (so the highlight is visible
 * even after a long jump). Uses a custom animation with a consistent,
 * distance-clamped duration rather than native `scrollIntoView` (whose speed
 * and lack of a completion signal made long jumps feel inconsistent).
 */
export function scrollToHeading(id: string): void {
  const el = document.getElementById(id)
  if (!el) return

  const scroller =
    el.closest<HTMLElement>("[data-markdown-scroll]") ??
    document.querySelector<HTMLElement>("[data-markdown-scroll]")
  const prefersReduced =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches

  if (!scroller || prefersReduced) {
    el.scrollIntoView({ behavior: prefersReduced ? "auto" : "smooth", block: "start" })
    window.setTimeout(() => flashHeading(el), prefersReduced ? 0 : 360)
    return
  }

  const cRect = scroller.getBoundingClientRect()
  const eRect = el.getBoundingClientRect()
  const maxTop = scroller.scrollHeight - scroller.clientHeight
  // Land the heading ~24px below the container's top edge.
  const to = Math.max(0, Math.min(scroller.scrollTop + (eRect.top - cRect.top) - 24, maxTop))
  const start = scroller.scrollTop
  const dist = Math.abs(to - start)

  if (dist < 2) {
    flashHeading(el)
    return
  }

  // ~0.5ms/px, clamped to 280–620ms: short and long jumps both feel snappy but
  // remain legible. Easing makes it land softly.
  const duration = Math.min(620, Math.max(280, dist * 0.5))
  const startTime = performance.now()

  if (activeScrollRaf) cancelAnimationFrame(activeScrollRaf)
  const step = (now: number) => {
    const t = Math.min(1, (now - startTime) / duration)
    scroller.scrollTop = start + (to - start) * easeInOutCubic(t)
    if (t < 1) {
      activeScrollRaf = requestAnimationFrame(step)
    } else {
      activeScrollRaf = 0
      flashHeading(el)
    }
  }
  activeScrollRaf = requestAnimationFrame(step)
}
