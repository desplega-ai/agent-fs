import { useEffect, useState, useSyncExternalStore } from "react"
import { MessageSquarePlus, MessageCircle, ChevronDown, ChevronRight, PanelRightClose } from "lucide-react"
import { useAllComments } from "@/hooks/use-comments"
import { useAuth } from "@/contexts/auth"
import { sidePanelStore, useAddCommentPending } from "@/stores/side-panel"
import { useCommentAnchorMap } from "@/stores/comment-anchors"
import { COMMENT_SORTS, DEFAULT_COMMENT_SORT, isCommentSort, sortComments, type CommentSort } from "@/lib/comment-sort"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { CommentThread } from "./CommentThread"
import { AddComment } from "./AddComment"

const SORT_KEY = "liveui:comments:sort"

function readPersistedSort(): CommentSort {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_COMMENT_SORT
    const raw = localStorage.getItem(SORT_KEY)
    const parsed = raw === null ? null : JSON.parse(raw)
    return isCommentSort(parsed) ? parsed : DEFAULT_COMMENT_SORT
  } catch {
    return DEFAULT_COMMENT_SORT
  }
}

let currentSort: CommentSort = readPersistedSort()
const sortListeners = new Set<() => void>()

function setSort(next: CommentSort) {
  if (next === currentSort) return
  currentSort = next
  try {
    localStorage.setItem(SORT_KEY, JSON.stringify(next))
  } catch {
    // ignore quota / privacy errors
  }
  sortListeners.forEach((l) => l())
}

function subscribeSort(callback: () => void): () => void {
  sortListeners.add(callback)
  return () => {
    sortListeners.delete(callback)
  }
}

/** One sort for every mounted sidebar (the desktop rail and the mobile sheet). */
function useCommentSort(): CommentSort {
  return useSyncExternalStore(subscribeSort, () => currentSort, () => currentSort)
}

function CommentSortMenu() {
  const sort = useCommentSort()
  const label = COMMENT_SORTS.find((s) => s.value === sort)?.label
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="gap-1 text-muted-foreground"
            aria-label={`Sort comments: ${label}`}
            title="Sort comments"
          >
            {label}
            <ChevronDown />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-32">
        <DropdownMenuRadioGroup
          value={sort}
          onValueChange={(value) => { if (isCommentSort(value)) setSort(value) }}
        >
          {COMMENT_SORTS.map((s) => (
            <DropdownMenuRadioItem key={s.value} value={s.value} closeOnClick>
              {s.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface CommentSidebarProps {
  path: string
  isOpen?: boolean
  showHeader?: boolean
  onCommentClick?: (lineStart?: number, lineEnd?: number, quotedContent?: string, commentId?: string) => void
  /** When provided, renders a collapse button in the header that calls this callback. */
  onCollapse?: () => void
}

export function CommentSidebar({ path, isOpen = false, showHeader = true, onCommentClick, onCollapse }: CommentSidebarProps) {
  const { user } = useAuth()
  const { unresolvedComments, resolvedComments, isLoading } = useAllComments(path, isOpen)
  const [showAddForm, setShowAddForm] = useState(false)
  const [showResolved, setShowResolved] = useState(false)
  const sort = useCommentSort()
  const anchors = useCommentAnchorMap()

  // Status keeps resolved comments in their own section below the open ones.
  // The other sorts mix them into the list once they are shown.
  const grouped = sort === "status"
  const openIds = new Set(unresolvedComments.map((c) => c.id))
  const listed = sortComments(
    grouped || !showResolved
      ? unresolvedComments
      : [...unresolvedComments, ...resolvedComments.filter((c) => !openIds.has(c.id))],
    sort,
    anchors,
  )
  const resolvedListed = grouped && showResolved ? sortComments(resolvedComments, sort, anchors) : []

  // The `n` shortcut requests the add-comment form via the side-panel store.
  // Consume it here (the sidebar owns the form's open state).
  const addCommentPending = useAddCommentPending()
  useEffect(() => {
    if (addCommentPending) {
      setShowAddForm(true)
      sidePanelStore.consumeAddComment()
    }
  }, [addCommentPending])

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
            <CommentSortMenu />
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
              <TooltipContent>Add comment <Kbd className="ml-1">N</Kbd></TooltipContent>
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
                  Collapse <Kbd className="ml-1">]</Kbd>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      )}
      {!showHeader && (
        <div className="flex justify-end gap-0.5 px-3 py-1 shrink-0">
          <CommentSortMenu />
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
              <TooltipContent>Collapse <Kbd className="ml-1">]</Kbd></TooltipContent>
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
            {listed.map((comment) => (
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
                {resolvedListed.map((comment) => (
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
