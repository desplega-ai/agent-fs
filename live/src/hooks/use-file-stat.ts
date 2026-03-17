import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import type { StatResult } from "@/api/types"

export function useFileStat(path: string | null) {
  const { client, orgId, driveId } = useAuth()

  return useQuery({
    queryKey: ["stat", orgId, driveId, path],
    queryFn: () =>
      client.callOp<StatResult>(orgId!, "stat", { path: path! }, driveId),
    enabled: !!path && !!orgId && !!driveId,
  })
}
