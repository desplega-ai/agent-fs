import { useEffect, useState, useRef } from "react"
import { createHighlighter, type Highlighter } from "shiki"
import { MessageSquare } from "lucide-react"
import { cn } from "@/lib/utils"
import { useTextSelection } from "@/hooks/use-text-selection"
import { AddComment } from "@/components/comments/AddComment"
import type { CommentListEntry } from "@/api/types"

const COMMON_LANGS = [
  "typescript", "javascript", "json", "html", "css", "markdown",
  "python", "rust", "go", "yaml", "toml", "bash", "sql", "tsx", "jsx",
]

let highlighterPromise: Promise<Highlighter> | null = null

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: COMMON_LANGS,
    })
  }
  return highlighterPromise
}

function extToLang(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", rs: "rust", go: "go", md: "markdown",
    yml: "yaml", yaml: "yaml", toml: "toml", sh: "bash",
    css: "css", html: "html", json: "json", sql: "sql",
  }
  return map[ext] || "text"
}

interface TextViewerProps {
  content: string
  path: string
  truncated?: boolean
  highlightLines?: number[]
  comments?: CommentListEntry[]
  className?: string
}

export function TextViewer({ content, path, truncated, highlightLines, comments, className }: TextViewerProps) {
  const [html, setHtml] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const { selection, clearSelection } = useTextSelection(containerRef)
  const [showCommentForm, setShowCommentForm] = useState(false)

  useEffect(() => {
    let cancelled = false
    const lang = extToLang(path)

    getHighlighter().then(async (h) => {
      if (cancelled) return
      const loaded = h.getLoadedLanguages()
      if (!loaded.includes(lang) && lang !== "text") {
        try {
          await h.loadLanguage(lang as Parameters<typeof h.loadLanguage>[0])
        } catch {
          // Fall back to plain text
        }
      }

      const result = h.codeToHtml(content, {
        lang: h.getLoadedLanguages().includes(lang) ? lang : "text",
        themes: { light: "github-light", dark: "github-dark" },
      })
      if (!cancelled) setHtml(result)
    })

    return () => { cancelled = true }
  }, [content, path])

  // Build a set of lines that have comments
  const commentedLines = new Set<number>()
  comments?.forEach((c) => {
    if (c.lineStart) {
      for (let i = c.lineStart; i <= (c.lineEnd ?? c.lineStart); i++) {
        commentedLines.add(i)
      }
    }
  })

  const lines = content.split("\n")

  const handleCommentClick = () => {
    setShowCommentForm(true)
  }

  return (
    <div className={cn("relative overflow-auto font-mono text-sm", className)} ref={containerRef}>
      {html ? (
        <div className="relative">
          {/* Line numbers + gutter markers */}
          <div className="absolute left-0 top-0 flex flex-col select-none text-right pr-1 pl-2 text-muted-foreground/50 [&>span]:leading-[1.7142857]">
            {lines.map((_, i) => (
              <span
                key={i}
                className={cn(
                  "text-xs flex items-center justify-end gap-1",
                  highlightLines?.includes(i + 1) && "bg-blue-500/10 text-blue-500"
                )}
              >
                {commentedLines.has(i + 1) && (
                  <MessageSquare className="h-2.5 w-2.5 text-blue-500" />
                )}
                {i + 1}
              </span>
            ))}
          </div>
          {/* Highlighted code */}
          <div
            className="pl-14 [&>pre]:!bg-transparent [&>pre]:!p-0 [&>pre>code]:!bg-transparent [&>pre>code>span]:leading-[1.7142857]"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      ) : (
        <pre className="pl-14 whitespace-pre-wrap">
          <code>{content}</code>
        </pre>
      )}

      {truncated && (
        <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          File truncated. Showing first {lines.length} lines.
        </div>
      )}

      {/* Floating comment button on text selection */}
      {selection && !showCommentForm && (
        <button
          onClick={handleCommentClick}
          className="fixed z-50 flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground shadow-lg"
          style={{
            top: selection.rect.bottom + 4,
            left: selection.rect.left + selection.rect.width / 2 - 40,
          }}
        >
          <MessageSquare className="h-3 w-3" />
          Comment
        </button>
      )}

      {/* Inline comment form */}
      {showCommentForm && selection && (
        <div
          className="fixed z-50 w-80 rounded-md border border-border bg-popover p-3 shadow-lg"
          style={{
            top: selection.rect.bottom + 8,
            left: Math.max(8, selection.rect.left - 40),
          }}
        >
          <AddComment
            path={path}
            lineStart={selection.lineStart}
            lineEnd={selection.lineEnd}
            quotedContent={selection.text.slice(0, 200)}
            autoFocus
            onDone={() => {
              setShowCommentForm(false)
              clearSelection()
            }}
          />
          <button
            onClick={() => {
              setShowCommentForm(false)
              clearSelection()
            }}
            className="mt-2 text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
