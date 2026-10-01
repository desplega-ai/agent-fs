import type { DiffChange, DiffResult } from "@/api/types"
import { diffHasLineNumbers } from "@/lib/comment-anchor"

/** What a diff result lets the UI claim about two versions. */
export type DiffOutcome =
  | { kind: "identical" }
  | { kind: "unavailable" }
  /** `partial`: stored operation snippets, not a full comparison. */
  | { kind: "changes"; changes: DiffChange[]; partial: boolean }

/**
 * Only a content comparison with no changes proves two versions are equal.
 * "none", and an empty result from a server that doesn't report `source`,
 * mean the versions were never compared.
 */
export function diffOutcome(diff: DiffResult): DiffOutcome {
  const { changes, source } = diff
  if (source === "none") return { kind: "unavailable" }
  if (!changes.length) return source === "content" ? { kind: "identical" } : { kind: "unavailable" }
  return { kind: "changes", changes, partial: source === "summary" }
}

/**
 * The changes to remap comment line ranges through, or null when the result
 * isn't a line-by-line comparison. Summary snippets and "none" would remap
 * stale ranges as if nothing moved. Servers without `source` keep the old
 * rule for non-empty line-numbered changes; an empty one is unavailable.
 */
export function anchorDiffChanges(diff: DiffResult): DiffChange[] | null {
  if (diff.source === "content") return diff.changes
  if (diff.source != null || !diff.changes.length) return null
  return diffHasLineNumbers(diff.changes) ? diff.changes : null
}
