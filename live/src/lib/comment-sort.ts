import type { CommentListEntry } from "@/api/types"
import type { AnchorInfo } from "@/stores/comment-anchors"

export type CommentSort = "line" | "newest" | "oldest" | "status"

export const COMMENT_SORTS: Array<{ value: CommentSort; label: string }> = [
  { value: "line", label: "Line" },
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "status", label: "Status" },
]

/** Newest first: the order the server returns. */
export const DEFAULT_COMMENT_SORT: CommentSort = "newest"

export function isCommentSort(value: unknown): value is CommentSort {
  return COMMENT_SORTS.some((s) => s.value === value)
}

const newest = (a: CommentListEntry, b: CommentListEntry) => b.createdAt.localeCompare(a.createdAt)

/**
 * Where a comment sits in the text: the line its card shows (the viewer's
 * resolved line, else the stored one), then the offset for comments on the same
 * line. null for general comments and lost anchors.
 */
function position(c: CommentListEntry, anchors: ReadonlyMap<string, AnchorInfo>): [number, number] | null {
  const anchor = anchors.get(c.id)
  const line = anchor?.lineStart ?? c.lineStart
  if (anchor?.status === "lost" || !line) return null
  return [line, anchor?.start ?? 0]
}

/** Document order. Comments without a position go last, newest first. */
function byLine(anchors: ReadonlyMap<string, AnchorInfo>) {
  return (a: CommentListEntry, b: CommentListEntry) => {
    const pa = position(a, anchors)
    const pb = position(b, anchors)
    if (pa && pb) return pa[0] - pb[0] || pa[1] - pb[1] || newest(a, b)
    if (pa || pb) return pa ? -1 : 1
    return newest(a, b)
  }
}

/** A sorted copy of `comments`. */
export function sortComments(
  comments: CommentListEntry[],
  sort: CommentSort,
  anchors: ReadonlyMap<string, AnchorInfo>,
): CommentListEntry[] {
  const out = [...comments]
  if (sort === "newest") return out.sort(newest)
  if (sort === "oldest") return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const line = byLine(anchors)
  if (sort === "line") return out.sort(line)
  return out.sort((a, b) => Number(a.resolved) - Number(b.resolved) || line(a, b))
}
