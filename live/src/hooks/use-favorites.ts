import { useCallback, useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import type { Favorite } from "@/api/types"
import { favoriteKey, favoritesQueryKey, supportsFavorites, withFavorite } from "@/lib/favorites"
import { healthQueryOptions } from "@/lib/upload-limit"
import { toast } from "@/stores/toast"

const EMPTY: Favorite[] = []

/**
 * The signed-in user's favorites in the active drive. Every star in the UI
 * reads this one cached list, so a toggle anywhere updates them all at once.
 */
export function useFavorites() {
  const { client, orgId, driveId } = useAuth()
  const queryClient = useQueryClient()
  const { data: health } = useQuery(healthQueryOptions(client))
  const supported = !!orgId && !!driveId && supportsFavorites(health)
  const queryKey = favoritesQueryKey(client.endpoint, orgId, driveId)

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

  const { mutate } = useMutation({
    mutationFn: ({ path, on }: { path: string; kind: Favorite["kind"]; on: boolean }) =>
      client.setFavorite(orgId!, driveId!, `/${favoriteKey(path)}`, on),
    onMutate: async ({ path, kind, on }) => {
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData<{ favorites: Favorite[] }>(queryKey)
      queryClient.setQueryData(queryKey, {
        favorites: withFavorite(previous?.favorites ?? EMPTY, path, kind, on),
      })
      return { previous }
    },
    onError: (err, { on }, context) => {
      queryClient.setQueryData(queryKey, context?.previous)
      toast.error(on ? "Couldn't add to favorites" : "Couldn't remove from favorites", {
        description: err instanceof Error ? err.message : undefined,
      })
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })

  const toggleFavorite = useCallback(
    (path: string, kind: Favorite["kind"]) => {
      if (!supported) return
      mutate({ path, kind, on: !starred.has(favoriteKey(path)) })
    },
    [supported, starred, mutate],
  )

  return { supported, favorites, isLoading, isFavorite, toggleFavorite }
}
