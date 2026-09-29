import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import { fetchFileStat, fileStatQueryKey } from "@/lib/file-stat-query"

export function useFileStat(path: string | null) {
  const { client, orgId, driveId } = useAuth()

  return useQuery({
    queryKey: fileStatQueryKey(orgId, driveId, path),
    queryFn: () => fetchFileStat(client, orgId!, driveId!, path!),
    enabled: !!path && !!orgId && !!driveId,
  })
}
