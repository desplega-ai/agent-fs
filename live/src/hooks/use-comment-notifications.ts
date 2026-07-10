import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { isUnknownOperationError } from "@/api/errors"
import { useAuth } from "@/contexts/auth"
import type {
  CommentNotificationListResult,
  CommentNotificationReadResult,
} from "@/api/types"

type MarkReadParams = Record<string, unknown> & {
  ids?: string[]
  all?: boolean
}

function notificationQueryKey(orgId: string | null, driveId: string) {
  return ["comment-notifications", orgId, driveId] as const
}

/**
 * Poll the per-user comment inbox. Older servers do not expose this op; the
 * consumer intentionally renders nothing when this query errors so mixed
 * UI/API deployments remain usable during rollout.
 */
export function useCommentNotifications() {
  const { client, orgId, driveId } = useAuth()

  return useQuery({
    queryKey: notificationQueryKey(orgId, driveId),
    queryFn: () =>
      client.callOp<CommentNotificationListResult>(
        orgId!,
        "comment-notification-list",
        { limit: 30 },
        driveId,
      ),
    enabled: !!orgId && !!driveId,
    retry: false,
    refetchInterval: (query) => {
      if (
        isUnknownOperationError(
          query.state.error,
          "comment-notification-list",
        )
      ) {
        return false
      }
      return query.state.status === "error" ? 30_000 : 10_000
    },
    refetchOnWindowFocus: false,
  })
}

export function useMarkCommentNotificationsRead() {
  const { client, orgId, driveId } = useAuth()
  const queryClient = useQueryClient()
  const queryKey = notificationQueryKey(orgId, driveId)

  return useMutation({
    mutationFn: (params: MarkReadParams) =>
      client.callOp<CommentNotificationReadResult>(
        orgId!,
        "comment-notification-read",
        params,
        driveId,
      ),
    onMutate: async (params) => {
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData<CommentNotificationListResult>(queryKey)

      queryClient.setQueryData<CommentNotificationListResult>(queryKey, (current) => {
        if (!current) return current

        const requested = new Set(params.ids ?? [])
        let newlyRead = 0
        const notifications = current.notifications.map((notification) => {
          const shouldRead = params.all === true || requested.has(notification.id)
          if (!shouldRead || notification.read) return notification
          newlyRead += 1
          return { ...notification, read: true }
        })

        return {
          notifications,
          unreadCount:
            params.all === true
              ? 0
              : Math.max(0, current.unreadCount - newlyRead),
        }
      })

      return { previous }
    },
    onError: (_error, _params, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey })
    },
  })
}
