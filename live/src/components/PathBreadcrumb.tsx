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

export function PathBreadcrumb() {
  const { selectedFile, navigateToFolder } = useBrowser()

  const path = (selectedFile ?? "").replace(/^\/+|\/+$/g, "")
  const segments = path ? path.split("/") : []

  // When the path has more than one segment, collapse everything except the
  // last one behind a `...` dropdown. Keeps the row compact and predictable
  // even with long UUID / dated segments; the dropdown gives full ancestor
  // access in one click.
  const last = segments.length > 0 ? segments[segments.length - 1]! : null
  const ancestors = segments.slice(0, -1)
  const showCollapse = ancestors.length > 0

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

      {showCollapse && (
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
                        aria-label="Show ancestor folders"
                      >
                        <MoreHorizontal />
                      </Button>
                    }
                  />
                }
              />
              <TooltipContent side="bottom">
                {ancestors.join(" / ")}
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start">
              {ancestors.map((segment, i) => {
                const segPath = ancestors.slice(0, i + 1).join("/")
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

      {last !== null && <CurrentSegment segment={last} />}
    </nav>
  )
}

function CurrentSegment({ segment }: { segment: string }) {
  return (
    <span className="flex min-w-0 items-center gap-0.5">
      <ChevronRight className="size-3 shrink-0" />
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className="block min-w-0 truncate font-medium text-foreground"
              title={segment}
            >
              {segment}
            </span>
          }
        />
        <TooltipContent side="bottom">{segment}</TooltipContent>
      </Tooltip>
    </span>
  )
}
