import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import type { AgentFsClient } from "@/api/client"
import type { Webhook, WebhookDeliveryStatus, WebhookEventType } from "@/api/types"
import { splitSecret } from "@/lib/webhooks"

export const webhooksKey = (credentialId: string, orgId: string | null, driveId: string | null) =>
  ["webhooks", credentialId, orgId, driveId] as const

const deliveriesKey = (credentialId: string, orgId: string, driveId: string, id: string) =>
  ["webhook-deliveries", credentialId, orgId, driveId, id] as const

/**
 * Webhooks visible from `driveId`: the drive's own for a drive admin, plus the
 * org's for an org admin. Pass `enabled: false` until the caller is known to
 * manage the drive. The server answers 403 to anyone else, and a 403 is not
 * retried.
 */
export function useWebhooks(orgId: string | null, driveId: string | null, enabled: boolean) {
  const { client, credential } = useAuth()
  return useQuery({
    queryKey: webhooksKey(credential.id, orgId, driveId),
    queryFn: ({ signal }) => client.listWebhooks(orgId!, driveId!, { signal }),
    enabled: enabled && !!orgId && !!driveId,
    staleTime: 0,
    retry: false,
  })
}

export type NewWebhook = { scope: "drive" | "org"; url: string; eventTypes: WebhookEventType[]; description?: string }

/**
 * Create a webhook and hand back its signing secret. Deliberately not a
 * `useMutation`: the mutation cache keeps a mutation's result after the
 * component that ran it unmounts, and the secret must live only in the
 * dialog that shows it. The list is refetched from the server, which never
 * returns secrets.
 */
export async function createWebhook(
  queryClient: QueryClient,
  client: AgentFsClient,
  credentialId: string,
  orgId: string,
  driveId: string,
  input: NewWebhook,
): Promise<{ webhook: Webhook; secret: string }> {
  const result = splitSecret(await client.createWebhook(orgId, driveId, input))
  await queryClient.invalidateQueries({ queryKey: webhooksKey(credentialId, orgId, driveId) })
  return result
}

/** Rotate a webhook's signing secret. Not a `useMutation`, for the reason on `createWebhook`. */
export async function rotateWebhookSecret(
  queryClient: QueryClient,
  client: AgentFsClient,
  credentialId: string,
  orgId: string,
  driveId: string,
  id: string,
): Promise<{ webhook: Webhook; secret: string }> {
  const result = splitSecret(await client.rotateWebhookSecret(orgId, driveId, id))
  await queryClient.invalidateQueries({ queryKey: webhooksKey(credentialId, orgId, driveId) })
  return result
}

/** Enable, disable, delete and test. None of these responses carries a secret. */
export function useWebhookMutations(orgId: string, driveId: string) {
  const { client, credential } = useAuth()
  const queryClient = useQueryClient()
  const invalidate = () => queryClient.invalidateQueries({ queryKey: webhooksKey(credential.id, orgId, driveId) })

  const setEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => client.setWebhookEnabled(orgId, driveId, id, enabled),
    onSettled: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: string) => client.deleteWebhook(orgId, driveId, id),
    onSettled: invalidate,
  })
  return { setEnabled, remove }
}

/** One webhook's ping. A hook per row, so each row keeps its own inline result. */
export function useWebhookTest(orgId: string, driveId: string) {
  const { client, credential } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => client.testWebhook(orgId, driveId, id),
    // A ping does not count toward failures, but refresh anyway: the row may be stale.
    onSettled: () => queryClient.invalidateQueries({ queryKey: webhooksKey(credential.id, orgId, driveId) }),
  })
}

const DELIVERIES_PAGE = 25

/** A webhook's delivery log, newest first, a page at a time. */
export function useWebhookDeliveries(orgId: string, driveId: string, id: string, status: WebhookDeliveryStatus | null) {
  const { client, credential } = useAuth()
  return useInfiniteQuery({
    queryKey: [...deliveriesKey(credential.id, orgId, driveId, id), status],
    queryFn: ({ pageParam, signal }) =>
      client.listWebhookDeliveries(
        orgId,
        driveId,
        { id, limit: DELIVERIES_PAGE, ...(status ? { status } : {}), ...(pageParam ? { cursor: pageParam } : {}) },
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 0,
    retry: false,
  })
}

/** Queue one delivery again. Refreshes that webhook's log. */
export function useRedeliver(orgId: string, driveId: string, id: string) {
  const { client, credential } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (deliveryId: string) => client.redeliverWebhook(orgId, driveId, deliveryId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: deliveriesKey(credential.id, orgId, driveId, id) }),
  })
}
