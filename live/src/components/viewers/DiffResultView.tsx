import type { DiffResult } from "@/api/types"
import { diffOutcome } from "@/lib/diff-source"
import { DiffViewer } from "./DiffViewer"

interface DiffResultViewProps {
  diff: DiffResult
  className?: string
}

/** A diff result, labeled so an uncompared pair never reads as unchanged. */
export function DiffResultView({ diff, className }: DiffResultViewProps) {
  const outcome = diffOutcome(diff)
  switch (outcome.kind) {
    case "identical":
      return <p className="px-4 py-3 text-xs text-muted-foreground">No changes between these versions.</p>
    case "unavailable":
      return (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          Comparison unavailable: this storage backend can't compare these versions. They may differ.
        </p>
      )
    case "changes":
      return (
        <>
          {outcome.partial && (
            <p className="px-4 py-1.5 text-xs text-muted-foreground">
              Stored operation snippets, not a full diff.
            </p>
          )}
          <DiffViewer changes={outcome.changes} className={className} />
        </>
      )
  }
}
