import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronDown, History } from "lucide-react"
import { isUnknownOperationError } from "@/api/errors"
import { useAuth } from "@/contexts/auth"
import { useBrowser } from "@/contexts/browser"
import { useLocalStorage } from "@/hooks/use-local-storage"
import { cn } from "@/lib/utils"
import { glyphFor } from "@/lib/file-glyphs"
import { MiddleEllipsis } from "@/lib/middle-ellipsis"
import type { RecentEntry, RecentResult } from "@/api/types"

const MAX_VISIBLE = 8

interface RecentFile extends RecentEntry {
  path: string
}

/** A compact, drive-wide activity list for the drive root. */
export function RecentActivity() {
  const { client, orgId, driveId } = useAuth()
  const { selectFile } = useBrowser()
  const [collapsed, setCollapsed] = useLocalStorage(
    "liveui:recent-activity:collapsed",
    false,
  )

  const { data, isLoading, isError } = useQuery({
    queryKey: ["recent", orgId, driveId],
    queryFn: () =>
      client.callOp<RecentResult>(orgId!, "recent", { limit: 50 }, driveId),
    enabled: !!orgId && !!driveId,
    retry: false,
    refetchInterval: (query) =>
      isUnknownOperationError(query.state.error, "recent") ? false : 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  })

  const files = useMemo(() => newestCurrentFiles(data?.entries ?? []), [data])

  // This section is optional enhancement. Older servers may not expose the
  // recent op, so a failure must never displace the ordinary folder listing.
  if (isError) return null

  if (isLoading) {
    return (
      <section
        aria-label="Recently changed"
        className="mb-2 border-b border-border/70 pb-3"
      >
        <SectionHeading
          collapsed={collapsed}
          onToggle={() => setCollapsed(!collapsed)}
        />
        {!collapsed && (
          <div className="mx-3 mt-2 h-px overflow-hidden bg-border">
            <div className="h-full w-1/3 animate-pulse bg-muted-foreground/40" />
          </div>
        )}
      </section>
    )
  }

  if (files.length === 0) return null

  return (
    <section
      aria-labelledby="recently-changed-heading"
      className="mb-2 border-b border-border/70 pb-2"
    >
      <SectionHeading
        id="recently-changed-heading"
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
      />
      {!collapsed && (
        <div className="flex flex-col">
          {files.map((entry) => {
            const glyph = glyphFor(entry.path)
            const label = entry.version === 1 ? "Created" : "Updated"

            return (
              <button
                key={entry.path}
                type="button"
                onClick={() => selectFile(entry.path)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-left text-sm",
                  "hover:bg-muted transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
                )}
              >
                <glyph.Icon className={cn("size-4 shrink-0", glyph.className)} />
                <span className="min-w-0 flex-1">
                  <MiddleEllipsis text={entry.path} />
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {label} · {formatRelativeTime(entry.createdAt)}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}

function SectionHeading({
  id,
  collapsed,
  onToggle,
}: {
  id?: string
  collapsed: boolean
  onToggle: () => void
}) {
  return (
    <h2 id={id}>
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 rounded-md px-3 py-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1"
      >
        <ChevronDown
          className={cn(
            "size-3.5 transition-transform motion-reduce:transition-none",
            collapsed && "-rotate-90",
          )}
        />
        <History className="size-3.5" />
        <span>Recently changed</span>
      </button>
    </h2>
  )
}

function newestCurrentFiles(entries: RecentEntry[]): RecentFile[] {
  const seen = new Set<string>()
  const files: RecentFile[] = []

  for (const entry of entries) {
    const path = entry.path.replace(/^\/+|\/+$/g, "")
    if (!path || seen.has(path)) continue

    // Mark the newest event as consumed before filtering deletes. Otherwise an
    // older write for a now-deleted file could surface later in the response.
    seen.add(path)
    if (entry.operation === "delete") continue

    files.push({ ...entry, path })
    if (files.length === MAX_VISIBLE) break
  }

  return files
}

function formatRelativeTime(iso: string): string {
  const timestamp = new Date(iso).getTime()
  if (!Number.isFinite(timestamp)) return "recently"

  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - timestamp) / 1_000),
  )
  if (elapsedSeconds < 60) return "now"
  if (elapsedSeconds < 3_600) return `${Math.floor(elapsedSeconds / 60)}m ago`
  if (elapsedSeconds < 86_400) return `${Math.floor(elapsedSeconds / 3_600)}h ago`
  if (elapsedSeconds < 604_800) return `${Math.floor(elapsedSeconds / 86_400)}d ago`

  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })
}
