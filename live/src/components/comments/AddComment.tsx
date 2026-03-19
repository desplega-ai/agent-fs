import { useState } from "react"
import { Send } from "lucide-react"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
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
    <form onSubmit={handleSubmit} className="space-y-2">
      {/* Show what's being commented on */}
      {(quotedContent || lineStart) && (
        <div className="rounded border-l-2 border-amber-400/50 bg-amber-500/5 px-2 py-1 text-xs text-muted-foreground">
          {lineStart && (
            <span className="font-mono text-amber-600 dark:text-amber-400 mr-1">
              L{lineStart}{lineEnd && lineEnd !== lineStart ? `-${lineEnd}` : ""}
            </span>
          )}
          {quotedContent && (
            <span className="line-clamp-2 font-mono">{quotedContent}</span>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          rows={2}
          className="flex-1 resize-y text-sm min-h-[3.5rem]"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              handleSubmit(e)
            }
          }}
        />
        <Button
          type="submit"
          variant="ghost"
          size="icon"
          disabled={!body.trim() || addComment.isPending}
          className="self-end text-primary"
        >
          <Send />
        </Button>
      </div>
    </form>
  )
}
