import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import type { CatResult } from "@/api/types"

export function useFileContent(path: string | null, offset = 0, limit = 200) {
  const { client, orgId, driveId } = useAuth()

  return useQuery({
    queryKey: ["cat", orgId, driveId, path, offset, limit],
    queryFn: () =>
      client.callOp<CatResult>(orgId!, "cat", { path: path!, offset, limit }, driveId),
    enabled: !!path && !!orgId && !!driveId,
  })
}
