import { useState } from "react"
import { Menu, X, PanelLeftOpen } from "lucide-react"
import type { PanelSize } from "react-resizable-panels"
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Sidebar } from "./Sidebar"
import { TopBar } from "./TopBar"
import { PathBreadcrumb } from "@/components/PathBreadcrumb"
import { useResizableSidebar } from "@/hooks/use-resizable-sidebar"
import { cn } from "@/lib/utils"

interface ShellProps {
  sidebar?: React.ReactNode
  children: React.ReactNode
}

const TREE_KEY = "liveui:tree"
const TREE_DEFAULTS = { open: true, width: 256, min: 180, max: 480 }

export function Shell({ sidebar, children }: ShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const tree = useResizableSidebar(TREE_KEY, TREE_DEFAULTS)

  const handleLeftResize = (panelSize: PanelSize) => {
    tree.setWidth(Math.round(panelSize.inPixels))
  }

  // Initial panel size as a percentage of viewport. The persisted width
  // (clamped to [min, max]) is converted to a percentage relative to the
  // current viewport. v4 of react-resizable-panels respects Panel-level
  // `defaultSize` over Group-level `defaultLayout`.
  const vp = typeof window !== "undefined" ? window.innerWidth : 1400
  const leftDefaultSize = Math.min(35, Math.max(15, (tree.width / Math.max(vp, 1)) * 100))

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile slide-in sidebar */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-50 lg:hidden transition-transform duration-200 w-64",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="absolute right-2 top-2 z-10">
          <button
            onClick={() => setMobileOpen(false)}
            className="rounded-md p-1 hover:bg-sidebar-accent transition-colors"
            aria-label="Close sidebar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <Sidebar>{sidebar}</Sidebar>
      </div>

      {/* Desktop: resizable two-pane shell */}
      <div className="hidden lg:flex flex-1 min-w-0">
        <ResizablePanelGroup direction="horizontal">
          {tree.open ? (
            <>
              <ResizablePanel
                id="left"
                defaultSize={leftDefaultSize}
                minSize={15}
                maxSize={35}
                collapsible
                collapsedSize={0}
                onResize={handleLeftResize}
              >
                <Sidebar>{sidebar}</Sidebar>
              </ResizablePanel>
              <ResizableHandle />
            </>
          ) : (
            <SidebarCollapsedRail onOpen={() => tree.setOpen(true)} />
          )}
          <ResizablePanel id="main" minSize={50}>
            <div className="flex h-full flex-1 flex-col min-w-0">
              <TopBar />
              <PathBreadcrumb />
              <main className="flex-1 overflow-hidden">{children}</main>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {/* Mobile single-column */}
      <div className="lg:hidden flex flex-1 flex-col min-w-0">
        <TopBar
          leading={
            <button
              onClick={() => setMobileOpen(true)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent transition-colors"
              aria-label="Open sidebar"
            >
              <Menu className="h-4 w-4" />
            </button>
          }
        />
        <PathBreadcrumb />
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  )
}

function SidebarCollapsedRail({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex w-8 shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar py-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={onOpen}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
              aria-label="Open sidebar"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          }
        />
        <TooltipContent side="right">
          Open sidebar <kbd data-slot="kbd" className="ml-1 px-1 text-[10px]">[</kbd>
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

