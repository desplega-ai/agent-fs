import { useState } from "react"
import { Check, Trash2, Pencil, MessageSquare, RotateCcw, X, ChevronDown, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useResolveComment, useDeleteComment, useUpdateComment } from "@/hooks/use-comments"
import { UserName, useDisplayName } from "@/components/UserName"
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

function avatarColor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash)
  const hue = Math.abs(hash) % 360
  return `oklch(0.65 0.15 ${hue})`
}

function Avatar({ userId }: { userId: string }) {
  const { display } = useDisplayName(userId)
  const initial = display.charAt(0).toUpperCase()
  return (
    <div
      className="flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium text-white"
      style={{ backgroundColor: avatarColor(userId) }}
    >
      {initial}
    </div>
  )
}

interface CommentThreadProps {
  comment: CommentListEntry
  path: string
  currentUserId?: string
  onCommentClick?: (lineStart?: number, lineEnd?: number, quotedContent?: string) => void
}

export function CommentThread({ comment, path, currentUserId, onCommentClick }: CommentThreadProps) {
  const [showReplies, setShowReplies] = useState(true)
  const [replying, setReplying] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editBody, setEditBody] = useState(comment.body)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const resolveComment = useResolveComment()
  const deleteComment = useDeleteComment()
  const updateComment = useUpdateComment()

  const isOwn = currentUserId === comment.author
  const isGeneralComment = !comment.lineStart
  const hasReplies = comment.replies.length > 0

  const handleThreadClick = () => {
    if (onCommentClick) {
      onCommentClick(comment.lineStart, comment.lineEnd ?? comment.lineStart, comment.quotedContent)
    }
  }

  return (
    <div className={cn("border-b border-border last:border-b-0", comment.resolved && "opacity-60")}>
      <div
        className={cn("px-3 py-2.5", (comment.lineStart || comment.quotedContent) && "cursor-pointer hover:bg-accent/50 transition-colors")}
        onClick={handleThreadClick}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <Avatar userId={comment.author} />
            <UserName userId={comment.author} />
            <span className="text-[11px] text-muted-foreground shrink-0">{timeAgo(comment.createdAt)}</span>
            {isGeneralComment && (
              <span className="text-[10px] text-muted-foreground/60 shrink-0">general</span>
            )}
            {comment.lineStart && (
              <span className="text-[10px] font-mono text-amber-600 dark:text-amber-400 shrink-0">
                L{comment.lineStart}{comment.lineEnd && comment.lineEnd !== comment.lineStart ? `-${comment.lineEnd}` : ""}
              </span>
            )}
          </div>
          <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
            <Button
              variant="ghost" size="icon-xs"
              onClick={handleResolve}
              className={cn(comment.resolved ? "text-primary" : "text-muted-foreground")}
              title={comment.resolved ? "Reopen" : "Resolve"}
            >
              {comment.resolved ? <RotateCcw /> : <Check />}
            </Button>
            {isOwn && (
              <>
                <Button variant="ghost" size="icon-xs"
                  onClick={() => { setEditing(!editing); setEditBody(comment.body) }}
                  className="text-muted-foreground" title="Edit"
                ><Pencil /></Button>
                <Button
                  variant={confirmDelete ? "destructive" : "ghost"} size="icon-xs"
                  onClick={handleDelete}
                  className={cn(!confirmDelete && "text-muted-foreground")}
                  title={confirmDelete ? "Click again to confirm" : "Delete"}
                >{confirmDelete ? <X /> : <Trash2 />}</Button>
              </>
            )}
          </div>
        </div>

        {/* Quoted content */}
        {comment.quotedContent && (
          <div className="mb-1.5 ml-6.5 rounded border-l-2 border-amber-400/50 bg-amber-500/5 px-2 py-1 text-xs font-mono text-muted-foreground">
            <span className="line-clamp-2">{comment.quotedContent}</span>
          </div>
        )}

        {/* Body */}
        <div className="ml-6.5" onClick={(e) => e.stopPropagation()}>
          {editing ? (
            <div className="space-y-2">
              <Textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} className="resize-none text-sm" rows={3} />
              <div className="flex gap-2">
                <Button size="xs" onClick={handleSaveEdit} disabled={!editBody.trim() || updateComment.isPending}>Save</Button>
                <Button variant="ghost" size="xs" onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <p className="text-sm whitespace-pre-wrap break-words">{comment.body}</p>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 mt-1.5">
            {hasReplies && (
              <button
                onClick={() => setShowReplies(!showReplies)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {showReplies ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                {comment.replies.length} {comment.replies.length === 1 ? "reply" : "replies"}
              </button>
            )}
            <button
              onClick={() => setReplying(!replying)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <MessageSquare className="size-3" />
              Reply
            </button>
          </div>
        </div>
      </div>

      {/* Replies */}
      {showReplies && hasReplies && (
        <div className="border-t border-border bg-muted/30 pl-4">
          {comment.replies.map((reply) => (
            <ReplyItem key={reply.id} reply={reply} path={path} currentUserId={currentUserId} />
          ))}
        </div>
      )}

      {/* Reply form */}
      {replying && (
        <div className="border-t border-border px-3 py-2.5 bg-muted/30" onClick={(e) => e.stopPropagation()}>
          <AddComment
            path={path}
            parentId={comment.id}
            onDone={() => setReplying(false)}
            autoFocus
            placeholder="Write a reply..."
          />
          <button
            onClick={() => setReplying(false)}
            className="mt-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )

  function handleResolve() {
    resolveComment.mutate({ id: comment.id, resolved: !comment.resolved, path })
  }
  function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    deleteComment.mutate({ id: comment.id, path })
    setConfirmDelete(false)
  }
  function handleSaveEdit() {
    updateComment.mutate({ id: comment.id, body: editBody, path }, { onSuccess: () => setEditing(false) })
  }
}

function ReplyItem({ reply, path, currentUserId }: { reply: CommentEntry; path: string; currentUserId?: string }) {
  const [editing, setEditing] = useState(false)
  const [editBody, setEditBody] = useState(reply.body)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const updateComment = useUpdateComment()
  const deleteComment = useDeleteComment()
  const isOwn = currentUserId === reply.author

  return (
    <div className="border-b border-border last:border-b-0 px-3 py-2">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <Avatar userId={reply.author} />
          <UserName userId={reply.author} />
          <span className="text-[11px] text-muted-foreground shrink-0">{timeAgo(reply.createdAt)}</span>
        </div>
        {isOwn && (
          <div className="flex items-center gap-0.5 shrink-0">
            <Button variant="ghost" size="icon-xs" onClick={() => { setEditing(!editing); setEditBody(reply.body) }} className="text-muted-foreground"><Pencil /></Button>
            <Button
              variant={confirmDelete ? "destructive" : "ghost"} size="icon-xs"
              onClick={() => { if (!confirmDelete) { setConfirmDelete(true); return } deleteComment.mutate({ id: reply.id, path }); setConfirmDelete(false) }}
              className={cn(!confirmDelete && "text-muted-foreground")}
            >{confirmDelete ? <X /> : <Trash2 />}</Button>
          </div>
        )}
      </div>
      <div className="ml-6.5">
        {editing ? (
          <div className="space-y-2">
            <Textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} className="resize-none text-sm" rows={2} />
            <div className="flex gap-2">
              <Button size="xs" onClick={() => updateComment.mutate({ id: reply.id, body: editBody, path }, { onSuccess: () => setEditing(false) })} disabled={!editBody.trim()}>Save</Button>
              <Button variant="ghost" size="xs" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <p className="text-sm whitespace-pre-wrap">{reply.body}</p>
        )}
      </div>
    </div>
  )
}
