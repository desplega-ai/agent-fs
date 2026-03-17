import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import type { DiffResult } from "@/api/types"

export function useDiff(path: string | null, v1: number, v2: number) {
  const { client, orgId, driveId } = useAuth()

  return useQuery({
    queryKey: ["diff", orgId, driveId, path, v1, v2],
    queryFn: () =>
      client.callOp<DiffResult>(orgId!, "diff", { path: path!, v1, v2 }, driveId),
    enabled: !!path && !!orgId && !!driveId && v1 > 0 && v2 > 0 && v1 !== v2,
  })
}
