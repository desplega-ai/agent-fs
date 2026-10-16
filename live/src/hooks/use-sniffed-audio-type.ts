import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import { readHead, sniffAudioType } from "@/lib/audio"

/**
 * The audio type announced by the first bytes of `path` (a `null` path skips
 * the check). Reads only the head of the raw body, so it is cheap to run for
 * any file that has no preview otherwise.
 */
export function useSniffedAudioType(path: string | null, version?: number) {
  const { client, orgId, driveId } = useAuth()

  return useQuery({
    queryKey: ["audio-sniff", orgId, driveId, path, version ?? null],
    queryFn: async ({ signal }) => {
      const res = await client.fetchRawResponse(orgId!, driveId!, path!, { signal })
      return sniffAudioType(await readHead(res))
    },
    enabled: !!path && !!orgId && !!driveId,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  })
}
