import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "react-router"
import { ChevronDown, Cpu, Database, Play, Server } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DocumentPicker } from "@/components/sql/DocumentPicker"
import { SqlEditor, type SqlCompletion } from "@/components/sql/SqlEditor"
import { ResultsPanel, type SqlRunError } from "@/components/sql/ResultsPanel"
import { useDocumentTitle } from "@/hooks/use-document-title"
import {
  canRunInBrowser,
  DATABASE_FORMATS,
  deriveTableName,
  formatForPath,
  runSql,
  sanitizeTableName,
  type BoundDoc,
  type SqlEngineContext,
  type SqlRunResult,
} from "@/lib/sql-engine"
import { toast } from "@/stores/toast"
import type { ApiError } from "@/api/client"

const ROW_LIMITS = [100, 1000, 10000]

export function SqlPage() {
  const { client, orgId, driveId } = useAuth()
  const [searchParams] = useSearchParams()

  const [docs, setDocs] = useState<BoundDoc[]>([])
  const [query, setQuery] = useState("")
  const [maxRows, setMaxRows] = useState(1000)
  const [forceServer, setForceServer] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<SqlRunResult | null>(null)
  const [error, setError] = useState<SqlRunError | null>(null)

  useDocumentTitle("SQL")

  // Pre-bind ?path=... and pre-fill a starter query (once, after auth resolves).
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current) return
    const raw = searchParams.get("path")
    if (!raw) return
    if (!orgId || !driveId) return // wait for auth before introspecting
    seeded.current = true

    const path = raw.replace(/^\/+/, "")
    const format = formatForPath(path)
    if (!format) return
    const table = deriveTableName(path, [])
    const doc: BoundDoc = { path, table, format }
    setDocs((prev) => (prev.some((d) => d.path === path) ? prev : [...prev, doc]))

    if (DATABASE_FORMATS.has(format)) {
      // SQLite/DuckDB files expose their tables as `<table>.<name>` and can't be
      // read by path literal — discover the first table and seed a real query.
      runSql(
        {
          query: `SELECT table_name FROM duckdb_tables() WHERE schema_name = '${table}' ORDER BY table_name`,
          docs: [doc],
          maxRows: 100,
        },
        { client, orgId, driveId },
      )
        .then((res) => {
          const tables = res.rows.map((r) => String(r.table_name))
          setQuery((q) => q || starterForDatabase(table, tables))
        })
        .catch(() => {
          setQuery((q) => q || `-- ${table} is a database; query its tables as ${table}.<table_name>`)
        })
    } else {
      setQuery((q) => q || `SELECT * FROM '/${path}' LIMIT 100`)
    }
  }, [searchParams, client, orgId, driveId])

  const addDoc = useCallback((rawPath: string, size?: number) => {
    const path = rawPath.replace(/^\/+/, "")
    const format = formatForPath(path)
    if (!format) return
    setDocs((prev) => {
      if (prev.some((d) => d.path === path)) return prev
      return [...prev, { path, table: deriveTableName(path, prev.map((d) => d.table)), format, size }]
    })
  }, [])

  const removeDoc = useCallback((path: string) => {
    setDocs((prev) => prev.filter((d) => d.path !== path))
  }, [])

  const renameDoc = useCallback((path: string, table: string) => {
    setDocs((prev) => {
      const sanitized = sanitizeTableName(table)
      if (!sanitized) return prev
      // Keep table names unique — refuse a rename that collides.
      if (prev.some((d) => d.path !== path && d.table === sanitized)) {
        toast.error("Table name already in use", { description: sanitized })
        return prev
      }
      return prev.map((d) => (d.path === path ? { ...d, table: sanitized } : d))
    })
  }, [])

  // Discovered tables for each bound database doc (keyed by doc path), used for
  // editor autocompletion of `<schema>.<table>` names.
  const [dbTables, setDbTables] = useState<Record<string, string[]>>({})
  useEffect(() => {
    if (!orgId || !driveId) return
    const ctx: SqlEngineContext = { client, orgId, driveId }
    for (const doc of docs) {
      if (!DATABASE_FORMATS.has(doc.format)) continue
      if (dbTables[doc.path]) continue
      runSql(
        {
          query: `SELECT table_name FROM duckdb_tables() WHERE schema_name = '${doc.table}' ORDER BY table_name`,
          docs: [doc],
          maxRows: 1000,
        },
        ctx,
      )
        .then((res) => {
          const tables = res.rows.map((r) => String(r.table_name))
          setDbTables((prev) => (prev[doc.path] ? prev : { ...prev, [doc.path]: tables }))
        })
        .catch(() => {
          /* introspection is best-effort — autocomplete just omits this db's tables */
        })
    }
  }, [docs, client, orgId, driveId, dbTables])

  const completions = useMemo<SqlCompletion[]>(() => {
    const out: SqlCompletion[] = []
    for (const doc of docs) {
      if (DATABASE_FORMATS.has(doc.format)) {
        out.push({ label: doc.table, detail: `${doc.format} database`, kind: "schema" })
        for (const t of dbTables[doc.path] ?? []) {
          out.push({ label: `${doc.table}.${t}`, detail: `table in ${doc.table}`, kind: "table" })
        }
      } else {
        out.push({ label: doc.table, detail: `${doc.format} · /${doc.path}`, kind: "table" })
      }
    }
    return out
  }, [docs, dbTables])

  // Monotonic run token: only the most recent run may update results, so a slow
  // earlier run can't clobber a newer one (rapid re-runs / edited query).
  const runReqRef = useRef(0)
  const run = useCallback(async () => {
    if (!orgId || !driveId) return
    if (!query.trim()) {
      toast.error("Nothing to run", { description: "Write a query first." })
      return
    }
    const reqId = ++runReqRef.current
    setRunning(true)
    setError(null)
    try {
      const res = await runSql(
        { query, docs, maxRows },
        { client, orgId, driveId },
        { forceServer },
      )
      if (runReqRef.current !== reqId) return
      setResult(res)
    } catch (err) {
      if (runReqRef.current !== reqId) return
      const apiErr = err as Partial<ApiError> & Error
      const next: SqlRunError = {
        message: apiErr.message || "Query failed",
        suggestion: apiErr.suggestion,
      }
      setError(next)
      setResult(null)
      toast.error("Query failed", { description: next.message })
    } finally {
      if (runReqRef.current === reqId) setRunning(false)
    }
  }, [client, orgId, driveId, query, docs, maxRows, forceServer])

  const wasmEligible = canRunInBrowser(docs, query)
  const runsInBrowser = !forceServer && wasmEligible
  const effectiveEngine: "browser" | "server" = runsInBrowser ? "browser" : "server"
  const engineHint = forceServer
    ? "Runs on the server (forced)"
    : wasmEligible
      ? "Runs in your browser · DuckDB-WASM"
      : docs.length === 0
        ? "Runs on the server · path literals resolve there"
        : "Runs on the server · xlsx/sqlite/duckdb aren't supported in-browser"

  // Bytes the browser engine will download + parse (known doc sizes only).
  const browserLoadBytes = runsInBrowser
    ? docs.reduce((sum, d) => sum + (d.size ?? 0), 0)
    : 0
  const browserLoadHint =
    runsInBrowser && browserLoadBytes > 0 ? ` · loads ~${formatBytes(browserLoadBytes)}` : ""

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Sub-header */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
        <Database className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">SQL workbench</span>
        <span className="hidden truncate text-xs text-muted-foreground sm:inline">
          Query drive documents with DuckDB
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger
              render={<span className="cursor-help text-[11px] text-muted-foreground">Engine</span>}
            />
            <TooltipContent className="max-w-64">
              Where the query runs. Browser (DuckDB-WASM, no upload) handles
              csv/tsv/parquet/json; Server handles xlsx/sqlite/duckdb and bare path
              literals. Pick Server to force it.
            </TooltipContent>
          </Tooltip>
          <ToggleGroup
            value={[effectiveEngine]}
            onValueChange={(v) => {
              const next = v[0]
              if (next === "browser") setForceServer(false)
              else if (next === "server") setForceServer(true)
            }}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <ToggleGroupItem value="browser" disabled={!wasmEligible} aria-label="Run in browser">
                    <Cpu />
                  </ToggleGroupItem>
                }
              />
              <TooltipContent className="max-w-56">
                {wasmEligible
                  ? "Browser — runs locally with DuckDB-WASM, no upload. Best for csv/tsv/parquet/json."
                  : "Browser unavailable — xlsx/sqlite/duckdb and path-literal queries must run on the server."}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <ToggleGroupItem value="server" aria-label="Run on server">
                    <Server />
                  </ToggleGroupItem>
                }
              />
              <TooltipContent className="max-w-56">
                Server — runs on the daemon's DuckDB. Required for xlsx/sqlite/duckdb;
                streams only result rows back.
              </TooltipContent>
            </Tooltip>
          </ToggleGroup>
        </div>
      </div>

      {/* Bound documents */}
      <div className="shrink-0 border-b border-border px-4 py-2">
        <DocumentPicker docs={docs} onAdd={addDoc} onRemove={removeDoc} onRename={renameDoc} />
      </div>

      {/* Editor */}
      <div className="flex h-[38%] min-h-44 shrink-0 flex-col border-b border-border">
        <div className="min-h-0 flex-1">
          <SqlEditor value={query} onChange={setQuery} onRun={run} completions={completions} />
        </div>
        <div className="flex h-9 shrink-0 items-center gap-2 border-t border-border px-2">
          <Button size="xs" onClick={run} disabled={running} className="gap-1.5">
            {running ? (
              <Spinner size="sm" className="size-3 border-primary-foreground/40 border-t-primary-foreground" />
            ) : (
              <Play />
            )}
            Run
            <Kbd className="bg-primary-foreground/15 border-primary-foreground/20 text-primary-foreground/80">
              ⌘⏎
            </Kbd>
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="xs" className="gap-1 text-muted-foreground">
                  Limit {maxRows.toLocaleString()}
                  <ChevronDown />
                </Button>
              }
            />
            <DropdownMenuContent align="start" className="w-36">
              <DropdownMenuRadioGroup
                value={String(maxRows)}
                onValueChange={(value) => setMaxRows(Number(value))}
              >
                {ROW_LIMITS.map((n) => (
                  <DropdownMenuRadioItem key={n} value={String(n)}>
                    {n.toLocaleString()} rows
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <span className="ml-auto truncate text-[11px] text-muted-foreground">
            {engineHint}{browserLoadHint}
          </span>
        </div>
      </div>

      {/* Results */}
      <ResultsPanel className="min-h-0 flex-1" result={result} error={error} running={running} />
    </div>
  )
}

/** Build a starter query for a bound database, selecting from its first table. */
function starterForDatabase(table: string, tables: string[]): string {
  if (tables.length === 0) return `-- ${table} has no tables`
  const list = tables.map((t) => `${table}.${t}`).join(", ")
  return `-- tables: ${list}\nSELECT * FROM ${table}.${tables[0]} LIMIT 100`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
