import { useMemo, useState } from "react"
import { ChartColumn, ChartLine, ChevronDown, Copy, Download, Table2, TriangleAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
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
import { downloadBlob } from "@/lib/download"
import { cn } from "@/lib/utils"
import { toast } from "@/stores/toast"
import { ResultsChart, getNumericColumns } from "./ResultsChart"
import type { SqlRunResult } from "@/lib/sql-engine/types"

export interface SqlRunError {
  message: string
  suggestion?: string
}

type ViewMode = "table" | "bar" | "line"

interface ResultsPanelProps {
  result: SqlRunResult | null
  error: SqlRunError | null
  running: boolean
  className?: string
}

export function ResultsPanel({ result, error, running, className }: ResultsPanelProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("table")
  const [yColumn, setYColumn] = useState<string | null>(null)

  const numericColumns = useMemo(
    () => (result ? getNumericColumns(result.columns, result.rows) : []),
    [result],
  )
  // Selected Y column, falling back to the first numeric column when the
  // previous selection no longer exists in the result.
  const effectiveY =
    yColumn && numericColumns.includes(yColumn) ? yColumn : (numericColumns[0] ?? null)

  const hasRows = !!result && result.rows.length > 0

  const copyJson = async () => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(result.rows, null, 2))
      toast.success("Results copied as JSON")
    } catch {
      toast.error("Copy failed")
    }
  }

  const downloadCsv = () => {
    if (!result) return
    const csv = toCsv(result)
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), "query-results.csv")
  }

  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      {/* Toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <ToggleGroup
          value={[viewMode]}
          onValueChange={(value) => {
            const next = value[0] as ViewMode | undefined
            if (next) setViewMode(next)
          }}
        >
          <ToggleGroupItem value="table" aria-label="Table view">
            <Table2 />
          </ToggleGroupItem>
          <ToggleGroupItem value="bar" aria-label="Bar chart">
            <ChartColumn />
          </ToggleGroupItem>
          <ToggleGroupItem value="line" aria-label="Line chart">
            <ChartLine />
          </ToggleGroupItem>
        </ToggleGroup>

        {viewMode !== "table" && hasRows && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  className="gap-1 font-mono text-muted-foreground"
                  disabled={numericColumns.length === 0}
                >
                  Y: {effectiveY ?? "—"}
                  <ChevronDown />
                </Button>
              }
            />
            <DropdownMenuContent align="start" className="w-44">
              <DropdownMenuRadioGroup
                value={effectiveY ?? undefined}
                onValueChange={(value) => setYColumn(String(value))}
              >
                {numericColumns.map((name) => (
                  <DropdownMenuRadioItem key={name} value={name} className="font-mono text-xs">
                    {name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={copyJson}
                  disabled={!hasRows}
                  className="text-muted-foreground"
                  aria-label="Copy results as JSON"
                >
                  <Copy />
                </Button>
              }
            />
            <TooltipContent>Copy results as JSON</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={downloadCsv}
                  disabled={!hasRows}
                  className="text-muted-foreground"
                  aria-label="Download results as CSV"
                >
                  <Download />
                </Button>
              }
            />
            <TooltipContent>Download as CSV</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Body */}
      {running ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : error ? (
        <div className="flex-1 overflow-auto p-4">
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3">
            <div className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-destructive">Query failed</p>
                <p className="mt-1 font-mono text-xs whitespace-pre-wrap break-words text-destructive/90">
                  {error.message}
                </p>
                {error.suggestion && (
                  <p className="mt-2 text-xs text-muted-foreground">{error.suggestion}</p>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : !result ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-8 text-center">
          <Table2 className="size-6 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">Run a query to see results</p>
          <p className="text-xs text-muted-foreground/70">
            Press <Kbd>⌘⏎</Kbd> in the editor or hit Run
          </p>
        </div>
      ) : result.rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-sm text-muted-foreground">Query returned no rows.</p>
        </div>
      ) : viewMode === "table" ? (
        <ResultsTable result={result} />
      ) : effectiveY ? (
        <ResultsChart
          columns={result.columns}
          rows={result.rows}
          kind={viewMode}
          yColumn={effectiveY}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-sm text-muted-foreground">No numeric columns to chart.</p>
        </div>
      )}

      {/* Footer */}
      {result && !running && !error && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-t border-border px-3 text-[11px] text-muted-foreground">
          <span className="tabular-nums">
            {result.rowCount.toLocaleString()} row{result.rowCount === 1 ? "" : "s"} in{" "}
            {result.elapsedMs.toLocaleString()}ms
          </span>
          {result.truncated && <span>· truncated</span>}
          <Badge variant="outline" className="ml-auto h-4 px-1.5 font-mono text-[10px]">
            {result.engine}
          </Badge>
        </div>
      )}
    </div>
  )
}

function ResultsTable({ result }: { result: SqlRunResult }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-background">
          <tr>
            <th className="w-10 border-b border-border px-2 py-1.5 text-right font-normal text-muted-foreground/60">
              #
            </th>
            {result.columns.map((col) => (
              <th
                key={col.name}
                className="border-b border-border px-2 py-1.5 text-left font-medium whitespace-nowrap"
              >
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="cursor-default">{col.name}</span>}
                  />
                  <TooltipContent className="font-mono">{col.type}</TooltipContent>
                </Tooltip>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono">
          {result.rows.map((row, i) => (
            <tr key={i} className="hover:bg-muted/50">
              <td className="border-b border-border/50 px-2 py-1 text-right text-muted-foreground/50 tabular-nums">
                {i + 1}
              </td>
              {result.columns.map((col) => (
                <ResultCell key={col.name} value={row[col.name]} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ResultCell({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return (
      <td className="border-b border-border/50 px-2 py-1 whitespace-nowrap italic text-muted-foreground/50">
        NULL
      </td>
    )
  }
  const text = typeof value === "object" ? JSON.stringify(value) : String(value)
  return (
    <td
      className="max-w-md truncate border-b border-border/50 px-2 py-1 whitespace-nowrap tabular-nums"
      title={text.length > 60 ? text : undefined}
    >
      {text}
    </td>
  )
}

function toCsv(result: SqlRunResult): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return ""
    const text = typeof value === "object" ? JSON.stringify(value) : String(value)
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const header = result.columns.map((c) => escape(c.name)).join(",")
  const lines = result.rows.map((row) =>
    result.columns.map((c) => escape(row[c.name])).join(","),
  )
  return [header, ...lines].join("\n")
}
