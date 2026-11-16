import { useQuery } from "@tanstack/react-query"

import { useAuth } from "@/contexts/auth"
import type { CatResult } from "@/api/types"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Older caches contain unscoped labels and misses from incomplete metadata.
const CACHE_KEY = "liveui:uuid-cache:v3"
const MAX_METADATA_LINES = 1000

export function isUuidLike(s: string): boolean {
  return UUID_RE.test(s)
}

type UuidCache = Record<string, string | null>

function readCache(): UuidCache {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as UuidCache) : {}
  } catch {
    return {}
  }
}

function writeCache(cache: UuidCache): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // ignore quota / privacy-mode failures
  }
}

async function tryRead(
  client: ReturnType<typeof useAuth>["client"],
  orgId: string,
  driveId: string,
  path: string,
  limit: number,
): Promise<CatResult | null> {
  try {
    const result = await client.callOp<CatResult>(
      orgId,
      "cat",
      { path, limit },
      driveId,
    )
    if (result && typeof result.content === "string") {
      return result
    }
    return null
  } catch {
    return null
  }
}

/**
 * Resolve a UUID-shaped folder name to a friendly name by looking for sibling
 * metadata. Tries `${path}/${uuid}/meta.json` first (`{ name }`), then
 * `${path}/${uuid}/.name` (plain text, first line).
 *
 * Returns `null` when neither is found. Misses are cached too to avoid
 * repeated round-trips for folders that simply don't have metadata.
 */
export function useUuidName(
  parentPath: string,
  uuid: string,
): string | null {
  const { client, credential, user, orgId, driveId } = useAuth()
  const fullPath = parentPath ? `${parentPath}/${uuid}` : uuid
  const userId = user?.userId
  const queryKey = ["uuid-name", credential.endpoint, credential.id, userId, orgId, driveId, fullPath]

  const enabled = !!userId && !!orgId && !!driveId && isUuidLike(uuid)

  const { data } = useQuery<string | null>({
    queryKey,
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    queryFn: async () => {
      if (!userId || !orgId || !driveId) return null
      const key = JSON.stringify(queryKey)
      const cache = readCache()
      if (key in cache) return cache[key] ?? null

      // Try meta.json first.
      const metadata = await tryRead(
        client,
        orgId,
        driveId,
        `${fullPath}/meta.json`,
        MAX_METADATA_LINES,
      )
      if (metadata?.content && !metadata.truncated) {
        try {
          const parsed = JSON.parse(metadata.content)
          if (parsed && typeof parsed.name === "string" && parsed.name.trim()) {
            const name = parsed.name.trim()
            cache[key] = name
            writeCache(cache)
            return name
          }
        } catch {
          // fall through
        }
      }

      // Fall back to .name.
      const nameFile = await tryRead(
        client,
        orgId,
        driveId,
        `${fullPath}/.name`,
        1,
      )
      if (nameFile?.content) {
        const firstLine = nameFile.content.split(/\r?\n/, 1)[0]?.trim() ?? ""
        if (firstLine) {
          cache[key] = firstLine
          writeCache(cache)
          return firstLine
        }
      }

      // Keep incomplete metadata retryable when the folder mounts again.
      if (metadata?.truncated) throw new Error("UUID metadata exceeds the line limit")

      cache[key] = null
      writeCache(cache)
      return null
    },
  })

  return data ?? null
}
