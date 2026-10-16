import { useEffect, useMemo } from "react"
import { useQueries } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import { useFileStat } from "@/hooks/use-file-stat"
import {
  anchorNeedsDiff,
  commentAnchorInput,
  resolveAnchor,
  resolveAnchorInView,
  sourceTextSpace,
  type AnchorDiffChange,
  type AnchorInput,
  type AnchorResolution,
  type TextSpace,
} from "@/lib/comment-anchor"
import { anchorDiffChanges } from "@/lib/diff-source"
import { commentAnchors, type AnchorInfo } from "@/stores/comment-anchors"
import type { CommentListEntry, DiffResult } from "@/api/types"

/**
 * Resolve every anchored comment against the text a viewer shows, fetch the
 * version diff only for comments the quote alone couldn't place, and publish
 * each comment's status to the sidebar.
 *
 * `source`: the file's source text when `space` shows a transformed view of it
 * (JSON shown formatted), so stored line ranges resolve there and are carried
 * into the view. Omit when the space's lines are the source lines.
 */
export function useCommentAnchors(
  path: string,
  comments: CommentListEntry[] | undefined,
  space: TextSpace | null,
  source?: string,
): Map<string, AnchorResolution> {
  const { client, orgId, driveId } = useAuth()
  const { data: stat } = useFileStat(path)
  const currentVersion = stat?.currentVersion

  const inputs = useMemo(() => {
    const out: Array<{ id: string; version?: number; input: AnchorInput }> = []
    for (const c of comments ?? []) {
      const entry = commentAnchorInput(c, currentVersion)
      if (entry) out.push({ id: c.id, ...entry }) // null: general comment, nothing to anchor
    }
    return out
  }, [comments, currentVersion])

  const resolve = useMemo(() => {
    if (!space) return null
    if (source == null) return (input: AnchorInput) => resolveAnchor(space, input)
    const sourceSpace = sourceTextSpace(source)
    return (input: AnchorInput) => resolveAnchorInView(space, sourceSpace, input)
  }, [space, source])

  const firstPass = useMemo(() => {
    const out = new Map<string, AnchorResolution>()
    if (resolve) for (const { id, input } of inputs) out.set(id, resolve(input))
    return out
  }, [inputs, resolve])

  // Versions worth diffing: stale comments with a line range that the quote
  // didn't place unambiguously.
  const neededVersions = useMemo(() => {
    const set = new Set<number>()
    for (const { id, version, input } of inputs) {
      if (version == null || input.lineStart == null) continue
      if (!anchorNeedsDiff(firstPass.get(id))) continue
      set.add(version)
    }
    return [...set].sort((a, b) => a - b)
  }, [inputs, firstPass])

  const diffs = useQueries({
    queries: neededVersions.map((v) => ({
      // Same key/shape as useDiff; version pairs never change, so cache forever.
      queryKey: ["diff", orgId, driveId, path, v, currentVersion],
      queryFn: () => client.callOp<DiffResult>(orgId!, "diff", { path, v1: v, v2: currentVersion! }, driveId),
      enabled: !!orgId && !!driveId && currentVersion != null && v > 0 && v < currentVersion,
      staleTime: Infinity,
      retry: false,
    })),
  })
  const diffsKey = diffs.map((q) => `${q.status}:${q.dataUpdatedAt}`).join(",")

  const resolutions = useMemo(() => {
    if (!neededVersions.length) return firstPass
    const byVersion = new Map<number, AnchorDiffChange[] | null | "pending">()
    neededVersions.forEach((v, i) => {
      const q = diffs[i]
      if (q?.isPending && q.fetchStatus !== "idle") byVersion.set(v, "pending")
      // null: failed, not a line-by-line comparison, or old server: resolve without
      else byVersion.set(v, q?.data ? anchorDiffChanges(q.data) : null)
    })
    const out = new Map(firstPass)
    for (const { id, version, input } of inputs) {
      if (version == null || !byVersion.has(version)) continue
      const changes = byVersion.get(version)
      if (changes === "pending") continue
      out.set(id, resolve ? resolve({ ...input, changes }) : { status: "lost" })
    }
    return out
    // diffsKey stands in for `diffs`, whose array identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstPass, inputs, neededVersions, diffsKey, resolve])

  // Publish statuses for the sidebar. Hold back "lost" while a diff that could
  // still place the comment is loading, so cards don't flash a false badge.
  const pendingIds = useMemo(() => {
    const set = new Set<string>()
    neededVersions.forEach((v, i) => {
      const q = diffs[i]
      if (q?.isPending && q.fetchStatus !== "idle") {
        for (const { id, version } of inputs) if (version === v) set.add(id)
      }
    })
    return set
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neededVersions, diffsKey, inputs])

  useEffect(() => {
    if (!space) return
    const ids = inputs.map((i) => i.id)
    const next = new Map<string, AnchorInfo>()
    for (const id of ids) {
      const r = resolutions.get(id)
      if (!r || (pendingIds.has(id) && r.status === "lost")) continue
      next.set(id, { status: r.status, lineStart: r.lineStart, lineEnd: r.lineEnd })
    }
    commentAnchors.setAnchors(ids, next)
    return () => commentAnchors.setAnchors(ids, new Map())
  }, [space, inputs, resolutions, pendingIds])

  return resolutions
}
