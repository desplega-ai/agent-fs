import { useState, useRef, useCallback, useEffect, useMemo, isValidElement, Fragment, type MutableRefObject, type ReactNode } from "react"
import Markdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeHighlight from "rehype-highlight"
import { MessageSquarePlus, MessageSquare, Maximize2, Minimize2 } from "lucide-react"
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
import { useLocalStorage } from "@/hooks/use-local-storage"
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

interface MarkdownViewerProps {
  content: string
  path: string
  comments?: CommentListEntry[]
  className?: string
  onScrollToCommentRef?: MutableRefObject<ScrollToCommentCallback | null>
}

export function MarkdownViewer({ content, path, comments, className, onScrollToCommentRef }: MarkdownViewerProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<{ text: string; rect: DOMRect } | null>(null)
  const [showCommentForm, setShowCommentForm] = useState(false)
  const [fullWidth, setFullWidth] = useLocalStorage("liveui:markdown:full-width", false)
  const { frontmatter, body } = useMemo(() => extractFrontmatter(content), [content])

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
  const [hoverComment, setHoverComment] = useState<{ text: string; rect: DOMRect } | null>(null)

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
      const target = (e.target as HTMLElement).closest(commentableSelectors)
      if (!target || !container.contains(target)) return
      clearHoverTimeout()
      const rect = target.getBoundingClientRect()
      const text = target.textContent?.trim().slice(0, 200) ?? ""
      if (text) setHoverComment({ text, rect })
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

    const range = sel.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    setSelection({ text, rect })
    setHoverComment(null)
  }, [])

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

  return (
    <div className={cn("relative flex flex-col", className)}>
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
          <TooltipContent>{fullWidth ? "Reading width" : "Full width"}</TooltipContent>
        </Tooltip>
      </div>
      <div
        ref={contentRef}
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
          <Markdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
            components={markdownComponents}
          >
            {body}
          </Markdown>
        </div>
      </div>

      {/* Hover comment button on left margin */}
      {hoverComment && !selection && !showCommentForm && (
        <button
          data-hover-comment
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setSelection({ text: hoverComment.text, rect: hoverComment.rect })
            setShowCommentForm(true)
            setHoverComment(null)
          }}
          className="fixed z-40 flex items-center justify-center size-6 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-all"
          style={{
            top: hoverComment.rect.top + 2,
            left: hoverComment.rect.left - 32,
          }}
          title="Add comment"
        >
          <MessageSquarePlus className="size-3.5" />
        </button>
      )}

      {/* Floating comment button on text selection */}
      {selection && !showCommentForm && (
        <button
          data-comment-ui
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setShowCommentForm(true)}
          className="fixed z-50 flex items-center gap-1.5 rounded-lg bg-foreground px-2.5 py-1.5 text-xs font-medium text-background shadow-lg transition-transform hover:scale-105 active:scale-95"
          style={{
            top: selection.rect.bottom + 6,
            left: selection.rect.left + selection.rect.width / 2 - 44,
          }}
        >
          <MessageSquare className="size-3" />
          Comment
        </button>
      )}

      {/* Comment form */}
      {showCommentForm && selection && (
        <div
          data-comment-ui
          className="fixed z-50 w-80 rounded-lg border border-border bg-popover p-3 shadow-lg"
          style={{
            top: selection.rect.bottom + 10,
            left: Math.max(8, selection.rect.left - 40),
          }}
        >
          <AddComment
            path={path}
            quotedContent={selection.text.slice(0, 200)}
            autoFocus
            onDone={() => {
              setShowCommentForm(false)
              setSelection(null)
              window.getSelection()?.removeAllRanges()
            }}
          />
          <button
            onClick={() => {
              setShowCommentForm(false)
              setSelection(null)
              window.getSelection()?.removeAllRanges()
            }}
            className="mt-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
