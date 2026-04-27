import { useState, useRef, useCallback, useEffect, type MutableRefObject } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { MessageSquarePlus, MessageSquare } from "lucide-react"
import { cn } from "@/lib/utils"
import { AddComment } from "@/components/comments/AddComment"
import type { CommentListEntry } from "@/api/types"
import type { ScrollToCommentCallback } from "@/pages/FileBrowser"

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
      <div
        ref={contentRef}
        className="flex-1 overflow-auto px-6 py-8 lg:px-12"
        onMouseUp={handleMouseUp}
      >
        <div className="prose prose-neutral dark:prose-invert prose-sm max-w-none leading-relaxed prose-headings:scroll-mt-8 prose-pre:bg-muted/60 prose-pre:border prose-pre:border-border">
          <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
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
