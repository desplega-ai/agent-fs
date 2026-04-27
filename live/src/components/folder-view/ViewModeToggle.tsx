import { LayoutGrid, List } from "lucide-react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useLocalStorage } from "@/hooks/use-local-storage"

export type FolderViewMode = "list" | "grid"

const VIEW_KEY = "liveui:browser:view"

/**
 * Read/write hook for the persisted folder-view mode. Used by both the toggle
 * and the parent FolderView so they stay in sync without prop drilling.
 */
export function useFolderViewMode(): [FolderViewMode, (m: FolderViewMode) => void] {
  return useLocalStorage<FolderViewMode>(VIEW_KEY, "list")
}

export function ViewModeToggle() {
  const [mode, setMode] = useFolderViewMode()

  return (
    <ToggleGroup
      value={[mode]}
      onValueChange={(values) => {
        const next = values[0] as FolderViewMode | undefined
        if (next === "list" || next === "grid") {
          setMode(next)
        }
      }}
      aria-label="Folder view mode"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ToggleGroupItem value="list" aria-label="List view">
              <List />
            </ToggleGroupItem>
          }
        />
        <TooltipContent side="bottom">List view</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <ToggleGroupItem value="grid" aria-label="Grid view">
              <LayoutGrid />
            </ToggleGroupItem>
          }
        />
        <TooltipContent side="bottom">Grid view</TooltipContent>
      </Tooltip>
    </ToggleGroup>
  )
}
