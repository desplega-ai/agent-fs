import { useState } from "react"
import { ChevronDown, ChevronRight, GitCommit, Loader2 } from "lucide-react"
import { useVersionHistory } from "@/hooks/use-version-history"
import { useDiff } from "@/hooks/use-diff"
import { DiffViewer } from "./viewers/DiffViewer"
import { cn } from "@/lib/utils"

interface VersionHistoryProps {
  path: string
}

export function VersionHistory({ path }: VersionHistoryProps) {
  const [expanded, setExpanded] = useState(false)
  const [selectedDiff, setSelectedDiff] = useState<{ v1: number; v2: number } | null>(null)

  const { data, isLoading } = useVersionHistory(expanded ? path : null)
  const { data: diffData, isLoading: diffLoading } = useDiff(
    selectedDiff ? path : null,
    selectedDiff?.v1 ?? 0,
    selectedDiff?.v2 ?? 0
  )

  return (
    <div className="border-t border-border">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
      >
        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        Version History
        {data && <span className="text-xs text-muted-foreground">({data.versions.length})</span>}
      </button>

      {expanded && (
        <div className="border-t border-border">
          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : !data?.versions.length ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">No version history</p>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {data.versions.map((v, i) => {
                const prevVersion = data.versions[i + 1]
                const isSelected =
                  selectedDiff?.v1 === prevVersion?.version &&
                  selectedDiff?.v2 === v.version

                return (
                  <button
                    key={v.version}
                    onClick={() => {
                      if (prevVersion) {
                        setSelectedDiff(
                          isSelected ? null : { v1: prevVersion.version, v2: v.version }
                        )
                      }
                    }}
                    className={cn(
                      "flex w-full items-start gap-2 px-4 py-2 text-left text-sm hover:bg-accent transition-colors",
                      isSelected && "bg-accent"
                    )}
                  >
                    <GitCommit className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">v{v.version}</span>
                        <span className="text-xs text-muted-foreground">{v.operation}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {v.author} &middot; {new Date(v.createdAt).toLocaleString()}
                      </div>
                      {v.message && (
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">{v.message}</p>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          )}

          {selectedDiff && (
            <div className="border-t border-border">
              <p className="px-4 py-1.5 text-xs text-muted-foreground">
                Diff: v{selectedDiff.v1} → v{selectedDiff.v2}
              </p>
              {diffLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : diffData ? (
                <DiffViewer changes={diffData.changes} className="max-h-80" />
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
