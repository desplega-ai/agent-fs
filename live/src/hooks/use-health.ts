import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import { healthQueryOptions } from "@/lib/upload-limit"

export function useHealth() {
  const { client } = useAuth()

  return useQuery({
    ...healthQueryOptions(client),
    refetchInterval: 30_000,
  })
}
