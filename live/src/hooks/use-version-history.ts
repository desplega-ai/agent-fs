import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import type { LogResult } from "@/api/types"

export function useVersionHistory(path: string | null) {
  const { client, orgId, driveId } = useAuth()

  return useQuery({
    queryKey: ["log", orgId, driveId, path],
    queryFn: () => client.callOp<LogResult>(orgId!, "log", { path: path! }, driveId),
    enabled: !!path && !!orgId && !!driveId,
  })
}
