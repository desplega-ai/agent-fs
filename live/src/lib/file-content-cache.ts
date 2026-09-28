import type { QueryClient } from "@tanstack/react-query"
import type { AgentFsClient } from "@/api/client"
import type { StatResult } from "@/api/types"
import { fetchFileStat, fileStatQueryKey } from "./file-stat-query"

/** File text as the viewers consume it. */
export interface FileContentData {
  content: string
  totalLines: number
  truncated: boolean
}

/** A downloaded body plus the identity of the bytes it was read at. */
export interface CachedFileContent extends FileContentData {
  validator: string
}

export function fileContentKey(orgId: string | null, driveId: string | null, path: string | null) {
  return ["file-content", orgId, driveId, path] as const
}

/**
 * Identity of a file's current bytes, built from a fresh `stat`. Two stats with
 * the same validator describe the same content, so a cached body can be reused
 * without downloading it again. Anything that may change the bytes must change
 * the validator, so this errs toward "different":
 * - the storage `etag` when the server reports one (it tracks the stored bytes
 *   themselves, even for writes that never bumped `currentVersion`);
 * - otherwise version + size + modified time together, which older servers
 *   report. Writes to the same path spelled with and without a leading slash
 *   keep separate version rows, so the version alone is not trusted.
 */
export function statValidator(
  stat: Pick<StatResult, "etag" | "currentVersion" | "size" | "modifiedAt">,
): string {
  if (stat.etag) return `e:${stat.etag}`
  return `v:${stat.currentVersion ?? ""}:${stat.size}:${stat.modifiedAt}`
}

/**
 * Returns the cached body when it was read at the same bytes as `stat`
 * describes; otherwise calls `download` and stamps the result. Only ever
 * returns text that matches the stat it was given.
 */
export async function loadFileContent(
  cached: CachedFileContent | undefined,
  stat: Pick<StatResult, "etag" | "currentVersion" | "size" | "modifiedAt">,
  download: () => Promise<string>,
): Promise<CachedFileContent> {
  const validator = statValidator(stat)
  if (cached && cached.validator === validator) return cached
  const text = await download()
  return {
    content: text,
    totalLines: text.split("\n").length,
    truncated: false,
    validator,
  }
}

/**
 * The entry after the user saved `text` over it. The stored validator described
 * the old bytes and the server may have changed the file again since, so it is
 * cleared: the next open downloads once instead of trusting a guess.
 */
export function withSavedText(entry: CachedFileContent, text: string): CachedFileContent {
  return { ...entry, content: text, totalLines: text.split("\n").length, validator: "" }
}

/** Bodies above this many characters are dropped when their viewer closes, to bound memory. */
export const MAX_RETAINED_CHARS = 2_000_000

/** How long a closed file's body stays reusable. */
export const CONTENT_GC_MS = 5 * 60_000

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
      return loadFileContent(queryClient.getQueryData<CachedFileContent>(queryKey), stat, async () => {
        const result = await client.getSignedUrl(orgId, driveId, path)
        // `no-store`: a browser-cached body would be stored under the new validator.
        const res = await fetch(result.url, { signal, cache: "no-store" })
        if (!res.ok) throw new Error(`Failed to fetch: ${res.statusText}`)
        return res.text()
      })
    },
  }
}
