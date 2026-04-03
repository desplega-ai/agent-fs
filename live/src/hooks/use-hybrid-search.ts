import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import type { SearchResult } from "@/api/types"

export function useHybridSearch(query: string) {
  const { client, orgId, driveId } = useAuth()

  return useQuery({
    queryKey: ["hybrid-search", orgId, driveId, query],
    queryFn: () => client.callOp<SearchResult>(orgId!, "search", { query }, driveId),
    enabled: !!query && !!orgId && !!driveId,
  })
}
