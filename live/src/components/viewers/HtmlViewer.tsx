import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react"
import { Globe, MessageSquare } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { useHealth } from "@/hooks/use-health"
import { useCommentAnchors } from "@/hooks/use-comment-anchors"
import { approveRootHtml, folderOf, isRootHtmlApproved, resolveHtmlViewUrl, supportsHtmlComments, withCommentsFlag } from "@/lib/html-view"
import { captureQuote, resolveAnchor } from "@/lib/comment-anchor"
import { createHtmlCommentBridge, type HighlightRange, type HtmlCommentBridge } from "@/lib/html-comment-bridge"
import { frameTextSpace, htmlSourceTextSpace } from "@/lib/html-text-space"
import { commentAnchors, revealComment, useActiveComment, useHoveredComment } from "@/stores/comment-anchors"
import { toast } from "@/stores/toast"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { AddComment } from "@/components/comments/AddComment"
import { clampFormTop, clampLeft, COMMENT_BTN_HEIGHT, COMMENT_BTN_WIDTH, COMMENT_FORM_WIDTH, layoutViewport, VIEWPORT_MARGIN } from "@/lib/comment-popover-layout"
import type { CommentListEntry, CommentQuote } from "@/api/types"
import type { ScrollToCommentCallback } from "@/pages/FileBrowser"

// Never add `allow-same-origin`: the page must get an opaque origin, so it
// cannot read this app's localStorage (which holds the API key).
const SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"

/** The iframe URL of an HTML file, served from a short-lived site share of its folder. */
function useHtmlViewUrl(path: string, enabled: boolean, reloadKey: number) {
  const { client, orgId, driveId } = useAuth()
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!enabled || !orgId || !driveId) {
      setUrl(null)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)

    resolveHtmlViewUrl(client, orgId, driveId, path).then((next) => {
      if (!cancelled) {
        setUrl(next)
        setIsLoading(false)
      }
    }).catch((err) => {
      if (!cancelled) {
        setError((err as Error).message)
        setIsLoading(false)
      }
    })

    return () => { cancelled = true }
  }, [path, orgId, driveId, client, enabled, reloadKey])

  return { url, error, isLoading }
}

interface HtmlViewerProps {
  path: string
  className?: string
  /** Changes after a save, so the frame reloads with the new content. */
  reloadKey?: number
  onShowSource: () => void
  comments?: CommentListEntry[]
  /** The page's source. With it, and a server that adds the overlay, the page takes comments. */
  content?: string
  onScrollToCommentRef?: MutableRefObject<ScrollToCommentCallback | null>
}

export function HtmlViewer({ path, className, reloadKey = 0, onShowSource, comments, content, onScrollToCommentRef }: HtmlViewerProps) {
  const { orgId, driveId } = useAuth()
  const { data: health } = useHealth()
  const commenting = content != null && supportsHtmlComments(health)
  const frameRef = useRef<HTMLIFrameElement>(null)
  // A file at the drive root gets a share of the whole drive, so ask first.
  const atRoot = folderOf(path) === "/"
  const [confirmed, setConfirmed] = useState(() => !atRoot || (!!orgId && !!driveId && isRootHtmlApproved(orgId, driveId, path)))
  const { url, error, isLoading } = useHtmlViewUrl(path, confirmed, reloadKey)

  if (!confirmed) {
    return (
      <div className={cn("flex flex-col items-center justify-center gap-4 p-8 text-center", className)}>
        <Globe className="h-12 w-12 text-muted-foreground/50" />
        <p className="text-sm max-w-sm">
          This page can read every file in this drive for 15 minutes while it is open. Render it?
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => {
              if (orgId && driveId) approveRootHtml(orgId, driveId, path)
              setConfirmed(true)
            }}
          >
            Render
          </Button>
          <Button size="sm" variant="outline" onClick={onShowSource}>
            Show source
          </Button>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={cn("flex items-center justify-center p-8 text-sm text-destructive", className)}>
        Failed to load page: {error}
      </div>
    )
  }

  if (isLoading || !url) {
    return (
      <div className={cn("flex items-center justify-center p-8", className)}>
        <Spinner size="lg" />
      </div>
    )
  }

  const src = commenting ? withCommentsFlag(url) : url
  return (
    <div className={cn("relative flex flex-col", className)}>
      <iframe
        ref={frameRef}
        key={reloadKey}
        src={src}
        title={path}
        sandbox={SANDBOX}
        referrerPolicy="no-referrer"
        className="w-full flex-1 min-h-0 border-0 bg-white"
      />
      {commenting && (
        <HtmlComments
          frameRef={frameRef}
          src={src}
          reloadKey={reloadKey}
          path={path}
          comments={comments}
          content={content}
          onScrollToCommentRef={onScrollToCommentRef}
        />
      )}
    </div>
  )
}

/**
 * Comments on the page in the frame, through its overlay (`html-comment-bridge`).
 * Anchors resolve against the text the overlay reports, with the page source as
 * the line fallback; the overlay only paints the resolved ranges. The Comment
 * button floats over the frame at the selection.
 */
function HtmlComments({ frameRef, src, reloadKey, path, comments, content, onScrollToCommentRef }: {
  frameRef: RefObject<HTMLIFrameElement | null>
  src: string
  reloadKey: number
  path: string
  comments?: CommentListEntry[]
  content: string
  onScrollToCommentRef?: MutableRefObject<ScrollToCommentCallback | null>
}) {
  const [frameText, setFrameText] = useState<string | null>(null)
  const [selection, setSelection] = useState<{ start: number; end: number; rect: DOMRect } | null>(null)
  // What the open composer saves: a snapshot, so the page changing its text
  // while the user types cannot move the comment to another passage.
  const [draft, setDraft] = useState<{ quote: CommentQuote; lineStart?: number; lineEnd?: number; rect: DOMRect } | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const bridgeRef = useRef<HtmlCommentBridge | null>(null)
  const frameSpace = useMemo(() => (frameText == null ? null : frameTextSpace(frameText)), [frameText])
  const sourceSpace = useMemo(() => htmlSourceTextSpace(content), [content])
  const anchors = useCommentAnchors(path, comments, frameSpace, sourceSpace)
  const anchorsRef = useRef(anchors)
  anchorsRef.current = anchors
  const hovered = useHoveredComment()
  const active = useActiveComment()

  const clear = useCallback(() => {
    setDraft(null)
    setSelection(null)
    bridgeRef.current?.post({ type: "clear" })
  }, [])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    setFrameText(null)
    clear()
    const bridge = createHtmlCommentBridge(frame, new URL(src, location.href).pathname, (msg) => {
      if (msg.type === "text") setFrameText(msg.text)
      else if (msg.type === "reset") {
        // The frame left the page: its text and any composer belong to that page.
        setFrameText(null)
        clear()
      }
      else if (msg.type === "activate") revealComment(msg.id)
      else if (msg.type === "hover") commentAnchors.setHovered(msg.id, "doc")
      else if (msg.type === "selection" && !draftRef.current) {
        if ("cleared" in msg) return setSelection(null)
        const f = frame.getBoundingClientRect()
        setSelection({ start: msg.start, end: msg.end, rect: new DOMRect(f.left + msg.rect.left, f.top + msg.rect.top, msg.rect.width, msg.rect.height) })
      }
    })
    bridgeRef.current = bridge
    return () => {
      bridge.dispose()
      bridgeRef.current = null
      commentAnchors.setHovered(null, "doc")
    }
  }, [frameRef, src, reloadKey, clear])

  // Ranges and states only: comment bodies and authors never enter the frame.
  useEffect(() => {
    const ranges: HighlightRange[] = []
    anchors.forEach((r, id) => {
      if (r.start == null || r.end == null || r.end <= r.start) return
      const state = hovered?.id === id || active === id ? "active" : r.status === "moved" ? "moved" : "anchored"
      ranges.push({ id, start: r.start, end: r.end, state })
    })
    bridgeRef.current?.post({ type: "highlights", ranges })
  }, [anchors, hovered, active])

  if (onScrollToCommentRef) {
    onScrollToCommentRef.current = ({ commentId }) => {
      const r = commentId ? anchorsRef.current.get(commentId) : undefined
      if (!r || !commentId) return
      if (r.start == null) toast("The text this comment pointed to is no longer in the file")
      else bridgeRef.current?.post({ type: "reveal", id: commentId })
    }
  }

  useEffect(() => {
    if (!selection) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      e.stopImmediatePropagation()
      clear()
    }
    document.addEventListener("keydown", onKeyDown, true)
    return () => document.removeEventListener("keydown", onKeyDown, true)
  }, [selection, clear])

  // The quote comes from the page text; the lines from where it sits in the
  // source, when it is there (text a script adds has none).
  const target = useMemo(() => {
    if (!selection || frameText == null) return null
    const quote = captureQuote(frameText, selection.start, selection.end)
    if (!quote) return null
    const inSource = resolveAnchor(sourceSpace, { quote })
    const placed = inSource.status === "anchored" && !inSource.ambiguous
    return { quote, lineStart: placed ? inSource.lineStart : undefined, lineEnd: placed ? inSource.lineEnd : undefined }
  }, [selection, frameText, sourceSpace])

  if (!draft) {
    if (!selection || !target) return null
    const rect = selection.rect
    return (
      <button
        data-comment-ui
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setDraft({ ...target, rect })}
        className="fixed z-50 flex items-center gap-1.5 rounded-lg bg-foreground px-2.5 py-1.5 text-xs font-medium text-background shadow-lg transition-transform hover:scale-105 active:scale-95"
        style={{
          top: Math.min(rect.bottom + 6, window.innerHeight - COMMENT_BTN_HEIGHT - VIEWPORT_MARGIN),
          left: clampLeft(rect.left + rect.width / 2 - COMMENT_BTN_WIDTH / 2, COMMENT_BTN_WIDTH, layoutViewport()),
        }}
      >
        <MessageSquare className="size-3" />
        Comment
      </button>
    )
  }
  return (
    <div
      data-comment-ui
      className="fixed z-50 w-80 max-h-[80vh] overflow-y-auto rounded-lg border border-border bg-popover p-3 shadow-lg"
      style={{ top: clampFormTop(draft.rect, 220, layoutViewport()), left: clampLeft(draft.rect.left - 40, COMMENT_FORM_WIDTH, layoutViewport()) }}
    >
      <AddComment
        path={path}
        lineStart={draft.lineStart}
        lineEnd={draft.lineEnd}
        quotedContent={draft.quote.exact.slice(0, 200)}
        quote={draft.quote}
        autoFocus
        onDone={clear}
      />
      <button onClick={clear} className="mt-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
        Cancel
      </button>
    </div>
  )
}
