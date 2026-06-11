import { useMemo, useRef, useState } from "react"
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export interface DataGridColumn {
  name: string
  type?: string
}

interface DataGridProps {
  columns: DataGridColumn[]
  rows: Record<string, unknown>[]
  className?: string
  /** Estimated row height in px (fixed-height rows keep virtualization simple). */
  rowHeight?: number
}

const ROW_NUM_WIDTH = 52
const DEFAULT_COL_WIDTH = 160
const MIN_COL_WIDTH = 64

/**
 * Virtualized, themed data grid shared by the SQL results panel and tabular
 * file previews. Headless TanStack Table for sizing/sorting + react-virtual for
 * row windowing, so tens of thousands of rows render without choking the DOM.
 */
export function DataGrid({ columns, rows, className, rowHeight = 30 }: DataGridProps) {
  const [sorting, setSorting] = useState<SortingState>([])
  const scrollRef = useRef<HTMLDivElement>(null)

  const tableColumns = useMemo<ColumnDef<Record<string, unknown>>[]>(
    () =>
      columns.map((col) => ({
        id: col.name,
        accessorFn: (row) => row[col.name],
        header: col.name,
        size: DEFAULT_COL_WIDTH,
        minSize: MIN_COL_WIDTH,
        // String sort keeps mixed types comparable and stable.
        sortingFn: (a, b, id) =>
          collator.compare(toText(a.getValue(id)), toText(b.getValue(id))),
      })),
    [columns],
  )

  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    columnResizeMode: "onChange",
  })

  const tableRows = table.getRowModel().rows
  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  })

  const totalWidth = table.getTotalSize() + ROW_NUM_WIDTH
  const virtualRows = rowVirtualizer.getVirtualItems()

  return (
    <div ref={scrollRef} className={cn("min-h-0 flex-1 overflow-auto", className)}>
      <div style={{ width: totalWidth, minWidth: "100%" }} className="text-xs">
        {/* Header */}
        <div className="sticky top-0 z-10 flex border-b border-border bg-background">
          <div
            className="shrink-0 px-2 py-1.5 text-right font-normal text-muted-foreground/50"
            style={{ width: ROW_NUM_WIDTH }}
          >
            #
          </div>
          {table.getHeaderGroups()[0]?.headers.map((header) => {
            const sorted = header.column.getIsSorted()
            const type = columns.find((c) => c.name === header.column.id)?.type
            return (
              <div
                key={header.id}
                className="group/h relative flex items-center px-2 py-1.5 font-medium"
                style={{ width: header.getSize() }}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="flex min-w-0 items-center gap-1 truncate text-left hover:text-foreground"
                      >
                        <span className="truncate">{header.column.id}</span>
                        {sorted === "asc" ? (
                          <ArrowUp className="size-3 shrink-0 text-muted-foreground" />
                        ) : sorted === "desc" ? (
                          <ArrowDown className="size-3 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground/0 group-hover/h:text-muted-foreground/40" />
                        )}
                      </button>
                    }
                  />
                  <TooltipContent className="font-mono">{type ?? "?"}</TooltipContent>
                </Tooltip>
                {/* Column resize handle */}
                <div
                  onMouseDown={header.getResizeHandler()}
                  onTouchStart={header.getResizeHandler()}
                  className={cn(
                    "absolute top-0 right-0 h-full w-1 cursor-col-resize touch-none select-none",
                    "opacity-0 group-hover/h:opacity-100",
                    header.column.getIsResizing() ? "bg-primary opacity-100" : "bg-border",
                  )}
                />
              </div>
            )
          })}
        </div>

        {/* Body */}
        <div
          className="relative font-mono"
          style={{ height: rowVirtualizer.getTotalSize() }}
        >
          {virtualRows.map((vr) => {
            const row = tableRows[vr.index]
            return (
              <div
                key={row.id}
                className="absolute left-0 flex w-full border-b border-border/50 hover:bg-muted/40"
                style={{ height: vr.size, transform: `translateY(${vr.start}px)` }}
              >
                <div
                  className="shrink-0 px-2 py-1 text-right text-muted-foreground/40 tabular-nums"
                  style={{ width: ROW_NUM_WIDTH }}
                >
                  {vr.index + 1}
                </div>
                {row.getVisibleCells().map((cell) => (
                  <Cell
                    key={cell.id}
                    value={cell.getValue()}
                    width={cell.column.getSize()}
                  />
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

function toText(value: unknown): string {
  if (value === null || value === undefined) return ""
  return typeof value === "object" ? JSON.stringify(value) : String(value)
}

function Cell({ value, width }: { value: unknown; width: number }) {
  if (value === null || value === undefined) {
    return (
      <div
        className="truncate px-2 py-1 italic text-muted-foreground/40"
        style={{ width }}
      >
        NULL
      </div>
    )
  }
  const text = toText(value)
  return (
    <div
      className="truncate px-2 py-1 tabular-nums"
      style={{ width }}
      title={text.length > 48 ? text : undefined}
    >
      {text}
    </div>
  )
}
