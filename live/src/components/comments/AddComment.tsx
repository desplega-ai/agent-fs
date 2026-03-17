import { useState } from "react"
import { Send } from "lucide-react"
import { useAddComment } from "@/hooks/use-comments"

interface AddCommentProps {
  path: string
  parentId?: string
  lineStart?: number
  lineEnd?: number
  quotedContent?: string
  onDone?: () => void
  autoFocus?: boolean
  placeholder?: string
}

export function AddComment({
  path,
  parentId,
  lineStart,
  lineEnd,
  quotedContent,
  onDone,
  autoFocus,
  placeholder = "Add a comment...",
}: AddCommentProps) {
  const [body, setBody] = useState("")
  const addComment = useAddComment()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!body.trim()) return

    addComment.mutate(
      { path, body: body.trim(), parentId, lineStart, lineEnd, quotedContent },
      {
        onSuccess: () => {
          setBody("")
          onDone?.()
        },
      }
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        rows={2}
        className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            handleSubmit(e)
          }
        }}
      />
      <button
        type="submit"
        disabled={!body.trim() || addComment.isPending}
        className="self-end rounded-md p-2 text-primary hover:bg-accent disabled:opacity-40 transition-colors"
      >
        <Send className="h-4 w-4" />
      </button>
    </form>
  )
}
