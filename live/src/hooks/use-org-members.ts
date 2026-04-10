import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"

export function useOrgMembers() {
  const { client, orgId } = useAuth()

  return useQuery({
    queryKey: ["org-members", orgId],
    queryFn: () => client.getOrgMembers(orgId!),
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000,
  })
}

export function useUserResolver(): (userId: string) => string | null {
  const { data } = useOrgMembers()

  const map = useMemo(() => {
    if (!data?.members) return {}
    return data.members.reduce<Record<string, string>>((acc, m) => {
      acc[m.userId] = m.email
      return acc
    }, {})
  }, [data?.members])

  return (userId: string) => map[userId] ?? null
}
