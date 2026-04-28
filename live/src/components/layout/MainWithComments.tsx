import { useEffect, useRef, useState, type ReactNode } from "react"
import { MessageSquare, PanelRightOpen } from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { CommentSidebar } from "@/components/comments/CommentSidebar"
import { useComments } from "@/hooks/use-comments"
import { useResizableSidebar } from "@/hooks/use-resizable-sidebar"
import { uiChromeStore } from "@/stores/ui-chrome"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface MainWithCommentsProps {
  /** Path of the currently selected file. When null, the comments rail is hidden. */
  filePath: string | null
  /** Optional callback fired when a comment is clicked (line/quote). */
  onCommentClick?: (lineStart?: number, lineEnd?: number, quotedContent?: string) => void
  /** Whether the comment sidebar should render its own header. */
  showCommentsHeader?: boolean
  /** Main content (typically a file viewer or empty state). */
  children: ReactNode
}

const COMMENTS_KEY = "liveui:comments"
const COMMENTS_DEFAULTS = { open: true, width: 360, min: 240, max: 600 }

/**
 * Shared layout for pages that show a main area + a right-side comments rail.
 * Wraps the right rail in a `ResizablePanelGroup` so it's resize/collapsible.
 * On mobile (<lg) the rail is replaced by a slide-in overlay toggled via a
 * floating button.
 */
export function MainWithComments({
  filePath,
  onCommentClick,
  showCommentsHeader = true,
  children,
}: MainWithCommentsProps) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const comments = useResizableSidebar(COMMENTS_KEY, COMMENTS_DEFAULTS)

  // Register the right (comments) sidebar toggle so the global `]` shortcut
  // can flip it. Only meaningful when a file is selected (rail is rendered).
  useEffect(() => {
    if (!filePath) return
    uiChromeStore.registerRightToggle(() => comments.toggle())
    return () => uiChromeStore.registerRightToggle(null)
  }, [filePath, comments])

  // No file selected — just render children full-width, no rail.
  if (!filePath) {
    return <div className="h-full">{children}</div>
  }

  return (
    <div className="flex h-full">
      {/* Desktop: fixed-px comments rail + flex-1 main, dragged via custom
          handle. Drops the ResizablePanelGroup which produced unreliable
          widths on wide viewports. */}
      <div className="hidden lg:flex flex-1 min-w-0">
        <div className="flex-1 min-w-0 overflow-hidden">{children}</div>
        {comments.open ? (
          <>
            <CommentsDragHandle
              onDrag={(dx) => comments.setWidth(comments.width - dx)}
              onCollapse={() => comments.setOpen(false)}
            />
            <aside
              className="shrink-0 h-full border-l border-border"
              style={{ width: `${comments.width}px` }}
            >
              <CommentSidebar
                path={filePath}
                showHeader={showCommentsHeader}
                onCommentClick={onCommentClick}
                onCollapse={() => comments.setOpen(false)}
              />
            </aside>
          </>
        ) : (
          <CommentsCollapsedRail onOpen={() => comments.setOpen(true)} />
        )}
      </div>

      {/* Mobile / tablet: full-width content + floating toggle + Sheet drawer */}
      <div className="lg:hidden flex flex-1 min-w-0">
        <div className="flex-1 min-w-0">{children}</div>
        <MobileCommentToggle
          path={filePath}
          open={mobileOpen}
          onToggle={() => setMobileOpen((v) => !v)}
          onOpenChange={setMobileOpen}
          onCommentClick={onCommentClick}
        />
      </div>
    </div>
  )
}

/**
 * 1px column-resize handle for the comments rail. Drag left increases the
 * rail width; drag right decreases it. Double-click collapses.
 */
function CommentsDragHandle({
  onDrag,
  onCollapse,
}: {
  onDrag: (delta: number) => void
  onCollapse: () => void
}) {
  const lastRef = useRef<number | null>(null)

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        e.preventDefault()
        ;(e.target as Element).setPointerCapture?.(e.pointerId)
        lastRef.current = e.clientX
      }}
      onPointerMove={(e) => {
        if (lastRef.current == null) return
        const dx = e.clientX - lastRef.current
        if (dx !== 0) {
          onDrag(dx)
          lastRef.current = e.clientX
        }
      }}
      onPointerUp={(e) => {
        ;(e.target as Element).releasePointerCapture?.(e.pointerId)
        lastRef.current = null
      }}
      onPointerCancel={(e) => {
        ;(e.target as Element).releasePointerCapture?.(e.pointerId)
        lastRef.current = null
      }}
      onDoubleClick={onCollapse}
      className={cn(
        "relative shrink-0 w-px cursor-col-resize bg-border transition-colors",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2",
        "hover:bg-primary/40 active:bg-primary/60",
      )}
    />
  )
}

function CommentsCollapsedRail({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex w-8 shrink-0 flex-col items-center border-l border-border bg-sidebar/30 py-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={onOpen}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              aria-label="Open comments"
            >
              <PanelRightOpen className="h-4 w-4" />
            </button>
          }
        />
        <TooltipContent>
          Open comments <kbd data-slot="kbd" className="ml-1 px-1 text-[10px]">]</kbd>
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

function MobileCommentToggle({
  path,
  open,
  onToggle,
  onOpenChange,
  onCommentClick,
}: {
  path: string
  open: boolean
  onToggle: () => void
  onOpenChange: (open: boolean) => void
  onCommentClick?: (lineStart?: number, lineEnd?: number, quotedContent?: string) => void
}) {
  const { data: commentsData } = useComments(path)
  const commentCount = commentsData?.comments.length ?? 0

  return (
    <>
      <div className="lg:hidden fixed bottom-4 right-4 z-30">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon"
                variant="outline"
                onClick={onToggle}
                className={cn(
                  "rounded-full shadow-lg",
                  // Touch target ≥ 44×44 px on mobile
                  "min-h-[44px] min-w-[44px]"
                )}
                aria-label="Toggle comments"
              >
                <MessageSquare className="size-4" />
                {commentCount > 0 && (
                  <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">
                    {commentCount}
                  </span>
                )}
              </Button>
            }
          />
          <TooltipContent side="left">Toggle comments</TooltipContent>
        </Tooltip>
      </div>

      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="lg:hidden p-0 bg-background flex flex-col"
        >
          <SheetHeader>
            <SheetTitle>
              Comments
              {commentCount > 0 && (
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  ({commentCount})
                </span>
              )}
            </SheetTitle>
          </SheetHeader>
          <div className="flex-1 min-h-0 overflow-hidden">
            <CommentSidebar
              path={path}
              showHeader={false}
              onCommentClick={onCommentClick}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
