import { useEffect, useState } from "react"
import { Menu, PanelLeftOpen } from "lucide-react"
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
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { Sidebar } from "./Sidebar"
import { TopBar } from "./TopBar"
import { PathBreadcrumb } from "@/components/PathBreadcrumb"
import { HelpOverlay } from "@/components/HelpOverlay"
import { useResizableSidebar } from "@/hooks/use-resizable-sidebar"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { SearchInputProvider, useSearchInput } from "@/contexts/search-input"
import { uiChromeStore, useHelpOpen, useSetHelpOpen } from "@/stores/ui-chrome"
import { useBrowser } from "@/contexts/browser"

interface ShellProps {
  sidebar?: React.ReactNode
  children: React.ReactNode
}

const TREE_KEY = "liveui:tree"
const TREE_DEFAULTS = { open: true, width: 288, min: 220, max: 480 }

export function Shell({ sidebar, children }: ShellProps) {
  return (
    <SearchInputProvider>
      <ShellInner sidebar={sidebar}>{children}</ShellInner>
    </SearchInputProvider>
  )
}

function ShellInner({ sidebar, children }: ShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const tree = useResizableSidebar(TREE_KEY, TREE_DEFAULTS)
  const helpOpen = useHelpOpen()
  const setHelpOpen = useSetHelpOpen()
  const { focus: focusSearch } = useSearchInput()
  const { selectFile } = useBrowser()

  // Register the left-sidebar toggle into the UI chrome store so the shortcut
  // hook (mounted here) and any other component can flip it.
  useEffect(() => {
    uiChromeStore.registerLeftToggle(() => tree.toggle())
    return () => uiChromeStore.registerLeftToggle(null)
  }, [tree])

  // Global keyboard shortcuts. The right sidebar toggle is registered by
  // MainWithComments and may be unset in routes without a comments rail.
  useKeyboardShortcuts({
    "cmd+k": (e) => {
      e.preventDefault()
      focusSearch()
    },
    "/": (e) => {
      // `/` should only steal focus when not typing — the hook already skips
      // editable targets, but guard against an existing focused input.
      e.preventDefault()
      focusSearch()
    },
    esc: () => {
      // If the help overlay is open, base-ui Dialog handles esc itself.
      // Skip here to avoid also clearing the file selection.
      if (helpOpen) return
      selectFile(null)
    },
    "[": (e) => {
      e.preventDefault()
      uiChromeStore.toggleLeft()
    },
    "]": (e) => {
      e.preventDefault()
      uiChromeStore.toggleRight()
    },
    "?": (e) => {
      e.preventDefault()
      setHelpOpen(true)
    },
  })

  const handleLeftResize = (panelSize: PanelSize) => {
    tree.setWidth(Math.round(panelSize.inPixels))
  }

  // Initial panel size as a percentage of viewport. The persisted width
  // (clamped to [min, max]) is converted to a percentage relative to the
  // current viewport. v4 of react-resizable-panels respects Panel-level
  // `defaultSize` over Group-level `defaultLayout`.
  const vp = typeof window !== "undefined" ? window.innerWidth : 1400
  const leftDefaultSize = Math.min(35, Math.max(18, (tree.width / Math.max(vp, 1)) * 100))

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Mobile drawer (left): base-ui Dialog under Sheet primitive. */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          className="lg:hidden p-0 bg-sidebar"
          aria-label="Sidebar"
          showCloseButton={false}
        >
          <Sidebar>{sidebar}</Sidebar>
        </SheetContent>
      </Sheet>

      {/* Desktop: resizable two-pane shell */}
      <div className="hidden lg:flex flex-1 min-w-0">
        <ResizablePanelGroup direction="horizontal">
          {tree.open ? (
            <>
              <ResizablePanel
                id="left"
                defaultSize={leftDefaultSize}
                minSize={18}
                maxSize={35}
                collapsible
                collapsedSize={0}
                onResize={handleLeftResize}
              >
                <Sidebar>{sidebar}</Sidebar>
              </ResizablePanel>
              <ResizableHandle className="hidden lg:flex" />
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
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    onClick={() => setMobileOpen(true)}
                    className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-md text-muted-foreground hover:bg-accent transition-colors"
                    aria-label="Open sidebar"
                  >
                    <Menu className="h-4 w-4" />
                  </button>
                }
              />
              <TooltipContent side="bottom">Open sidebar</TooltipContent>
            </Tooltip>
          }
        />
        <PathBreadcrumb />
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>

      <HelpOverlay open={helpOpen} onOpenChange={setHelpOpen} />
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
