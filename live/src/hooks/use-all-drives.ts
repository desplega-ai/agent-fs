import { useQueries } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import type { Drive } from "@/api/types"

/**
 * Every drive the viewer can open, across all their orgs. `drives` stays empty
 * until every org's list has loaded: a partial list could make a shared name
 * look unique. `failed` is true when a list could not be loaded.
 */
export function useAllDrives(): { drives: Drive[]; loaded: boolean; failed: boolean } {
  const { client, orgs, orgsLoaded } = useAuth()
  const results = useQueries({
    queries: orgs.map((org) => ({
      queryKey: ["drives", org.id],
      queryFn: () => client.getDrives(org.id),
    })),
  })
  const failed = results.some((r) => r.isError)
  const loaded = orgsLoaded && results.every((r) => r.isSuccess)
  const drives = loaded ? results.flatMap((r, i) => (r.data?.drives ?? []).map((d) => ({ ...d, orgId: orgs[i].id }))) : []
  return { drives, loaded, failed }
}
