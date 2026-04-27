import { cn } from "@/lib/utils"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

export type SearchTab = "files" | "search"
export type SearchType = "hybrid" | "fulltext" | "semantic"

interface SearchModeToggleProps {
  tab: SearchTab
  onTabChange: (tab: SearchTab) => void
  onClose: () => void
}

export function SearchModeToggle({ tab, onTabChange, onClose }: SearchModeToggleProps) {
  return (
    <div className="flex items-center gap-1">
      <div className="flex flex-1 rounded-md border border-border text-xs">
        {(["files", "search"] as const).map((t) => (
          <button
            key={t}
            onClick={() => onTabChange(t)}
            className={cn(
              "flex-1 px-2 py-1 transition-colors first:rounded-l-md last:rounded-r-md",
              tab === t
                ? "bg-primary text-primary-foreground"
                : "hover:bg-accent",
            )}
          >
            {t === "files" ? "Files" : "Search"}
          </button>
        ))}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onClose}
              className="text-muted-foreground"
              aria-label="Exit search"
            >
              <X />
            </Button>
          }
        />
        <TooltipContent side="bottom">Exit search</TooltipContent>
      </Tooltip>
    </div>
  )
}
