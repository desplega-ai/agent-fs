import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import type { GlobResult } from "@/api/types"

export function useGlobSearch(pattern: string) {
  const { client, orgId, driveId } = useAuth()

  return useQuery({
    queryKey: ["glob", orgId, driveId, pattern],
    queryFn: () => client.callOp<GlobResult>(orgId!, "glob", { pattern: `**/*${pattern}*` }, driveId),
    enabled: !!pattern && !!orgId && !!driveId,
  })
}
