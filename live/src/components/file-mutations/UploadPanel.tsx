import { AlertTriangle, Check, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { isFinished, uploadStore, useUploads, type UploadItem } from "@/stores/upload"
import { cn } from "@/lib/utils"

/**
 * Floating list of queued, running and finished uploads. Renders nothing when
 * the queue is empty. Conflicts expose Replace / Skip inline.
 */
export function UploadPanel({ className }: { className?: string }) {
  const items = useUploads()
  if (items.length === 0) return null

  const active = items.filter((i) => i.status === "queued" || i.status === "uploading").length
  const hasFinished = items.some((i) => isFinished(i.status))

  return (
    <div
      className={cn(
        "flex max-h-72 w-80 flex-col rounded-lg bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10",
        className,
      )}
      aria-label="Uploads"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs">
        <span className="font-medium">
          {active > 0 ? `Uploading ${active}...` : "Uploads"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => uploadStore.clearFinished()}
          disabled={!hasFinished}
        >
          Clear
        </Button>
      </div>
      <ul className="overflow-y-auto p-1">
        {items.map((item) => (
          <UploadRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  )
}

function UploadRow({ item }: { item: UploadItem }) {
  const inFlight = item.status === "queued" || item.status === "uploading"
  return (
    <li className="flex flex-col gap-1 rounded-md px-2 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono" title={item.path}>
          {item.path}
        </span>
        <StatusBadge item={item} />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          aria-label={inFlight ? "Cancel upload" : "Dismiss"}
          title={inFlight ? "Cancel" : "Dismiss"}
          onClick={() => (inFlight ? uploadStore.cancel(item.id) : uploadStore.dismiss(item.id))}
          disabled={item.status === "conflict"}
        >
          <X />
        </Button>
      </div>
      {item.status === "uploading" && (
        <div
          className="h-1 w-full overflow-hidden rounded bg-muted"
          role="progressbar"
          aria-label={`Uploading ${item.path}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(item.progress * 100)}
        >
          <div
            className="h-full bg-primary transition-[width] duration-150"
            style={{ width: `${Math.round(item.progress * 100)}%` }}
          />
        </div>
      )}
      {item.status === "conflict" && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Already exists</span>
          <div className="flex gap-1">
            <Button type="button" variant="ghost" size="xs" onClick={() => uploadStore.skip(item.id)}>
              Skip
            </Button>
            <Button type="button" variant="outline" size="xs" onClick={() => uploadStore.replace(item.id)}>
              Replace
            </Button>
          </div>
        </div>
      )}
      {(item.status === "error" || item.status === "rejected") && item.error && (
        <p className="break-words text-destructive">{item.error}</p>
      )}
    </li>
  )
}

function StatusBadge({ item }: { item: UploadItem }) {
  switch (item.status) {
    case "queued":
      return <span className="shrink-0 text-muted-foreground">Queued</span>
    case "uploading":
      return <Spinner size="sm" className="shrink-0" />
    case "done":
      return (
        <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
          {item.version !== undefined && <span>v{item.version}</span>}
          <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
        </span>
      )
    case "conflict":
      return <AlertTriangle className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
    case "error":
    case "rejected":
      return <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
    case "skipped":
      return <span className="shrink-0 text-muted-foreground">Skipped</span>
  }
}
