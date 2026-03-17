import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import type {
  CommentListResult,
  CommentAddResult,
  CommentUpdateResult,
  CommentDeleteResult,
  CommentResolveResult,
} from "@/api/types"

export function useComments(path: string | null) {
  const { client, orgId, driveId } = useAuth()

  return useQuery({
    queryKey: ["comments", orgId, driveId, path],
    queryFn: () =>
      client.callOp<CommentListResult>(orgId!, "comment-list", { path: path! }, driveId),
    enabled: !!path && !!orgId && !!driveId,
    refetchInterval: 10_000,
  })
}

export function useAllComments(path: string | null) {
  const { client, orgId, driveId } = useAuth()

  const unresolved = useQuery({
    queryKey: ["comments", orgId, driveId, path, "unresolved"],
    queryFn: () =>
      client.callOp<CommentListResult>(orgId!, "comment-list", { path: path! }, driveId),
    enabled: !!path && !!orgId && !!driveId,
    refetchInterval: 10_000,
  })

  const resolved = useQuery({
    queryKey: ["comments", orgId, driveId, path, "resolved"],
    queryFn: () =>
      client.callOp<CommentListResult>(orgId!, "comment-list", { path: path!, resolved: true }, driveId),
    enabled: !!path && !!orgId && !!driveId,
    refetchInterval: 10_000,
  })

  return {
    unresolvedComments: unresolved.data?.comments ?? [],
    resolvedComments: resolved.data?.comments.filter((c) => c.resolved) ?? [],
    isLoading: unresolved.isLoading || resolved.isLoading,
  }
}

export function useAddComment() {
  const { client, orgId, driveId } = useAuth()
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
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["comments", orgId, driveId, vars.path] })
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
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["comments", orgId, driveId, vars.path] })
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
    },
  })
}
