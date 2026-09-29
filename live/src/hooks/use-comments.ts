import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import { toast } from "@/stores/toast"
import type {
  CommentListResult,
  CommentAddResult,
  CommentUpdateResult,
  CommentDeleteResult,
  CommentResolveResult,
  CommentEntry,
  CommentListEntry,
} from "@/api/types"

const COMMENT_STALE_TIME = 5_000
const COMMENT_REFETCH_INTERVAL = 10_000

function commentQueryKey(orgId: string | null, driveId: string, path: string | null) {
  return ["comments", orgId, driveId, path] as const
}

function withResolvedComment(
  data: CommentListResult | undefined,
  id: string,
  resolved: boolean,
): CommentListResult | undefined {
  if (!data) return data
  return {
    ...data,
    comments: data.comments.map((comment) => {
      if (comment.id === id) return { ...comment, resolved }
      return {
        ...comment,
        replies: comment.replies.map((reply) => reply.id === id ? { ...reply, resolved } : reply),
      }
    }),
  }
}

function withUnresolvedComment(
  data: CommentListResult | undefined,
  id: string,
  resolved: boolean,
  allComments: CommentListResult | undefined,
): CommentListResult | undefined {
  const updated = withResolvedComment(data, id, resolved)
  if (!updated) return updated
  if (resolved) {
    return { ...updated, comments: updated.comments.filter((comment) => comment.id !== id) }
  }
  if (updated.comments.some((comment) => comment.id === id)) return updated

  const reopened = allComments?.comments.find((comment) => comment.id === id)
  if (!reopened) return updated
  return {
    ...updated,
    comments: [{ ...reopened, resolved: false }, ...updated.comments].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    ),
  }
}

function removeOptimisticComment(
  data: CommentListResult | undefined,
  id: string,
): CommentListResult | undefined {
  if (!data) return data
  return {
    ...data,
    comments: data.comments.flatMap((comment) => {
      if (comment.id === id) return []
      const hadReply = comment.replies.some((reply) => reply.id === id)
      return [{
        ...comment,
        replyCount: hadReply ? Math.max(0, comment.replyCount - 1) : comment.replyCount,
        replies: comment.replies.filter((reply) => reply.id !== id),
      }]
    }),
  }
}

function addOptimisticComment(
  data: CommentListResult | undefined,
  comment: CommentListEntry,
): CommentListResult | undefined {
  if (!data) return data
  if (!comment.parentId) return { ...data, comments: [comment, ...data.comments] }

  return {
    ...data,
    comments: data.comments.map((parent) => parent.id === comment.parentId
      ? {
          ...parent,
          replyCount: parent.replyCount + 1,
          replies: [...parent.replies, comment],
        }
      : parent),
  }
}

function replaceOptimisticComment(
  data: CommentListResult | undefined,
  optimisticId: string,
  savedComment: CommentEntry,
): CommentListResult | undefined {
  if (!data) return data
  return {
    ...data,
    comments: data.comments.map((comment) => {
      if (comment.id === optimisticId) {
        return { ...comment, ...savedComment, replies: comment.replies }
      }
      return {
        ...comment,
        replies: comment.replies.map((reply) =>
          reply.id === optimisticId ? { ...reply, ...savedComment } : reply
        ),
      }
    }),
  }
}

export function useComments(path: string | null) {
  const { client, orgId, driveId } = useAuth()

  return useQuery({
    queryKey: commentQueryKey(orgId, driveId, path),
    queryFn: () =>
      client.callOp<CommentListResult>(orgId!, "comment-list", { path: path! }, driveId),
    enabled: !!path && !!orgId && !!driveId,
    staleTime: COMMENT_STALE_TIME,
  })
}

export function useAllComments(path: string | null, isOpen = false) {
  const { client, orgId, driveId } = useAuth()
  const queryKey = commentQueryKey(orgId, driveId, path)

  const unresolved = useQuery({
    queryKey,
    queryFn: () =>
      client.callOp<CommentListResult>(orgId!, "comment-list", { path: path! }, driveId),
    enabled: !!path && !!orgId && !!driveId && isOpen,
    staleTime: COMMENT_STALE_TIME,
    refetchInterval: isOpen ? COMMENT_REFETCH_INTERVAL : false,
  })

  const resolved = useQuery({
    queryKey: [...queryKey, "resolved"],
    queryFn: () =>
      client.callOp<CommentListResult>(orgId!, "comment-list", { path: path!, resolved: true }, driveId),
    enabled: !!path && !!orgId && !!driveId && isOpen,
    staleTime: COMMENT_STALE_TIME,
    refetchInterval: isOpen ? COMMENT_REFETCH_INTERVAL : false,
  })

  return {
    unresolvedComments: unresolved.data?.comments ?? [],
    resolvedComments: resolved.data?.comments.filter((c) => c.resolved) ?? [],
    isLoading: unresolved.isLoading || resolved.isLoading,
  }
}

export function useAddComment() {
  const { client, orgId, driveId, user } = useAuth()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (params: {
      path: string
      body: string
      parentId?: string
      lineStart?: number
      lineEnd?: number
      quotedContent?: string
    }) => client.callOp<CommentAddResult>(orgId!, "comment-add", params, driveId),
    onMutate: async (vars) => {
      if (!user?.userId) return

      const queryKey = commentQueryKey(orgId, driveId, vars.path)
      const queryKeys = [queryKey, [...queryKey, "resolved"] as const]
      await queryClient.cancelQueries({ queryKey })

      const createdAt = new Date().toISOString()
      const optimisticComment: CommentListEntry = {
        ...vars,
        id: `optimistic:${crypto.randomUUID()}`,
        author: user.userId,
        authorDisplayName: user.displayName ?? undefined,
        resolved: false,
        replyCount: 0,
        createdAt,
        updatedAt: createdAt,
        replies: [],
      }

      for (const key of queryKeys) {
        queryClient.setQueryData<CommentListResult>(key, (data) =>
          addOptimisticComment(data, optimisticComment)
        )
      }
      return { optimisticComment }
    },
    onError: (_error, vars, context) => {
      if (!context) return
      const queryKey = commentQueryKey(orgId, driveId, vars.path)
      for (const key of [queryKey, [...queryKey, "resolved"] as const]) {
        queryClient.setQueryData<CommentListResult>(key, (data) =>
          removeOptimisticComment(data, context.optimisticComment.id)
        )
      }
    },
    onSuccess: (data, vars, context) => {
      if (context) {
        const queryKey = commentQueryKey(orgId, driveId, vars.path)
        const savedComment: CommentEntry = {
          ...context.optimisticComment,
          ...data,
          updatedAt: data.createdAt,
        }
        for (const key of [queryKey, [...queryKey, "resolved"] as const]) {
          queryClient.setQueryData<CommentListResult>(key, (current) =>
            replaceOptimisticComment(current, context.optimisticComment.id, savedComment)
          )
        }
      }
      toast.success(vars.parentId ? "Reply added" : "Comment added")
    },
    onSettled: (_data, _error, vars) => {
      queryClient.invalidateQueries({ queryKey: commentQueryKey(orgId, driveId, vars.path) })
    },
  })
}

export function useUpdateComment() {
  const { client, orgId, driveId } = useAuth()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (params: { id: string; body: string; path: string }) =>
      client.callOp<CommentUpdateResult>(orgId!, "comment-update", {
        id: params.id,
        body: params.body,
      }, driveId),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["comments", orgId, driveId, vars.path] })
      toast.success("Comment updated")
    },
  })
}

export function useResolveComment() {
  const { client, orgId, driveId } = useAuth()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (params: { id: string; resolved: boolean; path: string }) =>
      client.callOp<CommentResolveResult>(orgId!, "comment-resolve", {
        id: params.id,
        resolved: params.resolved,
      }, driveId),
    onMutate: async (vars) => {
      const queryKey = commentQueryKey(orgId, driveId, vars.path)
      const resolvedKey = [...queryKey, "resolved"] as const
      await queryClient.cancelQueries({ queryKey })
      const allComments = queryClient.getQueryData<CommentListResult>(resolvedKey)
      queryClient.setQueryData<CommentListResult>(queryKey, (data) =>
        withUnresolvedComment(data, vars.id, vars.resolved, allComments)
      )
      queryClient.setQueryData<CommentListResult>(resolvedKey, (data) =>
        withResolvedComment(data, vars.id, vars.resolved)
      )
    },
    onError: (_error, vars) => {
      const queryKey = commentQueryKey(orgId, driveId, vars.path)
      const resolvedKey = [...queryKey, "resolved"] as const
      const allComments = queryClient.getQueryData<CommentListResult>(resolvedKey)
      queryClient.setQueryData<CommentListResult>(queryKey, (data) =>
        withUnresolvedComment(data, vars.id, !vars.resolved, allComments)
      )
      queryClient.setQueryData<CommentListResult>(resolvedKey, (data) =>
        withResolvedComment(data, vars.id, !vars.resolved)
      )
    },
    onSuccess: (_data, vars) => {
      toast.success(vars.resolved ? "Comment resolved" : "Comment reopened")
    },
    onSettled: (_data, _error, vars) => {
      queryClient.invalidateQueries({ queryKey: commentQueryKey(orgId, driveId, vars.path) })
    },
  })
}

export function useDeleteComment() {
  const { client, orgId, driveId } = useAuth()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (params: { id: string; path: string }) =>
      client.callOp<CommentDeleteResult>(orgId!, "comment-delete", { id: params.id }, driveId),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["comments", orgId, driveId, vars.path] })
      toast.success("Comment deleted")
    },
  })
}
