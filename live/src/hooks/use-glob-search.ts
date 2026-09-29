import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import { isRateLimitError } from "@/lib/request-errors"
import type { GlobResult } from "@/api/types"

/** A one-character drive-wide glob matches most of the drive; wait for two. */
export const MIN_GLOB_QUERY_LENGTH = 2

export function isGlobQueryLongEnough(pattern: string): boolean {
  return pattern.trim().length >= MIN_GLOB_QUERY_LENGTH
}

export function useGlobSearch(pattern: string) {
  const { client, orgId, driveId } = useAuth()

  return useQuery({
    queryKey: ["glob", orgId, driveId, pattern],
    // Consuming `signal` lets TanStack Query abort the request as soon as the
    // query changes, so a stale glob stops holding a rate-limit slot.
    queryFn: ({ signal }) =>
      client.callOp<GlobResult>(orgId!, "glob", { pattern: `**/*${pattern}*` }, driveId, { signal }),
    enabled: isGlobQueryLongEnough(pattern) && !!orgId && !!driveId,
    // Retrying a rate-limited glob immediately only spends another slot.
    retry: (failureCount, error) => !isRateLimitError(error) && failureCount < 1,
  })
}
