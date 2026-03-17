import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"

interface HealthResponse {
  ok: boolean
  version: string
}

export function useHealth() {
  const { client } = useAuth()

  return useQuery({
    queryKey: ["health"],
    queryFn: () => client.get<HealthResponse>("/health"),
    refetchInterval: 30_000,
    retry: false,
  })
}
