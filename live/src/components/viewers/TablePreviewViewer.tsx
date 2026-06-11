import { useEffect, useState } from "react"
import { TriangleAlert, Table2 } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { DataGrid } from "@/components/data-grid/DataGrid"
import { runSql } from "@/lib/sql-engine"
import { deriveTableName, formatForPath } from "@/lib/sql-engine/types"
import type { SqlRunResult } from "@/lib/sql-engine/types"
import { cn } from "@/lib/utils"

const PREVIEW_ROWS = 500
// Above this, don't auto-download+parse on file open — offer an explicit button.
const AUTO_PREVIEW_MAX_BYTES = 25 * 1024 * 1024

interface TablePreviewViewerProps {
  /** Drive path (leading slash optional). */
  path: string
  /** File size in bytes, used to gate auto-preview. */
  size?: number
  className?: string
}

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; result: SqlRunResult }
  | { status: "error"; message: string; suggestion?: string }

/**
 * Default preview for tabular documents: runs `SELECT * FROM <doc> LIMIT N`
 * through the shared SQL engine (DuckDB-WASM for csv/tsv/parquet, server for
 * xlsx) and renders the rows in the shared DataGrid. Large files require an
 * explicit click so opening a file never silently pulls hundreds of MB.
 */
export function TablePreviewViewer({ path, size, className }: TablePreviewViewerProps) {
  const { client, orgId, driveId } = useAuth()
  const format = formatForPath(path)
  const autoPreview = size == null || size <= AUTO_PREVIEW_MAX_BYTES
  const [state, setState] = useState<State>({ status: "idle" })

  useEffect(() => {
    if (!format || !client || !orgId || !driveId) return
    if (!autoPreview) {
      setState({ status: "idle" })
      return
    }
    let cancelled = false
    setState({ status: "loading" })
    const docPath = path.replace(/^\/+/, "")
    const table = deriveTableName(path, [])
    runSql(
      {
        query: `SELECT * FROM "${table}" LIMIT ${PREVIEW_ROWS}`,
        docs: [{ path: docPath, table, format }],
        maxRows: PREVIEW_ROWS,
      },
      { client, orgId, driveId },
      { forceServer: true },
    )
      .then((result) => {
        if (!cancelled) setState({ status: "done", result })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const e = err as { message?: string; suggestion?: string }
        setState({
          status: "error",
          message: e?.message ?? "Preview failed",
          suggestion: e?.suggestion,
        })
      })
    return () => {
      cancelled = true
    }
    // Re-run when the file or auto-preview gate changes.
  }, [path, format, autoPreview, client, orgId, driveId])

  const runNow = () => {
    if (!format || !client || !orgId || !driveId) return
    const docPath = path.replace(/^\/+/, "")
    const table = deriveTableName(path, [])
    setState({ status: "loading" })
    runSql(
      {
        query: `SELECT * FROM "${table}" LIMIT ${PREVIEW_ROWS}`,
        docs: [{ path: docPath, table, format }],
        maxRows: PREVIEW_ROWS,
      },
      { client, orgId, driveId },
      { forceServer: true },
    )
      .then((result) => setState({ status: "done", result }))
      .catch((err: unknown) => {
        const e = err as { message?: string; suggestion?: string }
        setState({ status: "error", message: e?.message ?? "Preview failed", suggestion: e?.suggestion })
      })
  }

  if (!format) return null

  if (state.status === "loading") {
    return (
      <div className={cn("flex flex-1 items-center justify-center", className)}>
        <Spinner />
      </div>
    )
  }

  if (state.status === "error") {
    return (
      <div className={cn("flex-1 overflow-auto p-4", className)}>
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3">
          <div className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-destructive">Couldn't preview this file</p>
              <p className="mt-1 font-mono text-xs break-words whitespace-pre-wrap text-destructive/90">
                {state.message}
              </p>
              {state.suggestion && (
                <p className="mt-2 text-xs text-muted-foreground">{state.suggestion}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (state.status === "idle") {
    return (
      <div className={cn("flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center", className)}>
        <Table2 className="size-6 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          Large file{size ? ` (${formatBytes(size)})` : ""} — preview not loaded automatically.
        </p>
        <Button variant="secondary" size="sm" onClick={runNow}>
          Preview as table
        </Button>
      </div>
    )
  }

  const { result } = state
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {result.rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-sm text-muted-foreground">This file has no rows.</p>
        </div>
      ) : (
        <DataGrid columns={result.columns} rows={result.rows} />
      )}
      <div className="flex h-7 shrink-0 items-center gap-2 border-t border-border px-3 text-[11px] text-muted-foreground">
        <span className="tabular-nums">
          {result.rowCount.toLocaleString()} row{result.rowCount === 1 ? "" : "s"}
        </span>
        {result.truncated && <span>· first {PREVIEW_ROWS}</span>}
        {size != null && <span className="tabular-nums">· {formatBytes(size)}</span>}
        <span className="text-muted-foreground/60">
          · {result.engine === "wasm" ? "loaded in browser" : "loaded on server"}
        </span>
        <Badge variant="outline" className="ml-auto h-4 px-1.5 font-mono text-[10px]">
          {result.engine}
        </Badge>
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
