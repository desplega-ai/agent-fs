import {
  useQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query"
import type { AgentFsClient } from "@/api/client"
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
  CommentQuote,
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
  const savedCommentExists = data.comments.some((comment) =>
    comment.id === savedComment.id || comment.replies.some((reply) => reply.id === savedComment.id)
  )
  return {
    ...data,
    comments: data.comments.flatMap((comment) => {
      if (comment.id === optimisticId) {
        return savedCommentExists ? [] : [{ ...comment, ...savedComment, replies: comment.replies }]
      }
      const hasOptimisticReply = comment.replies.some((reply) => reply.id === optimisticId)
      return [{
        ...comment,
        replyCount: savedCommentExists && hasOptimisticReply
          ? Math.max(0, comment.replyCount - 1)
          : comment.replyCount,
        replies: comment.replies.flatMap((reply) => reply.id === optimisticId
          ? savedCommentExists ? [] : [{ ...reply, ...savedComment }]
          : [reply]),
      }]
    }),
  }
}

function preservePendingOptimisticComments(
  previous: CommentListResult | undefined,
  server: CommentListResult,
): CommentListResult {
  if (!previous) return server

  let comments = [...server.comments]
  for (const previousRoot of previous.comments) {
    const pendingReplies = previousRoot.replies.filter((reply) => reply.id.startsWith("optimistic:"))
    const rootIsPending = previousRoot.id.startsWith("optimistic:")
    let rootIndex = comments.findIndex((comment) => comment.id === previousRoot.id)

    if (rootIsPending && rootIndex < 0) {
      comments.unshift(previousRoot)
      rootIndex = 0
    }

    if (pendingReplies.length === 0) continue
    if (rootIndex < 0) {
      comments.push(previousRoot)
      continue
    }

    let root = comments[rootIndex]
    for (const reply of pendingReplies) {
      if (root.replies.some((existing) => existing.id === reply.id)) continue
      root = {
        ...root,
        replyCount: root.replyCount + 1,
        replies: [...root.replies, reply],
      }
    }
    comments[rootIndex] = root
  }

  return { ...server, comments: comments.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
}

function findThread(data: CommentListResult | undefined, id: string) {
  return data?.comments.find((comment) => comment.id === id || comment.replies.some((reply) => reply.id === id))
}

function restoreThread(
  data: CommentListResult | undefined,
  id: string,
  previousThread: CommentListEntry | undefined,
  concurrentData: CommentListResult | undefined,
): CommentListResult | undefined {
  if (!data) return data
  if (!previousThread) {
    return { ...data, comments: data.comments.filter((comment) => comment.id !== id) }
  }

  const currentThread = data.comments.find((comment) => comment.id === previousThread.id)
    ?? concurrentData?.comments.find((comment) => comment.id === previousThread.id)
  const restoredThread: CommentListEntry = currentThread
    ? id === previousThread.id
      ? {
          ...currentThread,
          resolved: previousThread.resolved,
          resolvedBy: previousThread.resolvedBy,
          resolvedAt: previousThread.resolvedAt,
        }
      : {
          ...currentThread,
          replies: currentThread.replies.map((reply) => {
            if (reply.id !== id) return reply
            const previousReply = previousThread.replies.find((before) => before.id === id)
            if (!previousReply) return reply
            return {
              ...reply,
              resolved: previousReply.resolved,
              resolvedBy: previousReply.resolvedBy,
              resolvedAt: previousReply.resolvedAt,
            }
          }),
        }
    : previousThread

  return {
    ...data,
    comments: [restoredThread, ...data.comments.filter((comment) => comment.id !== previousThread.id)]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  }
}

interface CommentQueryOptionsParams {
  client: AgentFsClient
  queryClient: QueryClient
  orgId: string | null
  driveId: string
  path: string | null
  isOpen?: boolean
  resolved?: boolean
  poll?: boolean
}

export function createCommentQueryOptions({
  client,
  queryClient,
  orgId,
  driveId,
  path,
  isOpen = false,
  resolved = false,
  poll = false,
}: CommentQueryOptionsParams): UseQueryOptions<CommentListResult, Error, CommentListResult, QueryKey> {
  const queryKey = commentQueryKey(orgId, driveId, path)
  const cacheKey = resolved ? [...queryKey, "resolved"] as const : queryKey
  return {
    queryKey: cacheKey,
    queryFn: async () => {
      const server = await client.callOp<CommentListResult>(
        orgId!,
        "comment-list",
        resolved ? { path: path!, resolved: true } : { path: path! },
        driveId,
      )
      return preservePendingOptimisticComments(queryClient.getQueryData<CommentListResult>(cacheKey), server)
    },
    enabled: !!path && !!orgId && !!driveId && (!poll || isOpen),
    staleTime: COMMENT_STALE_TIME,
    ...(poll && { refetchInterval: isOpen ? COMMENT_REFETCH_INTERVAL : false as const }),
  }
}

export function useComments(path: string | null) {
  const { client, orgId, driveId } = useAuth()
  const queryClient = useQueryClient()

  return useQuery(createCommentQueryOptions({ client, queryClient, orgId, driveId, path }))
}

export function useAllComments(path: string | null, isOpen = false) {
  const { client, orgId, driveId } = useAuth()
  const queryClient = useQueryClient()

  const unresolved = useQuery(createCommentQueryOptions({
    client, queryClient, orgId, driveId, path, isOpen, poll: true,
  }))

  const resolved = useQuery(createCommentQueryOptions({
    client, queryClient, orgId, driveId, path, isOpen, resolved: true, poll: true,
  }))

  return {
    unresolvedComments: unresolved.data?.comments ?? [],
    resolvedComments: resolved.data?.comments.filter((c) => c.resolved) ?? [],
    isLoading: unresolved.isLoading || resolved.isLoading,
  }
}

interface AddCommentParams {
  path: string
  body: string
  parentId?: string
  lineStart?: number
  lineEnd?: number
  quotedContent?: string
  quote?: CommentQuote
}

interface AddCommentOptionsParams {
  client: AgentFsClient
  orgId: string | null
  driveId: string
  user: { userId: string; displayName?: string | null } | undefined
  queryClient: QueryClient
}

interface AddCommentContext {
  optimisticComment: CommentListEntry
}

export function createAddCommentMutationOptions({ client, orgId, driveId, user, queryClient }: AddCommentOptionsParams):
  UseMutationOptions<CommentAddResult, Error, AddCommentParams, AddCommentContext | undefined> {
  return {
    mutationFn: (params) => client.callOp<CommentAddResult>(orgId!, "comment-add", { ...params }, driveId),
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
  }
}

export function useAddComment() {
  const { client, orgId, driveId, user } = useAuth()
  const queryClient = useQueryClient()
  return useMutation(createAddCommentMutationOptions({ client, orgId, driveId, user, queryClient }))
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

interface ResolveCommentOptionsParams {
  client: AgentFsClient
  orgId: string | null
  driveId: string
  queryClient: QueryClient
}

interface ResolveCommentParams {
  id: string
  resolved: boolean
  path: string
}

interface ResolveCommentContext {
  previousUnresolvedThread: CommentListEntry | undefined
  previousResolvedThread: CommentListEntry | undefined
}

export function createResolveCommentMutationOptions({ client, orgId, driveId, queryClient }: ResolveCommentOptionsParams):
  UseMutationOptions<CommentResolveResult, Error, ResolveCommentParams, ResolveCommentContext> {
  return {
    mutationFn: (params) =>
      client.callOp<CommentResolveResult>(orgId!, "comment-resolve", {
        id: params.id,
        resolved: params.resolved,
      }, driveId),
    onMutate: async (vars) => {
      const queryKey = commentQueryKey(orgId, driveId, vars.path)
      const resolvedKey = [...queryKey, "resolved"] as const
      await queryClient.cancelQueries({ queryKey })
      const previousUnresolvedThread = findThread(queryClient.getQueryData<CommentListResult>(queryKey), vars.id)
      const allComments = queryClient.getQueryData<CommentListResult>(resolvedKey)
      const previousResolvedThread = findThread(allComments, vars.id)
      queryClient.setQueryData<CommentListResult>(queryKey, (data) =>
        withUnresolvedComment(data, vars.id, vars.resolved, allComments)
      )
      queryClient.setQueryData<CommentListResult>(resolvedKey, (data) =>
        withResolvedComment(data, vars.id, vars.resolved)
      )
      return { previousUnresolvedThread, previousResolvedThread }
    },
    onError: (_error, vars, context) => {
      if (!context) return
      const queryKey = commentQueryKey(orgId, driveId, vars.path)
      const resolvedKey = [...queryKey, "resolved"] as const
      const currentUnresolved = queryClient.getQueryData<CommentListResult>(queryKey)
      const currentResolved = queryClient.getQueryData<CommentListResult>(resolvedKey)
      queryClient.setQueryData<CommentListResult>(queryKey, (data) =>
        restoreThread(data, vars.id, context.previousUnresolvedThread, currentResolved)
      )
      queryClient.setQueryData<CommentListResult>(resolvedKey, (data) =>
        restoreThread(data, vars.id, context.previousResolvedThread, currentUnresolved)
      )
    },
    onSuccess: (_data, vars) => {
      toast.success(vars.resolved ? "Comment resolved" : "Comment reopened")
    },
    onSettled: (_data, _error, vars) => {
      queryClient.invalidateQueries({ queryKey: commentQueryKey(orgId, driveId, vars.path) })
    },
  }
}

export function useResolveComment() {
  const { client, orgId, driveId } = useAuth()
  const queryClient = useQueryClient()
  return useMutation(createResolveCommentMutationOptions({ client, orgId, driveId, queryClient }))
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
