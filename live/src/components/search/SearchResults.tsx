import { File, ArrowLeft } from "lucide-react"
import { useBrowser } from "@/contexts/browser"
import { cn } from "@/lib/utils"

interface SearchResultItem {
  path: string
  snippet?: string
  score?: number
}

interface SearchResultsProps {
  results: SearchResultItem[]
  isLoading: boolean
  onClear: () => void
}

export function SearchResults({ results, isLoading, onClear }: SearchResultsProps) {
  const { selectFile, selectedFile } = useBrowser()

  if (isLoading) {
    return (
      <div className="space-y-1 p-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-10 rounded-sm bg-sidebar-accent/50 animate-pulse" />
        ))}
      </div>
    )
  }

  return (
    <div className="py-1">
      <button
        onClick={onClear}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent transition-colors"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to file tree
      </button>

      {results.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground text-center">No results found</p>
      ) : (
        results.map((r) => (
          <button
            key={r.path}
            onClick={() => selectFile(r.path)}
            className={cn(
              "flex w-full flex-col gap-0.5 rounded-sm px-3 py-1.5 text-left hover:bg-sidebar-accent transition-colors",
              selectedFile === r.path && "bg-sidebar-accent"
            )}
          >
            <div className="flex items-center gap-1.5">
              <File className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="text-sm truncate">{r.path}</span>
              {r.score !== undefined && (
                <span className="ml-auto text-[10px] text-muted-foreground shrink-0">
                  {(r.score * 100).toFixed(0)}%
                </span>
              )}
            </div>
            {r.snippet && (
              <p
                className="text-xs text-muted-foreground truncate pl-[18px]"
                dangerouslySetInnerHTML={{ __html: r.snippet }}
              />
            )}
          </button>
        ))
      )}
    </div>
  )
}
