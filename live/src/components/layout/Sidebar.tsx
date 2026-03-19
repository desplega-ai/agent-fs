import { AccountSwitcher } from "@/components/AccountSwitcher"
import { FileTree } from "@/components/file-tree/FileTree"
import { SearchBar } from "@/components/search/SearchBar"

export function Sidebar({ children }: { children?: React.ReactNode }) {
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex h-10 items-center border-b border-sidebar-border px-3">
        <AccountSwitcher />
      </div>
      <SearchBar />
      {children}
      <div className="flex-1 overflow-y-auto">
        <FileTree />
      </div>
    </aside>
  )
}
