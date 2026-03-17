import { useState } from "react"
import { Menu, X } from "lucide-react"
import { Sidebar } from "./Sidebar"
import { Header } from "./Header"
import { cn } from "@/lib/utils"

interface ShellProps {
  sidebar?: React.ReactNode
  breadcrumbs?: React.ReactNode
  children: React.ReactNode
}

export function Shell({ sidebar, breadcrumbs, children }: ShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar — always visible on lg+, slide-in on mobile */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-50 md:relative md:z-auto transition-transform duration-200",
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        )}
      >
        <div className="md:hidden absolute right-2 top-2 z-10">
          <button
            onClick={() => setSidebarOpen(false)}
            className="rounded-md p-1 hover:bg-sidebar-accent transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <Sidebar>{sidebar}</Sidebar>
      </div>

      <div className="flex flex-1 flex-col min-w-0">
        <Header>
          <button
            onClick={() => setSidebarOpen(true)}
            className="md:hidden rounded-md p-1.5 text-muted-foreground hover:bg-accent transition-colors mr-2"
          >
            <Menu className="h-4 w-4" />
          </button>
          {breadcrumbs}
        </Header>
        <main className="flex-1 overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  )
}
