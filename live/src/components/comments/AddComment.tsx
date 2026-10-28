import { useId, useRef, useState } from "react"
import { Send } from "lucide-react"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useAddComment } from "@/hooks/use-comments"
import { useHealth } from "@/hooks/use-health"
import { useDriveMembers } from "@/hooks/use-org-members"
import { useAuth } from "@/contexts/auth"
import { supportsCommentMentions } from "@/lib/comment-mentions"
import type { CommentQuote } from "@/api/types"
import { useMentionPicker } from "./MentionPicker"

interface AddCommentProps {
  path: string
  parentId?: string
  lineStart?: number
  lineEnd?: number
  quotedContent?: string
  /** Text-quote anchor ({ exact, prefix, suffix }) for robust re-anchoring. */
  quote?: CommentQuote
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
  quote,
  onDone,
  autoFocus,
  placeholder = "Add a comment...",
}: AddCommentProps) {
  const [body, setBody] = useState("")
  const [showEmptyHint, setShowEmptyHint] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const hintId = useId()
  const addComment = useAddComment()
  const { user } = useAuth()
  const { data: health } = useHealth()
  const { data: driveMembers } = useDriveMembers()
  const mention = useMentionPicker({
    value: body,
    onValueChange: setBody,
    members: supportsCommentMentions(health) ? driveMembers?.members ?? [] : [],
    selfId: user?.userId,
    textareaRef,
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (addComment.isPending) return
    // Keep Send clickable and explain the empty case instead of a dead button.
    if (!body.trim()) {
      setShowEmptyHint(true)
      textareaRef.current?.focus()
      return
    }

    const mentions = mention.mentions
    addComment.mutate(
      {
        path,
        body: body.trim(),
        parentId,
        lineStart,
        lineEnd,
        quotedContent,
        quote,
        ...(mentions.length > 0 && { mentions }),
      },
      {
        onSuccess: () => {
          setBody("")
          mention.reset()
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
          ref={textareaRef}
          {...mention.textareaProps}
          value={body}
          onChange={(e) => {
            setBody(e.target.value)
            mention.syncCaret(e.target)
            if (e.target.value.trim()) setShowEmptyHint(false)
          }}
          aria-describedby={showEmptyHint ? hintId : undefined}
          placeholder={placeholder}
          autoFocus={autoFocus}
          rows={2}
          className="flex-1 resize-y min-h-[3.5rem]"
          onKeyDown={(e) => {
            if (mention.handleKeyDown(e)) return
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              handleSubmit(e)
            }
          }}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="submit"
                variant="ghost"
                size="icon"
                disabled={addComment.isPending}
                className="self-end text-primary"
                aria-label="Send comment"
              >
                <Send />
              </Button>
            }
          />
          <TooltipContent>Send (⌘⏎)</TooltipContent>
        </Tooltip>
      </div>
      {mention.list}
      {showEmptyHint && (
        <p id={hintId} role="status" className="text-xs text-muted-foreground">
          Write a comment before sending.
        </p>
      )}
    </form>
  )
}
