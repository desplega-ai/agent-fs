import { useEffect, type ReactNode } from "react"
import { PanelRightClose } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { CommentSidebar } from "@/components/comments/CommentSidebar"
import { Outline } from "@/components/outline/Outline"
import { useAllComments } from "@/hooks/use-comments"
import { sidePanelStore, useSidePanelTab } from "@/stores/side-panel"
import type { OutlineItem } from "@/lib/outline"

interface SidePanelProps {
  path: string
  outline: OutlineItem[]
  showCommentsHeader?: boolean
  onCommentClick?: (lineStart?: number, lineEnd?: number, quotedContent?: string) => void
  /** Renders a collapse button in the header. */
  onCollapse?: () => void
}

/**
 * Right-rail container for the file detail/browser views. When the document
 * has an outline (markdown with headings) it becomes a tabbed panel —
 * Comments | Outline. Otherwise it falls back to the plain comments sidebar so
 * non-markdown files are unchanged.
 */
export function SidePanel({
  path,
  outline,
  showCommentsHeader = true,
  onCommentClick,
  onCollapse,
}: SidePanelProps) {
  const hasOutline = outline.length > 0
  const tab = useSidePanelTab()

  // If the outline disappears (file with no headings, or switched to source
  // view) while the Outline tab is active, fall back to Comments.
  useEffect(() => {
    if (!hasOutline) sidePanelStore.setTab("comments")
  }, [hasOutline])

  if (!hasOutline) {
    return (
      <CommentSidebar
        path={path}
        showHeader={showCommentsHeader}
        onCommentClick={onCommentClick}
        onCollapse={onCollapse}
      />
    )
  }

  return (
    <div className="flex h-full flex-col min-w-0">
      <div className="flex h-10 items-center justify-between border-b border-border pl-1.5 pr-2 shrink-0">
        <div className="flex items-center gap-0.5">
          <TabButton active={tab === "comments"} onClick={() => sidePanelStore.setTab("comments")}>
            <CommentsTabLabel path={path} />
            <Kbd>C</Kbd>
          </TabButton>
          <TabButton active={tab === "outline"} onClick={() => sidePanelStore.setTab("outline")}>
            Outline
            <Kbd>O</Kbd>
          </TabButton>
        </div>
        {onCollapse && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={onCollapse}
                  className="text-muted-foreground"
                  aria-label="Collapse panel"
                >
                  <PanelRightClose />
                </Button>
              }
            />
            <TooltipContent>
              Collapse <Kbd className="ml-1">]</Kbd>
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className="flex-1 min-h-0">
        {tab === "comments" ? (
          <CommentSidebar path={path} showHeader={false} onCommentClick={onCommentClick} />
        ) : (
          <Outline items={outline} className="h-full" />
        )}
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium transition-colors",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-accent/60",
      )}
    >
      {children}
    </button>
  )
}

function CommentsTabLabel({ path }: { path: string }) {
  const { unresolvedComments } = useAllComments(path)
  return (
    <>
      Comments
      {unresolvedComments.length > 0 && (
        <span className="ml-1 text-xs text-muted-foreground">{unresolvedComments.length}</span>
      )}
    </>
  )
}
