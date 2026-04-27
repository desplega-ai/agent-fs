import { useSyncExternalStore } from "react"
import { LayoutGrid, List } from "lucide-react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

export type FolderViewMode = "list" | "grid"

const VIEW_KEY = "liveui:browser:view"

function readPersisted(): FolderViewMode {
  try {
    if (typeof localStorage === "undefined") return "list"
    const raw = localStorage.getItem(VIEW_KEY)
    if (raw === null) return "list"
    const parsed = JSON.parse(raw)
    return parsed === "grid" ? "grid" : "list"
  } catch {
    return "list"
  }
}

let currentMode: FolderViewMode = readPersisted()
const listeners = new Set<() => void>()

function setMode(next: FolderViewMode) {
  if (next === currentMode) return
  currentMode = next
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(next))
  } catch {
    // ignore quota / privacy errors
  }
  listeners.forEach((l) => l())
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

function getSnapshot(): FolderViewMode {
  return currentMode
}

/**
 * Singleton folder-view mode hook backed by useSyncExternalStore. All
 * consumers (ViewModeToggle + FolderView) share the same state, so toggling
 * in one place updates everywhere immediately.
 */
export function useFolderViewMode(): [FolderViewMode, (m: FolderViewMode) => void] {
  const mode = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return [mode, setMode]
}

export function ViewModeToggle() {
  const [mode, setModeFn] = useFolderViewMode()

  return (
    <ToggleGroup
      value={[mode]}
      onValueChange={(values) => {
        const next = values[0] as FolderViewMode | undefined
        if (next === "list" || next === "grid") {
          setModeFn(next)
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
