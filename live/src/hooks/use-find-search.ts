import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import { fetchFind } from "@/lib/find-search"
import { isRateLimitError } from "@/lib/request-errors"

/** A one-character query matches most of the drive; wait for two. */
export const MIN_FIND_QUERY_LENGTH = 2

export function isFindQueryLongEnough(query: string): boolean {
  return query.trim().length >= MIN_FIND_QUERY_LENGTH
}

/** Fuzzy, case- and accent-insensitive file-name search over the whole drive. */
export function useFindSearch(query: string) {
  const { client, orgId, driveId } = useAuth()

  return useQuery({
    queryKey: ["find", orgId, driveId, query],
    // Consuming `signal` lets TanStack Query abort the request as soon as the
    // query changes, so a stale search stops holding a rate-limit slot.
    queryFn: ({ signal }) => fetchFind(client, orgId!, driveId, query, signal),
    enabled: isFindQueryLongEnough(query) && !!orgId && !!driveId,
    // Retrying a rate-limited search immediately only spends another slot.
    retry: (failureCount, error) => !isRateLimitError(error) && failureCount < 1,
  })
}
