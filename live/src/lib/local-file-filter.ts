import type { LsResult } from "@/api/types"

/**
 * Mirror the files tab's glob (`**\/*{query}*`) on the file name alone:
 * `*` and `?` keep their wildcard meaning, everything else is literal, and the
 * match is case-sensitive like the server's.
 */
export function fileNameMatcher(query: string): RegExp {
  let body = ""
  for (const char of query) {
    if (char === "*") body += "[^/]*"
    else if (char === "?") body += "[^/]"
    else body += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(body)
}

/**
 * File paths whose name matches `query`, taken only from folder listings the
 * tree has already loaded. Used when the drive-wide glob fails, so a search
 * still finds what the user has browsed without another request.
 */
export function filterLoadedListings(
  listings: ReadonlyArray<readonly [folder: string, result: LsResult | undefined]>,
  query: string,
): string[] {
  const matcher = fileNameMatcher(query)
  const paths = new Set<string>()
  for (const [folder, result] of listings) {
    if (!result) continue
    const base = folder.replace(/^\/+|\/+$/g, "")
    for (const entry of result.entries) {
      if (entry.type !== "file" || !matcher.test(entry.name)) continue
      paths.add(base ? `${base}/${entry.name}` : entry.name)
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b))
}
