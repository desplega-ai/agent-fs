import { cn } from "@/lib/utils"
import { ChevronDown } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export type SearchTab = "files" | "search"
export type SearchType = "hybrid" | "fulltext" | "semantic"

interface SearchModeToggleProps {
  tab: SearchTab
  searchType: SearchType
  onTabChange: (tab: SearchTab) => void
  onSearchTypeChange: (type: SearchType) => void
}

const searchTypes: { value: SearchType; label: string; description: string }[] = [
  { value: "hybrid", label: "Hybrid", description: "Semantic + keyword" },
  { value: "fulltext", label: "Full-text", description: "FTS5 keyword matching" },
  { value: "semantic", label: "Semantic", description: "Vector embeddings" },
]

export function SearchModeToggle({ tab, searchType, onTabChange, onSearchTypeChange }: SearchModeToggleProps) {
  const activeType = searchTypes.find((t) => t.value === searchType)!

  return (
    <div className="space-y-1.5">
      <div className="flex rounded-md border border-border text-xs">
        {(["files", "search"] as const).map((t) => (
          <button
            key={t}
            onClick={() => onTabChange(t)}
            className={cn(
              "flex-1 px-2 py-1 transition-colors first:rounded-l-md last:rounded-r-md",
              tab === t
                ? "bg-primary text-primary-foreground"
                : "hover:bg-accent"
            )}
          >
            {t === "files" ? "Files" : "Search"}
          </button>
        ))}
      </div>

      {tab === "search" && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-full items-center justify-between rounded-md border border-border px-2 py-1 text-xs hover:bg-accent transition-colors">
              <span>
                <span className="font-medium">{activeType.label}</span>
                <span className="text-muted-foreground ml-1.5">{activeType.description}</span>
              </span>
              <ChevronDown className="size-3 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[--radix-dropdown-menu-trigger-width]">
            {searchTypes.map((t) => (
              <DropdownMenuItem
                key={t.value}
                onClick={() => onSearchTypeChange(t.value)}
                className={cn(
                  "text-xs",
                  searchType === t.value && "bg-accent"
                )}
              >
                <div>
                  <div className="font-medium">{t.label}</div>
                  <div className="text-muted-foreground">{t.description}</div>
                </div>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
