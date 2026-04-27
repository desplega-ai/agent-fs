import { ChevronRight, MoreHorizontal } from "lucide-react"
import { useBrowser } from "@/contexts/browser"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** Number of trailing segments to keep inline when the path is long. */
const TAIL_VISIBLE = 2

export function PathBreadcrumb() {
  const { selectedFile, navigateToFolder } = useBrowser()

  const path = (selectedFile ?? "").replace(/^\/+|\/+$/g, "")
  const segments = path ? path.split("/") : []

  // When the path has more than `TAIL_VISIBLE + 1` segments we hide the
  // middle ones behind a `...` dropdown that lets the user jump back to any
  // ancestor. Always keep the very first segment visible plus the last
  // `TAIL_VISIBLE` so the user has both anchors.
  const collapse = segments.length > TAIL_VISIBLE + 1
  const head = collapse ? segments.slice(0, 1) : segments
  const middle = collapse ? segments.slice(1, segments.length - TAIL_VISIBLE) : []
  const tail = collapse ? segments.slice(segments.length - TAIL_VISIBLE) : []

  return (
    <nav
      className="flex h-8 items-center gap-0.5 overflow-hidden border-b border-border px-4 text-sm text-muted-foreground"
      aria-label="Path"
    >
      <Button
        variant="ghost"
        size="xs"
        onClick={() => navigateToFolder("")}
        aria-label="Drive root"
        className="shrink-0 px-1 text-muted-foreground hover:text-foreground"
      >
        /
      </Button>

      {head.map((segment, i) => {
        const segPath = head.slice(0, i + 1).join("/")
        const isOnlyVisibleAndLast = !collapse && segments.length === 1
        return (
          <SegmentItem
            key={segPath}
            segment={segment}
            onClick={isOnlyVisibleAndLast ? undefined : () => navigateToFolder(segPath)}
            isLast={isOnlyVisibleAndLast}
          />
        )
      })}

      {collapse && (
        <>
          <ChevronRight className="size-3 shrink-0" />
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="shrink-0 text-muted-foreground"
                        aria-label="Show hidden path segments"
                      >
                        <MoreHorizontal />
                      </Button>
                    }
                  />
                }
              />
              <TooltipContent side="bottom">
                {middle.join(" / ")}
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start">
              {middle.map((segment, i) => {
                const segPath = segments.slice(0, head.length + i + 1).join("/")
                return (
                  <DropdownMenuItem
                    key={segPath}
                    onClick={() => navigateToFolder(segPath)}
                  >
                    <span className="truncate">{segment}</span>
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

      {tail.map((segment, i) => {
        const isLast = i === tail.length - 1
        const segPath = segments.slice(0, head.length + middle.length + i + 1).join("/")
        return (
          <SegmentItem
            key={segPath}
            segment={segment}
            onClick={isLast ? undefined : () => navigateToFolder(segPath)}
            isLast={isLast}
          />
        )
      })}
    </nav>
  )
}

function SegmentItem({
  segment,
  isLast,
  onClick,
}: {
  segment: string
  isLast: boolean
  onClick?: () => void
}) {
  return (
    <span className="flex min-w-0 items-center gap-0.5">
      <ChevronRight className="size-3 shrink-0" />
      {isLast ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className="block min-w-0 max-w-[16rem] truncate font-medium text-foreground"
                title={segment}
              >
                {segment}
              </span>
            }
          />
          <TooltipContent side="bottom">{segment}</TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                onClick={onClick}
                className="block min-w-0 max-w-[10rem] truncate"
              >
                {segment}
              </Button>
            }
          />
          <TooltipContent side="bottom">{segment}</TooltipContent>
        </Tooltip>
      )}
    </span>
  )
}
