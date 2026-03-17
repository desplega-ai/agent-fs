import { useState } from "react"
import { Check, Trash2, Pencil, MessageSquare, RotateCcw, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useResolveComment, useDeleteComment, useUpdateComment } from "@/hooks/use-comments"
import { AddComment } from "./AddComment"
import type { CommentListEntry, CommentEntry } from "@/api/types"

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

interface CommentThreadProps {
  comment: CommentListEntry
  path: string
  currentUserId?: string
}

export function CommentThread({ comment, path, currentUserId }: CommentThreadProps) {
  const [showReplies, setShowReplies] = useState(false)
  const [replying, setReplying] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editBody, setEditBody] = useState(comment.body)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const resolveComment = useResolveComment()
  const deleteComment = useDeleteComment()
  const updateComment = useUpdateComment()

  const isOwn = currentUserId === comment.author

  const handleResolve = () => {
    resolveComment.mutate({ id: comment.id, resolved: !comment.resolved, path })
  }

  const handleDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    deleteComment.mutate({ id: comment.id, path })
    setConfirmDelete(false)
  }

  const handleSaveEdit = () => {
    updateComment.mutate(
      { id: comment.id, body: editBody, path },
      { onSuccess: () => setEditing(false) }
    )
  }

  return (
    <div className={cn("border-b border-border last:border-b-0", comment.resolved && "opacity-60")}>
      <div className="px-4 py-3">
        {/* Header */}
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium">{comment.author}</span>
            <span className="text-muted-foreground">{timeAgo(comment.createdAt)}</span>
          </div>
          <div className="flex items-center gap-0.5">
            <button
              onClick={handleResolve}
              className={cn(
                "rounded p-1 transition-colors",
                comment.resolved
                  ? "text-green-600 hover:bg-accent"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
              title={comment.resolved ? "Reopen" : "Resolve"}
            >
              {comment.resolved ? <RotateCcw className="h-3 w-3" /> : <Check className="h-3 w-3" />}
            </button>
            {isOwn && (
              <>
                <button
                  onClick={() => {
                    setEditing(!editing)
                    setEditBody(comment.body)
                  }}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                  title="Edit"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  onClick={handleDelete}
                  className={cn(
                    "rounded p-1 transition-colors",
                    confirmDelete
                      ? "text-destructive bg-destructive/10"
                      : "text-muted-foreground hover:bg-accent hover:text-destructive"
                  )}
                  title={confirmDelete ? "Click again to confirm" : "Delete"}
                >
                  {confirmDelete ? <X className="h-3 w-3" /> : <Trash2 className="h-3 w-3" />}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Quoted content */}
        {comment.quotedContent && (
          <div className="mb-2 rounded border-l-2 border-muted-foreground/30 bg-muted/50 px-2 py-1 text-xs font-mono text-muted-foreground">
            {comment.lineStart && (
              <span className="text-[10px] mr-1">L{comment.lineStart}{comment.lineEnd && comment.lineEnd !== comment.lineStart ? `-${comment.lineEnd}` : ""}:</span>
            )}
            {comment.quotedContent}
          </div>
        )}

        {/* Body */}
        {editing ? (
          <div className="space-y-2">
            <textarea
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-none"
              rows={3}
            />
            <div className="flex gap-2">
              <button
                onClick={handleSaveEdit}
                disabled={!editBody.trim() || updateComment.isPending}
                className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                Save
              </button>
              <button
                onClick={() => setEditing(false)}
                className="rounded-md px-3 py-1 text-xs hover:bg-accent"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm whitespace-pre-wrap">{comment.body}</p>
        )}

        {/* Actions */}
        <div className="flex items-center gap-3 mt-2">
          {comment.replies.length > 0 && (
            <button
              onClick={() => setShowReplies(!showReplies)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {showReplies ? "Hide" : "Show"} {comment.replies.length} {comment.replies.length === 1 ? "reply" : "replies"}
            </button>
          )}
          <button
            onClick={() => setReplying(!replying)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <MessageSquare className="h-3 w-3" />
            Reply
          </button>
        </div>
      </div>

      {/* Replies */}
      {(showReplies || comment.replies.length <= 2) && comment.replies.length > 0 && (
        <div className="border-t border-border bg-muted/30 pl-6">
          {comment.replies.map((reply) => (
            <ReplyItem key={reply.id} reply={reply} path={path} currentUserId={currentUserId} />
          ))}
        </div>
      )}

      {/* Reply form */}
      {replying && (
        <div className="border-t border-border px-4 py-3 bg-muted/30">
          <AddComment
            path={path}
            parentId={comment.id}
            onDone={() => setReplying(false)}
            autoFocus
            placeholder="Write a reply..."
          />
        </div>
      )}
    </div>
  )
}

function ReplyItem({ reply, path, currentUserId }: { reply: CommentEntry; path: string; currentUserId?: string }) {
  const [editing, setEditing] = useState(false)
  const [editBody, setEditBody] = useState(reply.body)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const updateComment = useUpdateComment()
  const deleteComment = useDeleteComment()
  const isOwn = currentUserId === reply.author

  return (
    <div className="border-b border-border last:border-b-0 px-4 py-2">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium">{reply.author}</span>
          <span className="text-muted-foreground">{timeAgo(reply.createdAt)}</span>
        </div>
        {isOwn && (
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => { setEditing(!editing); setEditBody(reply.body) }}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              onClick={() => {
                if (!confirmDelete) { setConfirmDelete(true); return }
                deleteComment.mutate({ id: reply.id, path })
                setConfirmDelete(false)
              }}
              className={cn(
                "rounded p-1 transition-colors",
                confirmDelete ? "text-destructive bg-destructive/10" : "text-muted-foreground hover:bg-accent hover:text-destructive"
              )}
            >
              {confirmDelete ? <X className="h-3 w-3" /> : <Trash2 className="h-3 w-3" />}
            </button>
          </div>
        )}
      </div>
      {editing ? (
        <div className="space-y-2">
          <textarea
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            rows={2}
          />
          <div className="flex gap-2">
            <button
              onClick={() => updateComment.mutate({ id: reply.id, body: editBody, path }, { onSuccess: () => setEditing(false) })}
              disabled={!editBody.trim()}
              className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Save
            </button>
            <button onClick={() => setEditing(false)} className="rounded-md px-3 py-1 text-xs hover:bg-accent">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="text-sm whitespace-pre-wrap">{reply.body}</p>
      )}
    </div>
  )
}
