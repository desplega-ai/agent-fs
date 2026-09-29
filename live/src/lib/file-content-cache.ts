import type { Query, QueryClient } from "@tanstack/react-query"
import type { AgentFsClient } from "@/api/client"
import type { StatResult } from "@/api/types"
import { fetchFileStat, fileStatQueryKey } from "./file-stat-query"

/** File text as the viewers consume it. */
export interface FileContentData {
  content: string
  totalLines: number
  truncated: boolean
}

/**
 * A downloaded body plus the identity of the bytes it was read at: the storage
 * ETag the download response itself carried, or `null` when the response gave
 * none. A `null` body is still shown, but never reused.
 */
export interface CachedFileContent extends FileContentData {
  validator: string | null
}

/** What a download hands back: the text and the `ETag` header of the response that carried it. */
export interface DownloadedText {
  text: string
  etag: string | null
}

export function fileContentKey(orgId: string | null, driveId: string | null, path: string | null) {
  return ["file-content", orgId, driveId, path] as const
}

/**
 * The comparable form of a storage ETag, or `null` when it cannot vouch for the
 * bytes. Quotes are not part of the identity (`stat` and the download response
 * may or may not carry them). A weak ETag (`W/"..."`) only promises "equivalent",
 * so it is not trusted either.
 */
export function normalizeEtag(etag: string | null | undefined): string | null {
  const value = etag?.trim()
  if (!value || value.startsWith("W/")) return null
  const bare = value.replace(/^"(.*)"$/, "$1")
  return bare ? `e:${bare}` : null
}

/**
 * Identity of a file's current bytes, from a fresh `stat`, or `null` when the
 * server reports none. Only the storage ETag counts: it tracks the stored
 * bytes themselves. Version, size and modified time do not, because a write
 * through the other spelling of the same path (with or without a leading
 * slash) changes the bytes while leaving all three as they were. Servers that
 * predate the field therefore get no body reuse.
 */
export function statValidator(stat: Pick<StatResult, "etag">): string | null {
  return normalizeEtag(stat.etag)
}

/**
 * Returns the cached body when it was read at the same bytes as `stat`
 * describes; otherwise calls `download` and stamps the result with the identity
 * the download response reported. The stamp is never taken from `stat`: the
 * file can change between the stat and the download, and a body stamped with
 * the earlier identity would be reused once the file reverted to it.
 */
export async function loadFileContent(
  cached: CachedFileContent | undefined,
  stat: Pick<StatResult, "etag">,
  download: () => Promise<DownloadedText>,
): Promise<CachedFileContent> {
  const current = statValidator(stat)
  if (cached && current !== null && cached.validator === current) return cached
  const { text, etag } = await download()
  return {
    content: text,
    totalLines: text.split("\n").length,
    truncated: false,
    validator: normalizeEtag(etag),
  }
}

/**
 * The entry after the user saved `text` over it. The stored validator described
 * the old bytes and the server may have changed the file again since, so it is
 * cleared: the next open downloads once instead of trusting a guess.
 */
export function withSavedText(entry: CachedFileContent, text: string): CachedFileContent {
  return { ...entry, content: text, totalLines: text.split("\n").length, validator: null }
}

/** Bodies above this many characters are dropped when their viewer closes, to bound memory. */
export const MAX_RETAINED_CHARS = 2_000_000

/**
 * Most characters of file text kept across every cached file at once: five
 * files at the per-file cap, about 10-20 MB of strings. Only closed files count
 * against the limit for eviction; files open in a viewer are never dropped.
 */
export const MAX_TOTAL_RETAINED_CHARS = 10_000_000

/** How long a closed file's body stays reusable. */
export const CONTENT_GC_MS = 5 * 60_000

/**
 * Drops the least recently loaded closed files until the text cached for all
 * files, plus the `incomingChars` about to be stored under `incomingKey`, fits
 * in `MAX_TOTAL_RETAINED_CHARS`. Per-file limits and the gc timer cannot bound
 * this: many files below the per-file cap add up.
 */
export function evictToBudget(
  queryClient: QueryClient,
  incomingKey: readonly unknown[],
  incomingChars: number,
): void {
  const queryCache = queryClient.getQueryCache()
  const incoming = JSON.stringify(incomingKey)
  let total = incomingChars
  const closed: { query: Query; chars: number }[] = []
  for (const query of queryCache.findAll({ queryKey: ["file-content"] })) {
    if (JSON.stringify(query.queryKey) === incoming) continue
    const data = query.state.data as CachedFileContent | undefined
    if (!data) continue
    total += data.content.length
    if (query.getObserversCount() === 0) closed.push({ query, chars: data.content.length })
  }
  // A successful load, including a revalidation that reused the body, restamps
  // `dataUpdatedAt`, so the oldest stamp is the file least recently opened.
  closed.sort((a, b) => a.query.state.dataUpdatedAt - b.query.state.dataUpdatedAt)
  for (const { query, chars } of closed) {
    if (total <= MAX_TOTAL_RETAINED_CHARS) break
    queryCache.remove(query)
    total -= chars
  }
}

/**
 * Query options for a file's text. Each run first fetches a fresh `stat` (one
 * small request, shared with the viewer's own stat query), then either hands
 * back the cached body or downloads it through a newly minted signed URL.
 */
export function fileContentQueryOptions(
  queryClient: QueryClient,
  client: AgentFsClient,
  orgId: string,
  driveId: string,
  path: string,
) {
  const queryKey = fileContentKey(orgId, driveId, path)
  return {
    queryKey,
    // Every open re-checks the file, so a cached body is only reused when it is
    // exactly the file's current content.
    staleTime: 0,
    gcTime: CONTENT_GC_MS,
    queryFn: async ({ signal }: { signal?: AbortSignal }): Promise<CachedFileContent> => {
      const stat = await queryClient.fetchQuery({
        queryKey: fileStatQueryKey(orgId, driveId, path),
        queryFn: () => fetchFileStat(client, orgId, driveId, path),
        staleTime: 0,
      })
      const entry = await loadFileContent(queryClient.getQueryData<CachedFileContent>(queryKey), stat, async () => {
        const result = await client.getSignedUrl(orgId, driveId, path)
        // `no-store`: read the object as it is now, not a browser-cached copy of an earlier one.
        const res = await fetch(result.url, { signal, cache: "no-store" })
        if (!res.ok) throw new Error(`Failed to fetch: ${res.statusText}`)
        // The identity of these bytes is the ETag of this very response. Storage
        // must expose it to the page (CORS `Access-Control-Expose-Headers: ETag`);
        // without it the body is shown but re-downloaded on the next open.
        return { text: await res.text(), etag: res.headers.get("etag") }
      })
      evictToBudget(queryClient, queryKey, entry.content.length)
      return entry
    },
  }
}
