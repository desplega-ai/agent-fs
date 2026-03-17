import { useState } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Code, Eye } from "lucide-react"
import { cn } from "@/lib/utils"
import { TextViewer } from "./TextViewer"

interface MarkdownViewerProps {
  content: string
  path: string
  className?: string
}

export function MarkdownViewer({ content, path, className }: MarkdownViewerProps) {
  const [showRaw, setShowRaw] = useState(false)

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex items-center justify-end border-b border-border px-3 py-1">
        <button
          onClick={() => setShowRaw(!showRaw)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          {showRaw ? <Eye className="h-3 w-3" /> : <Code className="h-3 w-3" />}
          {showRaw ? "Preview" : "Source"}
        </button>
      </div>

      {showRaw ? (
        <TextViewer content={content} path={path} className="flex-1" />
      ) : (
        <div className="flex-1 overflow-auto p-6">
          <div className="prose prose-neutral dark:prose-invert max-w-none prose-sm">
            <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
          </div>
        </div>
      )}
    </div>
  )
}
