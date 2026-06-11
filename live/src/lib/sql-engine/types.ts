import type { AgentFsClient } from "@/api/client"
import type { SqlColumn, SqlFormat } from "@/api/types"

/** File extensions the SQL workbench can query, mapped to their SQL format. */
export const QUERYABLE_EXTENSIONS: Record<string, SqlFormat> = {
  csv: "csv",
  tsv: "tsv",
  parquet: "parquet",
  xlsx: "xlsx",
  json: "json",
  jsonl: "ndjson",
  ndjson: "ndjson",
  db: "sqlite",
  sqlite: "sqlite",
  sqlite3: "sqlite",
  duckdb: "duckdb",
}

export function formatForPath(path: string): SqlFormat | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return QUERYABLE_EXTENSIONS[ext] ?? null
}

export function isQueryablePath(path: string): boolean {
  return formatForPath(path) !== null
}

/** Sanitize a user-typed table name into a SQL identifier ("" when nothing survives). */
export function sanitizeTableName(name: string): string {
  let cleaned = name.trim().replace(/[^A-Za-z0-9_]/g, "_")
  if (/^[0-9]/.test(cleaned)) cleaned = `_${cleaned}`
  return cleaned
}

/** Derive a SQL-safe table name from a file path stem, unique against `taken`. */
export function deriveTableName(path: string, taken: Iterable<string>): string {
  const stem = (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "")
  const base = sanitizeTableName(stem) || "doc"
  const set = new Set(taken)
  if (!set.has(base)) return base
  let i = 2
  while (set.has(`${base}_${i}`)) i++
  return `${base}_${i}`
}

/** A drive document bound into the query session as a named table. */
export interface BoundDoc {
  /** Drive path without leading slash (e.g. "data/sales.csv"). */
  path: string
  /** Table name the document is exposed as (user-editable). */
  table: string
  format: SqlFormat
  /** File size in bytes, when known (drives the "browser will load" hint). */
  size?: number
}

/** Formats the browser (DuckDB-WASM) engine can read directly. */
export const WASM_READABLE_FORMATS = new Set<SqlFormat>([
  "csv",
  "tsv",
  "parquet",
  "json",
  "ndjson",
])

/** Multi-table database formats — referenced as `<table>.<name>`, not by path. */
export const DATABASE_FORMATS = new Set<SqlFormat>(["sqlite", "duckdb"])

export type SqlEngineKind = "wasm" | "server"

export interface SqlRunInput {
  query: string
  docs: BoundDoc[]
  maxRows: number
}

export interface SqlRunResult {
  columns: SqlColumn[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  elapsedMs: number
  engine: SqlEngineKind
}

export interface SqlEngineContext {
  client: AgentFsClient
  orgId: string
  driveId: string
}
