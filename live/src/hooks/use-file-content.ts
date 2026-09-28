import { useCallback, useEffect } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import {
  MAX_RETAINED_CHARS,
  fileContentKey,
  fileContentQueryOptions,
  withSavedText,
  type CachedFileContent,
} from "@/lib/file-content-cache"

export function useFileContent(path: string | null, _offset = 0, _limit = 200) {
  const { client, orgId, driveId } = useAuth()
  const queryClient = useQueryClient()
  const enabled = !!path && !!orgId && !!driveId

  const query = useQuery({
    ...fileContentQueryOptions(queryClient, client, orgId ?? "", driveId, path ?? ""),
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  // Very large bodies are not worth holding on to once their viewer closes.
  useEffect(() => {
    if (!enabled) return
    const queryKey = fileContentKey(orgId, driveId, path)
    return () => {
      const cached = queryClient.getQueryData<CachedFileContent>(queryKey)
      if (cached && cached.content.length > MAX_RETAINED_CHARS) {
        queryClient.removeQueries({ queryKey, exact: true })
      }
    }
  }, [enabled, queryClient, orgId, driveId, path])

  /**
   * Replace the cached text after a successful save so every viewer shows
   * what was written, without a refetch through a new signed URL.
   */
  const setContent = useCallback((forPath: string, text: string) => {
    queryClient.setQueryData<CachedFileContent>(
      fileContentKey(orgId, driveId, forPath),
      (prev) => prev && withSavedText(prev, text),
    )
  }, [queryClient, orgId, driveId])

  // While a revalidation is in flight the cached body is not yet known to be
  // current, so it is withheld rather than shown and swapped.
  const settled = query.isSuccess && !query.isFetching
  return {
    data: settled ? query.data : undefined,
    isLoading: enabled && !query.isError && !settled,
    error: query.error,
    setContent,
  }
}
