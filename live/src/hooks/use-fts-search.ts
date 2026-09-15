import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import type { FtsResult } from "@/api/types"
import { serializeLiteralFtsQuery } from "@/lib/literal-fts"

export function useFtsSearch(pattern: string) {
  const { client, orgId, driveId } = useAuth()
  const literalPattern = serializeLiteralFtsQuery(pattern)

  return useQuery({
    queryKey: ["fts", orgId, driveId, pattern],
    queryFn: () =>
      client.callOp<FtsResult>(orgId!, "fts", { pattern: literalPattern }, driveId),
    enabled: !!literalPattern && !!orgId && !!driveId,
  })
}
