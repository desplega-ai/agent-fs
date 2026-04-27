import { ChevronRight } from "lucide-react"
import { useBrowser } from "@/contexts/browser"
import { Button } from "@/components/ui/button"

export function PathBreadcrumb() {
  const { selectedFile, navigateToFolder } = useBrowser()

  const path = selectedFile || ""
  const segments = path ? path.split("/") : []

  if (segments.length === 0) {
    return (
      <nav className="flex h-8 items-center gap-0.5 border-b border-border px-4 text-sm text-muted-foreground min-w-0" aria-label="Path">
        <span className="text-[12px] text-muted-foreground/60">/</span>
      </nav>
    )
  }

  return (
    <nav className="flex h-8 items-center gap-0.5 border-b border-border px-4 text-sm text-muted-foreground min-w-0" aria-label="Path">
      {segments.map((segment, i) => {
        const isLast = i === segments.length - 1
        const segPath = segments.slice(0, i + 1).join("/")
        return (
          <span key={segPath} className="flex items-center gap-0.5 min-w-0">
            {i > 0 && <ChevronRight className="size-3 shrink-0" />}
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
