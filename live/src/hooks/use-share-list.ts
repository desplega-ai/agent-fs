import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import { useHealth } from "@/hooks/use-health"
import type { ShareListItem, ShareListResult } from "@/api/types"
import { shareListQueryPrefix, supportsShareList } from "@/lib/share-list"
import { toast } from "@/stores/toast"

const PAGE_SIZE = 100

export interface ShareListOptions {
  scope: "drive" | "mine"
  /** Drive scope only: the file or folder whose links to list. */
  path?: string
  /** Drive scope only: list this drive instead of the active one. */
  driveId?: string
  includeInactive: boolean
  /** Lets a caller keep the query off, e.g. while its dialog is closed. */
  enabled?: boolean
}

/**
 * Share links for one path or for the caller across the org, newest first,
 * one page of 100 at a time. Off on servers without `share-list`.
 */
export function useShareList({ scope, path, driveId: driveOverride, includeInactive, enabled = true }: ShareListOptions) {
  const { credential, client, orgId, driveId: activeDriveId } = useAuth()
  const driveId = driveOverride ?? activeDriveId
  const { data: health } = useHealth()
  const supported = !!orgId && !!driveId && supportsShareList(health)
  // The drive only matters for drive scope; the mine scope lists every drive
  // and the active one only satisfies the server's membership check.
  const queryKey = [
    ...shareListQueryPrefix(credential.id, client.endpoint, orgId),
    scope,
    scope === "drive" ? driveId : null,
    path ?? null,
    includeInactive,
  ] as const

  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) =>
      client.listShares(orgId!, driveId!, { scope, path, includeInactive, limit: PAGE_SIZE, offset: pageParam }, { signal }),
    initialPageParam: 0,
    getNextPageParam: (last: ShareListResult) => {
      const next = last.offset + last.shares.length
      return last.shares.length > 0 && next < last.total ? next : undefined
    },
    enabled: supported && enabled,
    staleTime: 10_000,
  })

  const pages = query.data?.pages ?? []
  const shares: ShareListItem[] = pages.flatMap((p) => p.shares)
  const last = pages[pages.length - 1]
  return {
    supported,
    shares,
    total: last?.total ?? 0,
    visibility: last?.visibility ?? "own",
    isPending: supported && enabled && query.isPending,
    error: query.error,
    hasMore: query.hasNextPage,
    loadMore: () => query.fetchNextPage(),
    isLoadingMore: query.isFetchingNextPage,
  }
}

/** Refetch every share-list view of the active account and org (after a create or a revoke). */
export function useInvalidateShareLists() {
  const { credential, client, orgId } = useAuth()
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: shareListQueryPrefix(credential.id, client.endpoint, orgId) })
}

/**
 * Revoke one link through `share-revoke`, on the link's own drive (a row in
 * the global view can live in a drive other than the active one).
 */
export function useRevokeShare() {
  const { client, orgId } = useAuth()
  const invalidate = useInvalidateShareLists()
  return useMutation({
    mutationFn: (item: Pick<ShareListItem, "id" | "drive">) => client.revokeShare(orgId!, item.drive.id, item.id),
    onSuccess: (res) => {
      if (res.revoked > 0) toast.success("Link revoked")
      else toast("That link was already gone")
    },
    onError: (err) =>
      toast.error("Couldn't revoke link", { description: err instanceof Error ? err.message : undefined }),
    onSettled: invalidate,
  })
}
