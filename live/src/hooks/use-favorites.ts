import { useCallback, useMemo } from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  type MutationOptions,
  type QueryClient,
} from "@tanstack/react-query"
import type { AgentFsClient } from "@/api/client"
import { useAuth } from "@/contexts/auth"
import type { Favorite } from "@/api/types"
import { favoriteKey, favoritesQueryKey, supportsFavorites, withFavorite } from "@/lib/favorites"
import { healthQueryOptions } from "@/lib/upload-limit"
import { toast } from "@/stores/toast"

const EMPTY: Favorite[] = []

type FavoritesQueryKey = ReturnType<typeof favoritesQueryKey>
type FavoriteToggle = { path: string; kind: Favorite["kind"]; on: boolean }
type FavoriteToggleContext = { queryKey: FavoritesQueryKey; previous?: { favorites: Favorite[] } }

/**
 * The optimistic star toggle. Every callback works on the cache entry captured
 * in `onMutate`, never on the hook's current key: an account switch while the
 * request is in flight must not let this account's rollback land in another
 * account's list.
 */
export function createToggleFavoriteMutationOptions({
  client,
  orgId,
  driveId,
  queryKey,
  queryClient,
}: {
  client: AgentFsClient
  orgId: string | null
  driveId: string | null
  queryKey: FavoritesQueryKey
  queryClient: QueryClient
}): MutationOptions<void, Error, FavoriteToggle, FavoriteToggleContext> {
  return {
    mutationFn: ({ path, on }) => client.setFavorite(orgId!, driveId!, `/${favoriteKey(path)}`, on),
    onMutate: async ({ path, kind, on }) => {
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData<{ favorites: Favorite[] }>(queryKey)
      queryClient.setQueryData(queryKey, {
        favorites: withFavorite(previous?.favorites ?? EMPTY, path, kind, on),
      })
      return { queryKey, previous }
    },
    onError: (err, { on }, context) => {
      if (!context) return
      // The entry is gone when the cache was cleared (an account switch): there
      // is nothing of this account left on screen to roll back or warn about.
      if (!queryClient.getQueryCache().find({ queryKey: context.queryKey, exact: true })) return
      queryClient.setQueryData(context.queryKey, context.previous)
      toast.error(on ? "Couldn't add to favorites" : "Couldn't remove from favorites", {
        description: err instanceof Error ? err.message : undefined,
      })
    },
    onSettled: (_data, _err, _vars, context) =>
      queryClient.invalidateQueries({ queryKey: context?.queryKey ?? queryKey }),
  }
}

/**
 * The signed-in user's favorites in the active drive. Every star in the UI
 * reads this one cached list, so a toggle anywhere updates them all at once.
 */
export function useFavorites() {
  const { credential, client, orgId, driveId } = useAuth()
  const queryClient = useQueryClient()
  const { data: health } = useQuery(healthQueryOptions(client))
  const supported = !!orgId && !!driveId && supportsFavorites(health)
  const queryKey = favoritesQueryKey(credential.id, client.endpoint, orgId, driveId)

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: ({ signal }) => client.listFavorites(orgId!, driveId!, { signal }),
    enabled: supported,
    staleTime: 30_000,
  })
  const favorites = data?.favorites ?? EMPTY

  const starred = useMemo(
    () => new Set(favorites.map((f) => favoriteKey(f.path))),
    [favorites],
  )
  const isFavorite = useCallback((path: string) => starred.has(favoriteKey(path)), [starred])

  const { mutate } = useMutation(
    createToggleFavoriteMutationOptions({ client, orgId, driveId, queryKey, queryClient }),
  )

  const toggleFavorite = useCallback(
    (path: string, kind: Favorite["kind"]) => {
      if (!supported) return
      mutate({ path, kind, on: !starred.has(favoriteKey(path)) })
    },
    [supported, starred, mutate],
  )

  return { supported, favorites, isLoading, isFavorite, toggleFavorite }
}
