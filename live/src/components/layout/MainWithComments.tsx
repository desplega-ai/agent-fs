import { useState, type ReactNode } from "react"
import { MessageSquare, X, PanelRightOpen } from "lucide-react"
import type { Layout, PanelSize } from "react-resizable-panels"
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
import { CommentSidebar } from "@/components/comments/CommentSidebar"
import { useComments } from "@/hooks/use-comments"
import { useResizableSidebar } from "@/hooks/use-resizable-sidebar"
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
const COMMENTS_DEFAULTS = { open: true, width: 320, min: 200, max: 600 }

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

  const handleResize = (panelSize: PanelSize) => {
    comments.setWidth(Math.round(panelSize.inPixels))
  }

  const initialLayout: Layout | undefined = (() => {
    if (!filePath) return undefined
    const vp = typeof window !== "undefined" ? window.innerWidth : 1280
    const pct = Math.min(50, Math.max(15, (comments.width / Math.max(vp, 1)) * 100))
    return { main: 100 - pct, comments: pct }
  })()

  // No file selected — just render children full-width, no rail.
  if (!filePath) {
    return <div className="h-full">{children}</div>
  }

  return (
    <div className="flex h-full">
      {/* Desktop: resizable panel group */}
      <div className="hidden lg:flex flex-1 min-w-0">
        <ResizablePanelGroup direction="horizontal" defaultLayout={initialLayout}>
          <ResizablePanel id="main" minSize={30}>
            <div className="h-full min-w-0">{children}</div>
          </ResizablePanel>
          {comments.open ? (
            <>
              <ResizableHandle />
              <ResizablePanel
                id="comments"
                minSize={15}
                maxSize={60}
                collapsible
                collapsedSize={0}
                onResize={handleResize}
              >
                <div className="h-full border-l border-border">
                  <CommentSidebar
                    path={filePath}
                    showHeader={showCommentsHeader}
                    onCommentClick={onCommentClick}
                  />
                </div>
              </ResizablePanel>
            </>
          ) : (
            <CommentsCollapsedRail onOpen={() => comments.setOpen(true)} />
          )}
        </ResizablePanelGroup>
      </div>

      {/* Mobile / tablet: full-width content + floating toggle + drawer */}
      <div className="lg:hidden flex flex-1 min-w-0">
        <div className="flex-1 min-w-0">{children}</div>
        <MobileCommentToggle
          path={filePath}
          open={mobileOpen}
          onToggle={() => setMobileOpen((v) => !v)}
          onClose={() => setMobileOpen(false)}
          onCommentClick={onCommentClick}
        />
      </div>
    </div>
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
  onClose,
  onCommentClick,
}: {
  path: string
  open: boolean
  onToggle: () => void
  onClose: () => void
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
                className={cn("rounded-full shadow-lg size-10")}
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

      {open && (
        <>
          <div className="lg:hidden fixed inset-0 z-40 bg-black/50" onClick={onClose} />
          <div className="lg:hidden fixed inset-y-0 right-0 z-50 w-80 max-w-[85vw] bg-background border-l border-border flex flex-col shadow-xl">
            <div className="flex h-10 items-center justify-between border-b border-border px-3">
              <span className="text-sm font-medium">
                Comments
                {commentCount > 0 && (
                  <span className="ml-1.5 text-xs text-muted-foreground">({commentCount})</span>
                )}
              </span>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close comments">
                      <X />
                    </Button>
                  }
                />
                <TooltipContent>Close comments</TooltipContent>
              </Tooltip>
            </div>
            <CommentSidebar path={path} showHeader={false} onCommentClick={onCommentClick} />
          </div>
        </>
      )}
    </>
  )
}
