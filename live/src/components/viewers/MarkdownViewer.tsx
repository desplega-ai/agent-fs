import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo, isValidElement, Fragment, type MutableRefObject, type ReactNode } from "react"
import Markdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeHighlight from "rehype-highlight"
import { MessageSquarePlus, MessageSquare, Maximize2, Minimize2, ListTree } from "lucide-react"
import { cn } from "@/lib/utils"
import { AddComment } from "@/components/comments/AddComment"
import { MermaidDiagram } from "./MermaidDiagram"
import { ExpandableImage } from "./ExpandableImage"
import { CodeBlock } from "./CodeBlock"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useLocalStorage } from "@/hooks/use-local-storage"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { Kbd } from "@/components/ui/kbd"
import { slugify, scrollToHeading, type OutlineItem } from "@/lib/outline"
import { computeActiveHeadings } from "@/hooks/use-active-headings"
import type { CommentListEntry } from "@/api/types"
import type { ScrollToCommentCallback } from "@/pages/FileBrowser"

function extractMermaidCode(children: ReactNode): string | null {
  if (!isValidElement(children)) return null
  const props = children.props as { className?: string; children?: ReactNode }
  if (!/(?:^|\s)language-mermaid(?:\s|$)/.test(props.className ?? "")) return null
  const text = typeof props.children === "string"
    ? props.children
    : Array.isArray(props.children)
      ? props.children.filter((c) => typeof c === "string").join("")
      : ""
  return text.replace(/\n$/, "")
}

const markdownComponents: Components = {
  pre({ node: _node, ...props }) {
    const code = extractMermaidCode(props.children)
    if (code !== null) return <MermaidDiagram code={code} />
    return <CodeBlock {...props} />
  },
  img({ src, alt, title }) {
    if (typeof src !== "string" || !src) return null
    return <ExpandableImage src={src} alt={alt} title={title} />
  },
}

type FrontmatterValue = string | number | boolean | null | FrontmatterValue[]
type FrontmatterRecord = Record<string, FrontmatterValue>

function parseScalar(raw: string): FrontmatterValue {
  const v = raw.trim()
  if (v === "" || v === "~" || v === "null") return null
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  if (v === "true") return true
  if (v === "false") return false
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v
}

/**
 * Extract leading YAML frontmatter (delimited by `---` lines) and parse the
 * common subset: `key: scalar`, inline `[a, b]` arrays, and block `- item`
 * lists. Anything beyond that falls through as a string. Returns the parsed
 * record (or null if no frontmatter) plus the markdown body with the block
 * stripped.
 */
function extractFrontmatter(content: string): { frontmatter: FrontmatterRecord | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (!match) return { frontmatter: null, body: content }
  const body = content.slice(match[0].length)
  const lines = match[1].split(/\r?\n/)
  const result: FrontmatterRecord = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith("#")) { i++; continue }
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) { i++; continue }
    const key = m[1]
    const rest = m[2]
    if (rest.trim() === "") {
      const items: FrontmatterValue[] = []
      i++
      while (i < lines.length) {
        const child = lines[i]
        if (!child.startsWith("  ") && !child.startsWith("\t") && child.trim() !== "") break
        const trimmed = child.replace(/^(?:\t|  )/, "")
        if (trimmed.startsWith("- ")) items.push(parseScalar(trimmed.slice(2)))
        i++
      }
      result[key] = items
      continue
    }
    if (rest.trim().startsWith("[") && rest.trim().endsWith("]")) {
      const inner = rest.trim().slice(1, -1).trim()
      result[key] = inner ? inner.split(/\s*,\s*/).map(parseScalar) : []
    } else {
      result[key] = parseScalar(rest)
    }
    i++
  }
  return { frontmatter: Object.keys(result).length ? result : null, body }
}

function FrontmatterValueDisplay({ value }: { value: FrontmatterValue }) {
  if (value === null) {
    return <span className="text-muted-foreground italic">null</span>
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-muted-foreground italic">empty</span>
    }
    return (
      <div className="flex flex-wrap gap-1.5">
        {value.map((item, i) => (
          <span
            key={i}
            className="inline-flex rounded-md bg-accent px-1.5 py-0.5 text-xs text-foreground"
          >
            {item === null ? "null" : String(item)}
          </span>
        ))}
      </div>
    )
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return <span className="font-mono text-xs">{String(value)}</span>
  }
  return <span className="break-words">{value}</span>
}

function FrontmatterBlock({ data }: { data: FrontmatterRecord }) {
  const entries = Object.entries(data)
  if (entries.length === 0) return null
  return (
    <div className="not-prose mb-6 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2">
        {entries.map(([key, value]) => (
          <Fragment key={key}>
            <dt className="self-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {key}
            </dt>
            <dd className="min-w-0 self-center">
              <FrontmatterValueDisplay value={value} />
            </dd>
          </Fragment>
        ))}
      </dl>
    </div>
  )
}

// Floating UI sizing constants used to keep the comment button/form inside the
// viewport (feedback: "never overflow from the visible document").
const VIEWPORT_MARGIN = 8
const COMMENT_FORM_WIDTH = 320
const COMMENT_BTN_WIDTH = 108
const COMMENT_BTN_HEIGHT = 32

/** Clamp an x-coordinate so a box of the given width stays on screen. */
function clampLeft(left: number, width: number): number {
  const max = window.innerWidth - width - VIEWPORT_MARGIN
  return Math.max(VIEWPORT_MARGIN, Math.min(left, Math.max(VIEWPORT_MARGIN, max)))
}

/** Pick a y-coordinate for the form: below the anchor, else flipped above. */
function clampFormTop(rect: DOMRect, formHeight: number): number {
  const below = rect.bottom + 10
  if (below + formHeight + VIEWPORT_MARGIN <= window.innerHeight) return below
  const above = rect.top - formHeight - 10
  if (above >= VIEWPORT_MARGIN) return above
  return Math.max(VIEWPORT_MARGIN, window.innerHeight - formHeight - VIEWPORT_MARGIN)
}

interface MarkdownViewerProps {
  content: string
  path: string
  comments?: CommentListEntry[]
  className?: string
  onScrollToCommentRef?: MutableRefObject<ScrollToCommentCallback | null>
  /** Reports the document outline (headings) up to the page/right rail. */
  onOutlineChange?: (items: OutlineItem[]) => void
}

export function MarkdownViewer({ content, path, comments, className, onScrollToCommentRef, onOutlineChange }: MarkdownViewerProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  // Selected text + the live anchor rect that tracks it (recomputed on scroll
  // so the comment UI stays glued to the selection).
  const [selection, setSelection] = useState<{ text: string } | null>(null)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const anchorRectFnRef = useRef<(() => DOMRect | null) | null>(null)
  const [showCommentForm, setShowCommentForm] = useState(false)
  const formRef = useRef<HTMLDivElement>(null)
  const [formHeight, setFormHeight] = useState(0)
  const [fullWidth, setFullWidth] = useLocalStorage("liveui:markdown:full-width", false)
  const [outline, setOutline] = useState<OutlineItem[]>([])
  // Mobile outline selector: active heading is computed once on open (no
  // always-on scroll listener needed for a transient menu).
  const [outlineMenuOpen, setOutlineMenuOpen] = useState(false)
  const [mobileActiveId, setMobileActiveId] = useState<string | null>(null)
  const { frontmatter, body } = useMemo(() => extractFrontmatter(content), [content])

  // Memoise the rendered markdown so high-frequency state updates (e.g. the
  // comment box tracking the selection on scroll) don't force react-markdown to
  // re-parse the whole document every frame. Keyed only on the body.
  const renderedMarkdown = useMemo(
    () => (
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={markdownComponents}
      >
        {body}
      </Markdown>
    ),
    [body],
  )

  // `w` toggles reading vs full width (only while a markdown preview is mounted).
  useKeyboardShortcuts({
    w: (e) => {
      e.preventDefault()
      setFullWidth(!fullWidth)
    },
  })

  // Scroll to comment: find matching text in preview and scroll + flash
  if (onScrollToCommentRef) {
    onScrollToCommentRef.current = ({ quotedContent }) => {
      if (!quotedContent || !contentRef.current) return
      const needle = quotedContent.trim().toLowerCase().slice(0, 40)
      const walker = document.createTreeWalker(contentRef.current, NodeFilter.SHOW_ELEMENT)
      let node: Node | null = walker.currentNode
      while (node) {
        const el = node as HTMLElement
        const text = el.textContent?.trim().toLowerCase() ?? ""
        if (text.includes(needle) && el.children.length === 0) {
          el.scrollIntoView({ behavior: "smooth", block: "center" })
          el.classList.add("flash-comment-highlight")
          setTimeout(() => el.classList.remove("flash-comment-highlight"), 2000)
          return
        }
        node = walker.nextNode()
      }
    }
  }

  // Post-render: scan the rendered headings, give each a stable id, and report
  // the outline up. Single source of truth — the outline UI (desktop tab and
  // mobile selector) jumps to these ids.
  useEffect(() => {
    const container = contentRef.current
    if (!container) return
    const headings = container.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")
    const seen = new Map<string, number>()
    const items: OutlineItem[] = []
    headings.forEach((el) => {
      const text = el.textContent?.trim() ?? ""
      if (!text) return
      let id = slugify(text) || "section"
      const n = seen.get(id) ?? 0
      seen.set(id, n + 1)
      if (n > 0) id = `${id}-${n}`
      el.id = id
      items.push({ id, text, level: Number(el.tagName[1]) })
    })
    setOutline(items)
    onOutlineChange?.(items)
  }, [body, onOutlineChange])

  // Post-render: scan DOM and add highlight classes to elements matching comments
  // This avoids wrapping elements with React components (which kills native selection)
  useEffect(() => {
    const container = contentRef.current
    if (!container || !comments?.length) return

    const commentableSelectors = "p, h1, h2, h3, h4, h5, h6, li, blockquote"
    const elements = container.querySelectorAll(commentableSelectors)
    const highlightClass = "comment-indicator"

    elements.forEach((el) => {
      const text = el.textContent?.trim().toLowerCase() ?? ""
      const hasMatch = comments.some(c =>
        c.quotedContent && text.includes(c.quotedContent.trim().toLowerCase().slice(0, 40))
      )
      el.classList.toggle(highlightClass, hasMatch)
    })

    return () => {
      elements.forEach((el) => el.classList.remove(highlightClass))
    }
  }, [comments])

  // Track hovered element for the + button
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [hoverComment, setHoverComment] = useState<{ text: string; rect: DOMRect; el: HTMLElement } | null>(null)

  useEffect(() => {
    const container = contentRef.current
    if (!container) return

    const commentableSelectors = "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, tr"

    const clearHoverTimeout = () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current)
        hoverTimeoutRef.current = null
      }
    }

    const handleMouseOver = (e: MouseEvent) => {
      if (showCommentForm || selection) return
      const target = (e.target as HTMLElement).closest(commentableSelectors) as HTMLElement | null
      if (!target || !container.contains(target)) return
      clearHoverTimeout()
      const rect = target.getBoundingClientRect()
      const text = target.textContent?.trim().slice(0, 200) ?? ""
      if (text) setHoverComment({ text, rect, el: target })
    }

    const handleMouseLeave = () => {
      clearHoverTimeout()
      hoverTimeoutRef.current = setTimeout(() => {
        if (!document.querySelector("[data-hover-comment]:hover")) {
          setHoverComment(null)
        }
      }, 500)
    }

    container.addEventListener("mouseover", handleMouseOver)
    container.addEventListener("mouseleave", handleMouseLeave)
    return () => {
      container.removeEventListener("mouseover", handleMouseOver)
      container.removeEventListener("mouseleave", handleMouseLeave)
      clearHoverTimeout()
    }
  }, [showCommentForm, selection])

  /** Begin a comment anchored to a DOM rect source (text range or element). */
  const beginComment = useCallback((text: string, getRect: () => DOMRect | null) => {
    anchorRectFnRef.current = getRect
    const rect = getRect()
    setSelection({ text })
    if (rect) setAnchorRect(rect)
    setHoverComment(null)
  }, [])

  const clearComment = useCallback(() => {
    setShowCommentForm(false)
    setSelection(null)
    setAnchorRect(null)
    anchorRectFnRef.current = null
    setHoverComment(null)
    window.getSelection()?.removeAllRanges()
  }, [])

  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !contentRef.current) {
      setSelection(null)
      return
    }

    if (!contentRef.current.contains(sel.anchorNode) || !contentRef.current.contains(sel.focusNode)) {
      return
    }

    const text = sel.toString().trim()
    if (!text) {
      setSelection(null)
      return
    }

    // Clone the range so the anchor rect can be recomputed as the user scrolls.
    const range = sel.getRangeAt(0).cloneRange()
    beginComment(text, () => range.getBoundingClientRect())
  }, [beginComment])

  // Keep the comment UI glued to the selection while the document scrolls or
  // resizes (feedback: "make comment box sticky to the selection").
  useEffect(() => {
    if (!selection) return
    let raf = 0
    const update = () => {
      raf = 0
      const rect = anchorRectFnRef.current?.()
      if (rect) setAnchorRect(rect)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    // capture=true so we also catch scrolls from the inner overflow container.
    window.addEventListener("scroll", onScroll, true)
    window.addEventListener("resize", onScroll)
    return () => {
      window.removeEventListener("scroll", onScroll, true)
      window.removeEventListener("resize", onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [selection])

  // Esc closes the comment UI. Capture phase + stopImmediatePropagation so Esc
  // is consumed here and does not reach other document-level handlers.
  useEffect(() => {
    if (!showCommentForm && !selection) return
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      e.stopImmediatePropagation()
      clearComment()
    }
    document.addEventListener("keydown", onKeyDownCapture, true)
    return () => document.removeEventListener("keydown", onKeyDownCapture, true)
  }, [showCommentForm, selection, clearComment])

  // Measure the form so we can flip it above the selection near the viewport
  // bottom rather than letting it run off screen.
  useLayoutEffect(() => {
    if (showCommentForm && formRef.current) {
      setFormHeight(formRef.current.offsetHeight)
    }
  }, [showCommentForm, selection, anchorRect])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (showCommentForm) return
      const target = e.target as HTMLElement
      if (target.closest("[data-comment-ui]") || target.closest("[data-hover-comment]")) return
      if (!contentRef.current?.contains(target)) {
        setSelection(null)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [showCommentForm])

  const minOutlineLevel = outline.length ? Math.min(...outline.map((i) => i.level)) : 1

  return (
    <div className={cn("relative flex flex-col", className)}>
      {/* Mobile: outline selector (desktop uses the right-rail Outline tab). */}
      {outline.length > 0 && (
        <div className="absolute top-2 left-3 z-10 lg:hidden">
          <DropdownMenu
            open={outlineMenuOpen}
            onOpenChange={(open) => {
              setOutlineMenuOpen(open)
              if (open) setMobileActiveId(computeActiveHeadings(outline).activeId)
            }}
          >
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground bg-background/70 backdrop-blur"
                  aria-label="Document outline"
                  title="Document outline"
                >
                  <ListTree />
                </Button>
              }
            />
            <DropdownMenuContent align="start" className="max-h-[60vh] w-64 overflow-y-auto">
              {outline.map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  onClick={() => scrollToHeading(item.id)}
                  className={cn("truncate", item.id === mobileActiveId && "font-medium text-foreground")}
                  style={{ paddingLeft: `${(item.level - minOutlineLevel) * 12 + 8}px` }}
                >
                  {item.text}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <div className="absolute top-2 right-3 z-10">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setFullWidth(!fullWidth)}
                className="text-muted-foreground bg-background/70 backdrop-blur"
                aria-label={fullWidth ? "Reading width" : "Full width"}
              >
                {fullWidth ? <Minimize2 /> : <Maximize2 />}
              </Button>
            }
          />
          <TooltipContent>{fullWidth ? "Reading width" : "Full width"} <Kbd className="ml-1">W</Kbd></TooltipContent>
        </Tooltip>
      </div>
      <div
        ref={contentRef}
        data-markdown-scroll
        className="flex-1 overflow-auto px-6 py-8 lg:px-12"
        onMouseUp={handleMouseUp}
      >
        <div
          className={cn(
            "prose prose-neutral dark:prose-invert prose-sm leading-relaxed prose-headings:scroll-mt-8 prose-pre:bg-muted/60 prose-pre:text-foreground prose-pre:border prose-pre:border-border",
            fullWidth ? "max-w-none" : "max-w-3xl mx-auto",
          )}
        >
          {frontmatter && <FrontmatterBlock data={frontmatter} />}
          {renderedMarkdown}
        </div>
      </div>

      {/* Hover comment button on left margin */}
      {hoverComment && !selection && !showCommentForm && (
        <button
          data-hover-comment
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const el = hoverComment.el
            beginComment(hoverComment.text, () => el.getBoundingClientRect())
            setShowCommentForm(true)
          }}
          className="fixed z-40 flex items-center justify-center size-6 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-all"
          style={{
            top: hoverComment.rect.top + 2,
            left: Math.max(VIEWPORT_MARGIN, hoverComment.rect.left - 32),
          }}
          title="Add comment"
        >
          <MessageSquarePlus className="size-3.5" />
        </button>
      )}

      {/* Floating comment button on text selection */}
      {selection && anchorRect && !showCommentForm && (
        <button
          data-comment-ui
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setShowCommentForm(true)}
          className="fixed z-50 flex items-center gap-1.5 rounded-lg bg-foreground px-2.5 py-1.5 text-xs font-medium text-background shadow-lg transition-transform hover:scale-105 active:scale-95"
          style={{
            top: Math.min(anchorRect.bottom + 6, window.innerHeight - COMMENT_BTN_HEIGHT - VIEWPORT_MARGIN),
            left: clampLeft(anchorRect.left + anchorRect.width / 2 - COMMENT_BTN_WIDTH / 2, COMMENT_BTN_WIDTH),
          }}
        >
          <MessageSquare className="size-3" />
          Comment
        </button>
      )}

      {/* Comment form */}
      {showCommentForm && selection && anchorRect && (
        <div
          ref={formRef}
          data-comment-ui
          className="fixed z-50 w-80 max-h-[80vh] overflow-y-auto rounded-lg border border-border bg-popover p-3 shadow-lg"
          style={{
            top: clampFormTop(anchorRect, formHeight || 220),
            left: clampLeft(anchorRect.left - 40, COMMENT_FORM_WIDTH),
          }}
        >
          <AddComment
            path={path}
            quotedContent={selection.text.slice(0, 200)}
            autoFocus
            onDone={clearComment}
          />
          <button
            onClick={clearComment}
            className="mt-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
