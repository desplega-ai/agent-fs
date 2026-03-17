import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import type { FtsResult } from "@/api/types"

export function useFtsSearch(pattern: string) {
  const { client, orgId, driveId } = useAuth()

  return useQuery({
    queryKey: ["fts", orgId, driveId, pattern],
    queryFn: () => client.callOp<FtsResult>(orgId!, "fts", { pattern }, driveId),
    enabled: !!pattern && !!orgId && !!driveId,
  })
}
