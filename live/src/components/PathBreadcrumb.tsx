import { ChevronRight } from "lucide-react"
import { useBrowser } from "@/contexts/browser"
import { Button } from "@/components/ui/button"

export function PathBreadcrumb() {
  const { selectedFile, navigateToFolder } = useBrowser()

  // Strip leading/trailing slashes so the splat-style splat from
  // RouteParamsSync (which can include trailing `/` for folders) parses cleanly.
  const path = (selectedFile ?? "").replace(/^\/+|\/+$/g, "")
  const segments = path ? path.split("/") : []

  // Always render a leading "/" that takes the user back to the drive root.
  // It's a real button regardless of whether segments are present, so users
  // always have an obvious way back.
  return (
    <nav className="flex h-8 items-center gap-0.5 border-b border-border px-4 text-sm text-muted-foreground min-w-0" aria-label="Path">
      <Button
        variant="ghost"
        size="xs"
        onClick={() => navigateToFolder("")}
        aria-label="Drive root"
        className="px-1 text-muted-foreground hover:text-foreground"
      >
        /
      </Button>
      {segments.map((segment, i) => {
        const isLast = i === segments.length - 1
        const segPath = segments.slice(0, i + 1).join("/")
        return (
          <span key={segPath} className="flex items-center gap-0.5 min-w-0">
            <ChevronRight className="size-3 shrink-0" />
            {isLast ? (
              <span className="text-foreground font-medium truncate">{segment}</span>
            ) : (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => navigateToFolder(segPath)}
                className="truncate"
              >
                {segment}
              </Button>
            )}
          </span>
        )
      })}
    </nav>
  )
}
