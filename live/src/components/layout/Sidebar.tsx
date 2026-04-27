import { FileTree } from "@/components/file-tree/FileTree"
import { SearchBar } from "@/components/search/SearchBar"

export function Sidebar({ children }: { children?: React.ReactNode }) {
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <SearchBar />
      {children}
      <div className="flex-1 overflow-y-auto">
        <FileTree />
      </div>
    </aside>
  )
}
