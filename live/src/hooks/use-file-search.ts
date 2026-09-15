import { useSyncExternalStore } from "react"
import { fileSearchStore, type FileSearchState } from "@/stores/file-search"

export function useFileSearch(): FileSearchState {
  return useSyncExternalStore(
    fileSearchStore.subscribe,
    fileSearchStore.getSnapshot,
    fileSearchStore.getSnapshot,
  )
}
