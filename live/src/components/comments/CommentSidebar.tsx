import { useState } from "react"
import { MessageSquarePlus, ChevronDown, ChevronRight, Loader2 } from "lucide-react"
import { useAllComments } from "@/hooks/use-comments"
import { useAuth } from "@/contexts/auth"
import { CommentThread } from "./CommentThread"
import { AddComment } from "./AddComment"

interface CommentSidebarProps {
  path: string
  showHeader?: boolean
}

export function CommentSidebar({ path, showHeader = true }: CommentSidebarProps) {
  const { user } = useAuth()
  const { unresolvedComments, resolvedComments, isLoading } = useAllComments(path)
  const [showAddForm, setShowAddForm] = useState(false)
  const [showResolved, setShowResolved] = useState(false)

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      {showHeader && (
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="text-sm font-medium">
            Comments
            {unresolvedComments.length > 0 && (
              <span className="ml-1.5 text-xs text-muted-foreground">({unresolvedComments.length})</span>
            )}
          </span>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            title="Add comment"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
        </div>
      )}
      {!showHeader && (
        <div className="flex justify-end px-4 py-1">
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            title="Add comment"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Add comment form */}
      {showAddForm && (
        <div className="border-b border-border px-4 py-3">
          <AddComment
            path={path}
            onDone={() => setShowAddForm(false)}
            autoFocus
          />
        </div>
      )}

      {/* Comment list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : unresolvedComments.length === 0 && resolvedComments.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <p className="text-sm text-muted-foreground">No comments yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Select text in the viewer to add an inline comment
            </p>
          </div>
        ) : (
          <>
            {unresolvedComments.map((comment) => (
              <CommentThread
                key={comment.id}
                comment={comment}
                path={path}
                currentUserId={user?.userId}
              />
            ))}

            {resolvedComments.length > 0 && (
              <div>
                <button
                  onClick={() => setShowResolved(!showResolved)}
                  className="flex w-full items-center gap-2 px-4 py-2 text-xs text-muted-foreground hover:bg-accent transition-colors"
                >
                  {showResolved ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  {resolvedComments.length} resolved
                </button>
                {showResolved &&
                  resolvedComments.map((comment) => (
                    <CommentThread
                      key={comment.id}
                      comment={comment}
                      path={path}
                      currentUserId={user?.userId}
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
