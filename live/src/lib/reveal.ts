import { isUnknownOperationError } from "@/api/errors"
import type { QueryClient } from "@tanstack/react-query"
import type { AgentFsClient } from "@/api/client"
import type { LsResult, RevealResult } from "@/api/types"

type RevealClient = Pick<AgentFsClient, "endpoint" | "callOp">

export const TREE_STALE_TIME = 30_000

export function ancestorPaths(path: string): string[] {
  const parts = path.split("/").filter(Boolean)
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))
}

/** Populate only the listings needed to show this file in the tree. */
export async function revealFile(
  queryClient: QueryClient,
  client: RevealClient,
  orgId: string,
  driveId: string,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  const parts = path.split("/").filter(Boolean)
  const parents = ["", ...ancestorPaths(path)]
  const queryKey = (parent: string) => ["ls", orgId, driveId, parent]
  const containsChild = (listing: LsResult | undefined, index: number) =>
    listing?.entries.some((entry) =>
      entry.name === parts[index] &&
      entry.type === (index === parts.length - 1 ? "file" : "directory"),
    )
  const hasFreshChild = (parent: string, index: number) => {
    const state = queryClient.getQueryState<LsResult>(queryKey(parent))
    return state && !state.isInvalidated && Date.now() - state.dataUpdatedAt < TREE_STALE_TIME &&
      containsChild(state.data, index)
  }
  if (parents.every(hasFreshChild)) return

  // Stop older ancestor requests before they can overwrite the reveal result.
  await Promise.all(parents.map((parent) => queryClient.cancelQueries({ queryKey: queryKey(parent), exact: true })))
  signal.throwIfAborted()
  const result = await fetchReveal(client, orgId, driveId, path, signal)
  signal.throwIfAborted()
  if (result) {
    for (const listing of result.listings) {
      queryClient.setQueryData<LsResult>(
        queryKey(listing.path.replace(/^\/+/, "")),
        { entries: listing.entries },
      )
    }
    return
  }

  // Old servers need individual listings. Refresh a fresh parent too when it
  // lacks the next entry: another client may have just created that entry.
  for (const [index, parent] of parents.entries()) {
    signal.throwIfAborted()
    if (hasFreshChild(parent, index)) continue
    await queryClient.fetchQuery({
      queryKey: queryKey(parent),
      queryFn: ({ signal: querySignal }) => client.callOp<LsResult>(
        orgId, "ls", { path: parent }, driveId,
        { signal: AbortSignal.any([signal, querySignal]) },
      ),
      staleTime: 0,
    })
  }
}

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
