import { isUnknownOperationError } from "@/api/errors"
import type { AgentFsClient } from "@/api/client"
import type { FindResult, GlobResult } from "@/api/types"

type FindClient = Pick<AgentFsClient, "endpoint" | "callOp">

/** The panel lists this many matches; the rest only count toward `total`. */
export const FIND_RESULT_LIMIT = 50

// Endpoints that answered "Unknown operation: find" (a deploy older than this
// UI). Keyed by endpoint, not global: accounts can point at independently
// deployed servers, and an old one must not disable find on a newer one.
const unsupportedEndpoints = new Set<string>()

/**
 * Fuzzy, ranked file-name search over the whole drive. On a server without
 * `find`, falls back to the case-sensitive `**\/*query*` glob this tab used
 * before, unranked and capped the same way.
 */
export async function fetchFind(
  client: FindClient,
  orgId: string,
  driveId: string | undefined,
  query: string,
  signal?: AbortSignal,
): Promise<FindResult> {
  if (!unsupportedEndpoints.has(client.endpoint)) {
    try {
      return await client.callOp<FindResult>(
        orgId,
        "find",
        { query, limit: FIND_RESULT_LIMIT },
        driveId,
        { signal },
      )
    } catch (error) {
      if (!isUnknownOperationError(error, "find")) throw error
      unsupportedEndpoints.add(client.endpoint)
    }
  }
  const { matches } = await client.callOp<GlobResult>(
    orgId,
    "glob",
    { pattern: `**/*${query}*` },
    driveId,
    { signal },
  )
  return {
    matches: matches.slice(0, FIND_RESULT_LIMIT).map((match) => ({ ...match, score: 0 })),
    total: matches.length,
  }
}

/** Test hook: forget every endpoint marked unsupported. */
export function resetFindSupport(): void {
  unsupportedEndpoints.clear()
}
