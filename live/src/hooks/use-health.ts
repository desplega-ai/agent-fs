import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import { invitesAvailable } from "@/lib/invites"
import { healthQueryOptions } from "@/lib/upload-limit"

export function useHealth() {
  const { client } = useAuth()

  return useQuery({
    ...healthQueryOptions(client),
    refetchInterval: 30_000,
  })
}

/** True only while the server's health check is succeeding and lists the invite features. */
export function useInvitesSupported(): boolean {
  return invitesAvailable(useHealth())
}
