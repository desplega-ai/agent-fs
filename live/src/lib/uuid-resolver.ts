import { useQuery } from "@tanstack/react-query"

import { useAuth } from "@/contexts/auth"
import type { CatResult } from "@/api/types"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const CACHE_KEY = "liveui:uuid-cache"

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

function cacheKey(orgId: string, driveId: string, fullPath: string): string {
  return `${orgId}::${driveId}::${fullPath}`
}

interface ReadResult {
  content?: string
}

async function tryRead(
  client: ReturnType<typeof useAuth>["client"],
  orgId: string,
  driveId: string,
  path: string,
): Promise<string | null> {
  try {
    const result = await client.callOp<ReadResult | CatResult>(
      orgId,
      "read",
      { path },
      driveId,
    )
    if (result && typeof (result as ReadResult).content === "string") {
      return (result as ReadResult).content as string
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
  const { client, orgId, driveId } = useAuth()
  const fullPath = parentPath ? `${parentPath}/${uuid}` : uuid

  const enabled = !!orgId && !!driveId && isUuidLike(uuid)

  const { data } = useQuery<string | null>({
    queryKey: ["uuid-name", orgId, driveId, fullPath],
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: async () => {
      if (!orgId || !driveId) return null
      const key = cacheKey(orgId, driveId, fullPath)
      const cache = readCache()
      if (key in cache) return cache[key] ?? null

      // Try meta.json first.
      const metaContent = await tryRead(
        client,
        orgId,
        driveId,
        `${fullPath}/meta.json`,
      )
      if (metaContent) {
        try {
          const parsed = JSON.parse(metaContent)
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
      const nameContent = await tryRead(
        client,
        orgId,
        driveId,
        `${fullPath}/.name`,
      )
      if (nameContent) {
        const firstLine = nameContent.split(/\r?\n/, 1)[0]?.trim() ?? ""
        if (firstLine) {
          cache[key] = firstLine
          writeCache(cache)
          return firstLine
        }
      }

      cache[key] = null
      writeCache(cache)
      return null
    },
  })

  return data ?? null
}
