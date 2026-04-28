import { useState } from "react"
import { MessageSquarePlus, MessageCircle, ChevronDown, ChevronRight, PanelRightClose } from "lucide-react"
import { useAllComments } from "@/hooks/use-comments"
import { useAuth } from "@/contexts/auth"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { CommentThread } from "./CommentThread"
import { AddComment } from "./AddComment"

interface CommentSidebarProps {
  path: string
  showHeader?: boolean
  onCommentClick?: (lineStart?: number, lineEnd?: number, quotedContent?: string) => void
  /** When provided, renders a collapse button in the header that calls this callback. */
  onCollapse?: () => void
}

export function CommentSidebar({ path, showHeader = true, onCommentClick, onCollapse }: CommentSidebarProps) {
  const { user } = useAuth()
  const { unresolvedComments, resolvedComments, isLoading } = useAllComments(path)
  const [showAddForm, setShowAddForm] = useState(false)
  const [showResolved, setShowResolved] = useState(false)

  return (
    <div className="flex h-full flex-col min-w-0">
      {/* Header */}
      {showHeader && (
        <div className="flex h-10 items-center justify-between border-b border-border px-3 shrink-0">
          <span className="text-sm font-medium">
            Comments
            {unresolvedComments.length > 0 && (
              <span className="ml-1.5 text-xs text-muted-foreground">({unresolvedComments.length})</span>
            )}
          </span>
          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setShowAddForm(!showAddForm)}
                    className="text-muted-foreground"
                    aria-label="Add comment"
                  >
                    <MessageSquarePlus />
                  </Button>
                }
              />
              <TooltipContent>Add comment</TooltipContent>
            </Tooltip>
            {onCollapse && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={onCollapse}
                      className="text-muted-foreground"
                      aria-label="Collapse comments"
                    >
                      <PanelRightClose />
                    </Button>
                  }
                />
                <TooltipContent>
                  Collapse <kbd data-slot="kbd" className="ml-1 px-1 text-[10px]">]</kbd>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      )}
      {!showHeader && (
        <div className="flex justify-end gap-0.5 px-3 py-1 shrink-0">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setShowAddForm(!showAddForm)}
                  className="text-muted-foreground"
                  aria-label="Add comment"
                >
                  <MessageSquarePlus />
                </Button>
              }
            />
            <TooltipContent>Add comment</TooltipContent>
          </Tooltip>
          {onCollapse && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={onCollapse}
                    className="text-muted-foreground"
                    aria-label="Collapse comments"
                  >
                    <PanelRightClose />
                  </Button>
                }
              />
              <TooltipContent>Collapse</TooltipContent>
            </Tooltip>
          )}
        </div>
      )}

      {/* Add whole-doc comment form */}
      {showAddForm && (
        <div className="border-b border-border px-3 py-2.5">
          <p className="text-[11px] text-muted-foreground mb-1.5 uppercase tracking-wide font-medium">General comment</p>
          <AddComment
            path={path}
            onDone={() => setShowAddForm(false)}
            autoFocus
            placeholder="Comment on this file..."
          />
          <button
            onClick={() => setShowAddForm(false)}
            className="mt-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Comment list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner />
          </div>
        ) : unresolvedComments.length === 0 && resolvedComments.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
            <MessageCircle className="size-8 text-muted-foreground/60" strokeWidth={1.5} />
            <div className="space-y-1">
              <p className="text-sm font-medium">No comments yet</p>
              <p className="text-xs text-muted-foreground">
                Select text to add an inline comment, or use + for a general comment.
              </p>
            </div>
          </div>
        ) : (
          <>
            {unresolvedComments.map((comment) => (
              <CommentThread
                key={comment.id}
                comment={comment}
                path={path}
                currentUserId={user?.userId}
                onCommentClick={onCommentClick}
              />
            ))}

            {resolvedComments.length > 0 && (
              <div>
                <button
                  onClick={() => setShowResolved(!showResolved)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-accent transition-colors"
                >
                  {showResolved ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                  {resolvedComments.length} resolved
                </button>
                {showResolved &&
                  resolvedComments.map((comment) => (
                    <CommentThread
                      key={comment.id}
                      comment={comment}
                      path={path}
                      currentUserId={user?.userId}
                      onCommentClick={onCommentClick}
                    />
                  ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
