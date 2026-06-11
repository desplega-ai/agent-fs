import { useCallback, useEffect, useRef, useState } from "react"
import { useSearchParams } from "react-router"
import { ChevronDown, Database, Play, Server } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DocumentPicker } from "@/components/sql/DocumentPicker"
import { SqlEditor } from "@/components/sql/SqlEditor"
import { ResultsPanel, type SqlRunError } from "@/components/sql/ResultsPanel"
import { useDocumentTitle } from "@/hooks/use-document-title"
import {
  canRunInBrowser,
  deriveTableName,
  formatForPath,
  runSql,
  sanitizeTableName,
  type BoundDoc,
  type SqlRunResult,
} from "@/lib/sql-engine"
import { cn } from "@/lib/utils"
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

  // Pre-bind ?path=... and pre-fill a starter query (once per mount).
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current) return
    seeded.current = true
    const raw = searchParams.get("path")
    if (!raw) return
    const path = raw.replace(/^\/+/, "")
    const format = formatForPath(path)
    if (!format) return
    setDocs((prev) =>
      prev.some((d) => d.path === path)
        ? prev
        : [...prev, { path, table: deriveTableName(path, prev.map((d) => d.table)), format }],
    )
    setQuery((q) => q || `SELECT * FROM '/${path}' LIMIT 100`)
  }, [searchParams])

  const addDoc = useCallback((rawPath: string) => {
    const path = rawPath.replace(/^\/+/, "")
    const format = formatForPath(path)
    if (!format) return
    setDocs((prev) => {
      if (prev.some((d) => d.path === path)) return prev
      return [...prev, { path, table: deriveTableName(path, prev.map((d) => d.table)), format }]
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

  const run = useCallback(async () => {
    if (!orgId || !driveId) return
    if (!query.trim()) {
      toast.error("Nothing to run", { description: "Write a query first." })
      return
    }
    setRunning(true)
    setError(null)
    try {
      const res = await runSql(
        { query, docs, maxRows },
        { client, orgId, driveId },
        { forceServer },
      )
      setResult(res)
    } catch (err) {
      const apiErr = err as Partial<ApiError> & Error
      const next: SqlRunError = {
        message: apiErr.message || "Query failed",
        suggestion: apiErr.suggestion,
      }
      setError(next)
      setResult(null)
      toast.error("Query failed", { description: next.message })
    } finally {
      setRunning(false)
    }
  }, [client, orgId, driveId, query, docs, maxRows, forceServer])

  const wasmEligible = canRunInBrowser(docs)
  const engineHint = forceServer
    ? "server engine (forced)"
    : wasmEligible
      ? "browser engine (wasm)"
      : docs.length === 0
        ? "server engine — path literals resolve on the server"
        : "server engine — xlsx/sqlite/duckdb need the server"

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Sub-header */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
        <Database className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">SQL workbench</span>
        <span className="hidden truncate text-xs text-muted-foreground sm:inline">
          Query drive documents with DuckDB
        </span>
        <div className="ml-auto shrink-0">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={forceServer ? "secondary" : "ghost"}
                  size="xs"
                  onClick={() => setForceServer((v) => !v)}
                  aria-pressed={forceServer}
                  className={cn("gap-1", !forceServer && "text-muted-foreground")}
                >
                  <Server />
                  Run on server
                </Button>
              }
            />
            <TooltipContent>
              {forceServer
                ? "Queries are forced to the server engine"
                : "Auto: browser (wasm) when every bound document supports it"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Bound documents */}
      <div className="shrink-0 border-b border-border px-4 py-2">
        <DocumentPicker docs={docs} onAdd={addDoc} onRemove={removeDoc} onRename={renameDoc} />
      </div>

      {/* Editor */}
      <div className="flex h-[38%] min-h-44 shrink-0 flex-col border-b border-border">
        <div className="min-h-0 flex-1">
          <SqlEditor value={query} onChange={setQuery} onRun={run} />
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

          <span className="ml-auto hidden text-[11px] text-muted-foreground md:inline">
            {engineHint}
          </span>
        </div>
      </div>

      {/* Results */}
      <ResultsPanel className="min-h-0 flex-1" result={result} error={error} running={running} />
    </div>
  )
}
