import { useCallback, useEffect, useRef, useState } from "react"
import { TriangleAlert, Database } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { DataGrid } from "@/components/data-grid/DataGrid"
import { runSql } from "@/lib/sql-engine"
import { deriveTableName, formatForPath } from "@/lib/sql-engine/types"
import type { SqlEngineContext, SqlRunResult } from "@/lib/sql-engine/types"
import { cn } from "@/lib/utils"

const PREVIEW_ROWS = 500
const AUTO_PREVIEW_MAX_BYTES = 25 * 1024 * 1024

interface DatabasePreviewViewerProps {
  /** Drive path (leading slash optional) of a sqlite/duckdb database. */
  path: string
  size?: number
  className?: string
}

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; tables: string[]; selected: string; result: SqlRunResult }
  | { status: "empty" }
  | { status: "error"; message: string; suggestion?: string }

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Preview for sqlite/duckdb database files: lists the tables and renders the
 * selected one in the shared DataGrid. Queries run on the server engine (the
 * sqlite/duckdb readers aren't available in DuckDB-WASM).
 */
export function DatabasePreviewViewer({ path, size, className }: DatabasePreviewViewerProps) {
  const { client, orgId, driveId } = useAuth()
  const format = formatForPath(path)
  const schema = deriveTableName(path, [])
  const autoPreview = size == null || size <= AUTO_PREVIEW_MAX_BYTES
  const [state, setState] = useState<State>({ status: "idle" })

  const ctx: SqlEngineContext | null =
    client && orgId && driveId ? { client, orgId, driveId } : null
  const docPath = path.replace(/^\/+/, "")

  // Monotonic request token: every load captures the current value and only
  // applies its result if it's still the latest, so a slow response for an old
  // file/table can't overwrite a newer one.
  const reqRef = useRef(0)

  const loadTable = useCallback(
    async (tables: string[], table: string) => {
      if (!ctx || !format) return
      const reqId = ++reqRef.current
      setState({ status: "loading" })
      try {
        const result = await runSql(
          {
            query: `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT ${PREVIEW_ROWS}`,
            docs: [{ path: docPath, table: schema, format }],
            maxRows: PREVIEW_ROWS,
          },
          ctx,
        )
        if (reqRef.current !== reqId) return
        setState({ status: "ready", tables, selected: table, result })
      } catch (err) {
        if (reqRef.current !== reqId) return
        const e = err as { message?: string; suggestion?: string }
        setState({ status: "error", message: e?.message ?? "Preview failed", suggestion: e?.suggestion })
      }
    },
    [ctx, format, schema, docPath],
  )

  const start = useCallback(async () => {
    if (!ctx || !format) return
    const reqId = ++reqRef.current
    setState({ status: "loading" })
    try {
      const introspect = await runSql(
        {
          query: `SELECT table_name FROM duckdb_tables() WHERE schema_name = '${schema}' ORDER BY table_name`,
          docs: [{ path: docPath, table: schema, format }],
          maxRows: 1000,
        },
        ctx,
      )
      if (reqRef.current !== reqId) return
      const tables = introspect.rows.map((r) => String(r.table_name))
      if (tables.length === 0) {
        setState({ status: "empty" })
        return
      }
      await loadTable(tables, tables[0])
    } catch (err) {
      if (reqRef.current !== reqId) return
      const e = err as { message?: string; suggestion?: string }
      setState({ status: "error", message: e?.message ?? "Preview failed", suggestion: e?.suggestion })
    }
  }, [ctx, format, schema, docPath, loadTable])

  useEffect(() => {
    if (!format || !ctx) return
    if (autoPreview) void start()
    else setState({ status: "idle" })
    // Invalidate any in-flight request when the file/scope changes.
    return () => {
      reqRef.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, format, autoPreview, orgId, driveId])

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
              <p className="text-sm font-medium text-destructive">Couldn't preview this database</p>
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

  if (state.status === "empty") {
    return (
      <div className={cn("flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center", className)}>
        <Database className="size-6 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">This database has no tables.</p>
      </div>
    )
  }

  if (state.status === "idle") {
    return (
      <div className={cn("flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center", className)}>
        <Database className="size-6 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          Large database{size ? ` (${formatBytes(size)})` : ""} — preview not loaded automatically.
        </p>
        <Button variant="secondary" size="sm" onClick={() => void start()}>
          Preview tables
        </Button>
      </div>
    )
  }

  const { tables, selected, result } = state
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {/* Table switcher */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
        <span className="shrink-0 pr-1 text-[11px] text-muted-foreground">Tables:</span>
        {tables.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => void loadTable(tables, t)}
            className={cn(
              "shrink-0 rounded-md px-2 py-0.5 font-mono text-xs transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              t === selected
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {result.rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{selected}</span> is empty.
          </p>
        </div>
      ) : (
        <DataGrid columns={result.columns} rows={result.rows} />
      )}

      <div className="flex h-7 shrink-0 items-center gap-2 border-t border-border px-3 text-[11px] text-muted-foreground">
        <span className="tabular-nums">
          {result.rowCount.toLocaleString()} row{result.rowCount === 1 ? "" : "s"}
        </span>
        {result.truncated && <span>· first {PREVIEW_ROWS}</span>}
        <span>· {tables.length} table{tables.length === 1 ? "" : "s"}</span>
        {size != null && <span className="tabular-nums">· {formatBytes(size)}</span>}
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
