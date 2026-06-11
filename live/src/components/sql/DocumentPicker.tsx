import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { FileText, Plus, X } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { QUERYABLE_EXTENSIONS, sanitizeTableName, type BoundDoc } from "@/lib/sql-engine/types"
import type { GlobMatch, GlobResult } from "@/api/types"

/** The glob op treats `{}` as literal characters (no brace expansion), so run
 *  one glob per queryable extension in parallel and merge the matches. Gzipped
 *  text formats (`.csv.gz`, …) get their own globs since the op handles them. */
const GZIP_EXTENSIONS = ["csv", "tsv", "json", "jsonl", "ndjson"]
const QUERYABLE_GLOBS = [
  ...Object.keys(QUERYABLE_EXTENSIONS).map((ext) => `**/*.${ext}`),
  ...GZIP_EXTENSIONS.map((ext) => `**/*.${ext}.gz`),
]

function useQueryableDocs() {
  const { client, orgId, driveId } = useAuth()

  return useQuery({
    queryKey: ["sql-docs", orgId, driveId],
    queryFn: async () => {
      const results = await Promise.all(
        QUERYABLE_GLOBS.map((pattern) =>
          client
            .callOp<GlobResult>(orgId!, "glob", { pattern }, driveId)
            .catch(() => ({ matches: [] }) as GlobResult),
        ),
      )
      const byPath = new Map<string, GlobMatch>()
      for (const result of results) {
        for (const match of result.matches) byPath.set(match.path, match)
      }
      return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
    },
    enabled: !!orgId && !!driveId,
  })
}

interface DocumentPickerProps {
  docs: BoundDoc[]
  onAdd: (path: string, size?: number) => void
  onRemove: (path: string) => void
  onRename: (path: string, table: string) => void
}

export function DocumentPicker({ docs, onAdd, onRemove, onRename }: DocumentPickerProps) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState("")
  const { data: matches, isLoading } = useQueryableDocs()

  const available = useMemo(() => {
    const picked = new Set(docs.map((d) => d.path))
    const needle = filter.trim().toLowerCase()
    return (matches ?? []).filter(
      (m) =>
        !picked.has(m.path.replace(/^\/+/, "")) &&
        (!needle || m.path.toLowerCase().includes(needle)),
    )
  }, [matches, docs, filter])

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {docs.map((doc) => (
        <DocChip key={doc.path} doc={doc} onRemove={onRemove} onRename={onRename} />
      ))}

      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setFilter("")
        }}
      >
        <PopoverTrigger
          render={
            <Button variant="outline" size="xs" className="gap-1 text-muted-foreground">
              <Plus />
              Add document
            </Button>
          }
        />
        <PopoverContent align="start" className="w-80 gap-1.5 p-2">
          <Input
            placeholder="Filter documents…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-7 text-xs"
            autoFocus
          />
          <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
            {isLoading ? (
              <div className="flex justify-center py-4">
                <Spinner size="sm" />
              </div>
            ) : available.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {matches && matches.length > 0
                  ? "No matching documents."
                  : "No queryable documents in this drive (csv, tsv, parquet, xlsx, json, jsonl, sqlite, duckdb)."}
              </p>
            ) : (
              available.map((match) => (
                <button
                  key={match.path}
                  type="button"
                  onClick={() => {
                    onAdd(match.path, match.size)
                    setOpen(false)
                    setFilter("")
                  }}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                    "hover:bg-muted transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  )}
                >
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-mono">{match.path}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                    {formatBytes(match.size)}
                  </span>
                </button>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>

      {docs.length === 0 && (
        <span className="text-xs text-muted-foreground">
          Bind documents to query them by table name, or reference drive paths directly
          (server engine).
        </span>
      )}
    </div>
  )
}

function DocChip({
  doc,
  onRemove,
  onRename,
}: {
  doc: BoundDoc
  onRemove: (path: string) => void
  onRename: (path: string, table: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(doc.table)

  const filename = doc.path.split("/").pop() ?? doc.path

  const commit = () => {
    setEditing(false)
    const sanitized = sanitizeTableName(draft)
    if (sanitized && sanitized !== doc.table) onRename(doc.path, sanitized)
  }

  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-lg border border-border bg-muted/40 pl-2 pr-1 text-xs">
      {editing ? (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit()
            if (e.key === "Escape") {
              setDraft(doc.table)
              setEditing(false)
            }
          }}
          autoFocus
          aria-label="Table name"
          className="h-4 border-b border-ring bg-transparent font-mono text-xs font-medium outline-none"
          style={{ width: `${Math.max(draft.length, 3) + 1}ch` }}
        />
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => {
                  setDraft(doc.table)
                  setEditing(true)
                }}
                className="rounded-sm font-mono text-xs font-medium outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {doc.table}
              </button>
            }
          />
          <TooltipContent>/{doc.path} — click to rename</TooltipContent>
        </Tooltip>
      )}
      {filename !== `${doc.table}.${doc.path.split(".").pop()}` && (
        <span className="max-w-40 truncate text-muted-foreground/70">{filename}</span>
      )}
      {doc.size != null && (
        <span className="text-[10px] text-muted-foreground/60 tabular-nums">
          {formatBytes(doc.size)}
        </span>
      )}
      <button
        type="button"
        onClick={() => onRemove(doc.path)}
        aria-label={`Remove ${doc.table}`}
        className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
