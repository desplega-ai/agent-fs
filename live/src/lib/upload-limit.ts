import type { AgentFsClient } from "../api/client"

export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024

export interface HealthResponse {
  ok: boolean
  version: string
  maxUploadBytes?: number
}

export function uploadLimitBytes(health?: HealthResponse): number {
  const bytes = health?.maxUploadBytes
  return typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes > 0
    ? bytes
    : DEFAULT_MAX_UPLOAD_BYTES
}

export function healthQueryOptions(client: AgentFsClient) {
  return {
    queryKey: ["health", client.endpoint],
    queryFn: () => client.get<HealthResponse>("/health", { signal: AbortSignal.timeout(5_000) }),
    staleTime: 30_000,
    retry: false as const,
  }
}
