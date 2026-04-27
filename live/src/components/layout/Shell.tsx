import { useEffect, useRef, useState } from "react"
import { Menu, PanelLeftOpen } from "lucide-react"
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
import { cn } from "@/lib/utils"

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

      {/* Desktop: fixed-px sidebar + flex-1 main. Drop ResizablePanelGroup
          for the outer shell — v4's percentage layout was producing tiny
          sidebars on wide viewports. The sidebar uses an explicit pixel
          width (persisted to liveui:tree) and is dragged via a custom
          handle below. */}
      <div className="hidden lg:flex flex-1 min-w-0">
        {tree.open ? (
          <>
            <aside
              className="shrink-0 h-full"
              style={{ width: `${tree.width}px` }}
            >
              <Sidebar>{sidebar}</Sidebar>
            </aside>
            <DragHandle
              orientation="vertical"
              onDrag={(dx) => tree.setWidth(tree.width + dx)}
              onCollapse={() => tree.setOpen(false)}
            />
          </>
        ) : (
          <SidebarCollapsedRail onOpen={() => tree.setOpen(true)} />
        )}
        <div className="flex flex-1 flex-col min-w-0">
          <TopBar />
          <PathBreadcrumb />
          <main className="flex-1 overflow-hidden">{children}</main>
        </div>
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

/**
 * A 1px draggable handle with a wider invisible hit area. `onDrag(dx)` is
 * called with the cumulative delta from drag start each pointer move; the
 * caller decides what to do with it. Vertical orientation = drags horizontally
 * (used between left sidebar and main).
 */
function DragHandle({
  orientation = "vertical",
  onDrag,
  onCollapse,
  className,
}: {
  orientation?: "vertical" | "horizontal"
  onDrag: (delta: number) => void
  onCollapse?: () => void
  className?: string
}) {
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const lastRef = useRef<{ x: number; y: number } | null>(null)

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    startRef.current = { x: e.clientX, y: e.clientY }
    lastRef.current = { x: e.clientX, y: e.clientY }
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!startRef.current || !lastRef.current) return
    const dx = orientation === "vertical" ? e.clientX - lastRef.current.x : e.clientY - lastRef.current.y
    if (dx !== 0) {
      onDrag(dx)
      lastRef.current = { x: e.clientX, y: e.clientY }
    }
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    ;(e.target as Element).releasePointerCapture?.(e.pointerId)
    startRef.current = null
    lastRef.current = null
  }

  const handleDoubleClick = () => {
    onCollapse?.()
  }

  return (
    <div
      role="separator"
      aria-orientation={orientation === "vertical" ? "vertical" : "horizontal"}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={handleDoubleClick}
      className={cn(
        "relative shrink-0 bg-border transition-colors",
        orientation === "vertical"
          ? "w-px cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2"
          : "h-px cursor-row-resize after:absolute after:inset-x-0 after:top-1/2 after:h-2 after:-translate-y-1/2",
        "hover:bg-primary/40 active:bg-primary/60",
        className,
      )}
    />
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
