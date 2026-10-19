import type { LsResult } from "@/api/types"

const MARKS = /\p{Mn}/gu
const NON_WORD = /[^\p{L}\p{N}]+/u

/** Lowercase and strip accents, so "Café" and "cafe" compare equal. Mirrors core `find`. */
function fold(text: string): string {
  // Lowercasing picks σ or ς for Σ by position. Use one form.
  return text.normalize("NFD").replace(MARKS, "").toLowerCase().replace(/ς/g, "σ")
}

/**
 * A simpler cousin of the server's `find` op, for the offline fallback: every
 * query word (split on spaces and punctuation) must appear in the file name,
 * in any order, ignoring case and accents. No subsequence matching or ranking.
 */
export function fileNameMatcher(query: string): (name: string) => boolean {
  const words = fold(query).split(NON_WORD).filter(Boolean)
  return (name) => {
    const folded = fold(name)
    return words.length > 0 && words.every((word) => folded.includes(word))
  }
}

/**
 * File paths whose name matches `query`, taken only from folder listings the
 * tree has already loaded. Used when the drive-wide search fails, so a search
 * still finds what the user has browsed without another request.
 */
export function filterLoadedListings(
  listings: ReadonlyArray<readonly [folder: string, result: LsResult | undefined]>,
  query: string,
): string[] {
  const matches = fileNameMatcher(query)
  const paths = new Set<string>()
  for (const [folder, result] of listings) {
    if (!result) continue
    const base = folder.replace(/^\/+|\/+$/g, "")
    for (const entry of result.entries) {
      if (entry.type !== "file" || !matches(entry.name)) continue
      paths.add(base ? `${base}/${entry.name}` : entry.name)
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b))
}
