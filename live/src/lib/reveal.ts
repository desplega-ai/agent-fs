import { isUnknownOperationError } from "@/api/errors"
import type { AgentFsClient } from "@/api/client"
import type { RevealResult } from "@/api/types"

type RevealClient = Pick<AgentFsClient, "endpoint" | "callOp">

// Endpoints that answered "Unknown operation: reveal" (a deploy older than this
// UI). Keyed by endpoint, not global: accounts can point at independently
// deployed servers, and an old one must not disable reveal on a newer one.
const unsupportedEndpoints = new Set<string>()

/**
 * Fetch every ancestor listing of `path` in one round trip. Resolves to null
 * when the caller should fall back to per-ancestor `ls`: the endpoint lacks
 * `reveal`, the request failed, or it was aborted.
 */
export async function fetchReveal(
  client: RevealClient,
  orgId: string,
  driveId: string | undefined,
  path: string,
  signal?: AbortSignal,
): Promise<RevealResult | null> {
  if (unsupportedEndpoints.has(client.endpoint)) return null
  try {
    return await client.callOp<RevealResult>(orgId, "reveal", { path }, driveId, { signal })
  } catch (error) {
    if (isUnknownOperationError(error, "reveal")) unsupportedEndpoints.add(client.endpoint)
    return null
  }
}

/** Test hook: forget every endpoint marked unsupported. */
export function resetRevealSupport(): void {
  unsupportedEndpoints.clear()
}
