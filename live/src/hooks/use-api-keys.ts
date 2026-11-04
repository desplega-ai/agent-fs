import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"

/** Query key of the signed-in account's API key list. */
const apiKeysKey = (credentialId: string) => ["api-keys", credentialId] as const

/** The signed-in account's active API keys. */
export function useApiKeys() {
  const { client, credential } = useAuth()
  return useQuery({
    queryKey: apiKeysKey(credential.id),
    queryFn: () => client.listApiKeys(),
    staleTime: 0,
    retry: false,
  })
}

/** Create and revoke keys; both refresh the list. */
export function useApiKeyMutations() {
  const { client, credential } = useAuth()
  const queryClient = useQueryClient()
  const invalidate = () => queryClient.invalidateQueries({ queryKey: apiKeysKey(credential.id) })

  const create = useMutation({
    mutationFn: (label: string) => client.createApiKey(label),
    onSettled: invalidate,
  })
  const revoke = useMutation({
    mutationFn: (id: string) => client.revokeApiKey(id),
    onSettled: invalidate,
  })
  return { create, revoke }
}
