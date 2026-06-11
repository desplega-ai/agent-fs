import * as duckdb from "@duckdb/duckdb-wasm"
import mvpWasmUrl from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url"
import mvpWorkerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url"
import ehWasmUrl from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url"
import ehWorkerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url"
import type { BoundDoc, SqlEngineContext, SqlRunInput, SqlRunResult } from "./types"

/**
 * Browser engine: DuckDB-WASM. This module is only ever loaded via dynamic
 * import (see ./index.ts) so the wasm bundles never affect initial page load.
 * The eh/mvp bundles need no COOP/COEP headers.
 */

/** Module-level singleton — the db (and its registered file buffers) survives
 *  across runs so repeat queries skip the wasm boot and file re-downloads. */
let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null

/** Registered virtual file name -> source key (org/drive/path@rev) it was loaded from. */
const registeredFiles = new Map<string, string>()

/** View names created in the persistent db, so stale ones (from removed docs or
 *  an org/drive switch) can be dropped before each run. */
const createdViews = new Set<string>()

async function initDb(): Promise<duckdb.AsyncDuckDB> {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasmUrl, mainWorker: mvpWorkerUrl },
    eh: { mainModule: ehWasmUrl, mainWorker: ehWorkerUrl },
  })
  const worker = new Worker(bundle.mainWorker!)
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
  return db
}

function getDb(): Promise<duckdb.AsyncDuckDB> {
  if (!dbPromise) {
    dbPromise = initDb().catch((err) => {
      // Allow a retry on the next run instead of caching a failed boot.
      dbPromise = null
      throw err
    })
  }
  return dbPromise
}

/** Drive path -> the name the file is registered under (leading slash stripped). */
function virtualName(path: string): string {
  return path.replace(/^\/+/, "")
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** The DuckDB table function that reads the registered file for a doc's format. */
function readerFor(doc: BoundDoc, file: string): string {
  const f = quoteString(file)
  switch (doc.format) {
    case "csv":
      return `read_csv_auto(${f})`
    case "tsv":
      // Real tab character — DuckDB string literals don't process backslash escapes.
      return `read_csv_auto(${f}, delim='\t')`
    case "parquet":
      return `read_parquet(${f})`
    case "json":
      return `read_json_auto(${f})`
    case "ndjson":
      return `read_json_auto(${f}, format='newline_delimited')`
    default:
      throw new Error(`Format "${doc.format}" cannot run in the browser engine`)
  }
}

/** Fetch + register each doc's bytes, skipping files already registered from
 *  the same org/drive/path *and revision*. Keying on the current version means
 *  an edited/re-uploaded file at the same path re-registers instead of serving
 *  a stale buffer. */
async function ensureRegistered(
  db: duckdb.AsyncDuckDB,
  docs: BoundDoc[],
  ctx: SqlEngineContext,
): Promise<void> {
  for (const doc of docs) {
    const name = virtualName(doc.path)
    // Resolve a revision token. If stat fails, fall back to a unique value so we
    // never reuse a possibly-stale buffer.
    let revision: string
    try {
      const stat = await ctx.client.callOp<{ currentVersion?: number; modifiedAt?: string }>(
        ctx.orgId,
        "stat",
        { path: doc.path },
        ctx.driveId,
      )
      revision = String(stat.currentVersion ?? stat.modifiedAt ?? performance.now())
    } catch {
      revision = String(performance.now())
    }
    const key = `${ctx.orgId}/${ctx.driveId}:${name}@${revision}`
    if (registeredFiles.get(name) === key) continue

    const blob = await ctx.client.fetchRaw(ctx.orgId, ctx.driveId, doc.path)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    if (registeredFiles.has(name)) {
      await db.dropFile(name).catch(() => {})
      registeredFiles.delete(name)
    }
    await db.registerFileBuffer(name, bytes)
    registeredFiles.set(name, key)
  }
}

/** Drive-path literal in table position, e.g. `FROM '/data/sales.csv'`. */
const FROM_JOIN_PATH_RE = /\b(from|join)\s+(['"])([^'"]+\.[A-Za-z0-9]+(?:\.gz)?)\2/gi

/** Rewrite FROM/JOIN drive-path literals (with or without leading slash) to the
 *  registered virtual file so `SELECT * FROM '/data/sales.csv'` works in the
 *  browser. Only table-position literals are touched — a value-position string
 *  like `WHERE source = '/data/sales.csv'` is left intact. */
function rewritePathLiterals(query: string, docs: BoundDoc[]): string {
  const byName = new Map(docs.map((d) => [virtualName(d.path), d]))
  return query.replace(FROM_JOIN_PATH_RE, (full, kw: string, _q: string, raw: string) => {
    const name = raw.replace(/^\/+/, "")
    return byName.has(name) ? `${kw} ${quoteString(name)}` : full
  })
}

/** Wrap plain SELECT-ish statements so the engine never materializes more than
 *  maxRows + 1 rows (the +1 detects truncation). Other statements run as-is
 *  and are sliced client-side. */
function withLimit(query: string, maxRows: number): string {
  const trimmed = query.trim().replace(/;+\s*$/, "")
  if (/^(select|with|from|values)\b/i.test(trimmed)) {
    return `SELECT * FROM (${trimmed}) AS __agent_fs_result LIMIT ${maxRows + 1}`
  }
  return trimmed
}

/** Convert Arrow JS values into plain JSON-safe values: BigInt -> number when
 *  within the safe range (else string), Date -> ISO string, binary -> hex,
 *  nested vectors/structs -> arrays/objects. Keeps JSON.stringify and React
 *  rendering from ever throwing. */
function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString()
  }
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) {
    const hex = Array.from(value.slice(0, 64), (b) => b.toString(16).padStart(2, "0")).join("")
    return `\\x${hex}${value.length > 64 ? "…" : ""}`
  }
  if (Array.isArray(value)) return value.map(sanitizeValue)
  if (typeof value === "object") {
    const withToJson = value as { toJSON?: () => unknown }
    if (typeof withToJson.toJSON === "function") return sanitizeValue(withToJson.toJSON())
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeValue(v)
    return out
  }
  return value
}

export async function runInBrowser(
  input: SqlRunInput,
  ctx: SqlEngineContext,
): Promise<SqlRunResult> {
  const db = await getDb()
  await ensureRegistered(db, input.docs, ctx)

  const conn = await db.connect()
  try {
    // The db instance persists across runs, so drop views from earlier runs
    // that aren't bound now (removed docs, an org/drive switch, …) — otherwise a
    // query could read a stale table that's no longer in scope.
    const current = new Set(input.docs.map((d) => d.table))
    for (const view of createdViews) {
      if (!current.has(view)) {
        await conn.query(`DROP VIEW IF EXISTS ${quoteIdent(view)}`).catch(() => {})
        createdViews.delete(view)
      }
    }

    // (Re)create one view per bound doc so `SELECT * FROM <table>` works.
    for (const doc of input.docs) {
      const reader = readerFor(doc, virtualName(doc.path))
      await conn.query(
        `CREATE OR REPLACE VIEW ${quoteIdent(doc.table)} AS SELECT * FROM ${reader}`,
      )
      createdViews.add(doc.table)
    }

    const sql = withLimit(rewritePathLiterals(input.query, input.docs), input.maxRows)
    const started = performance.now()
    const table = await conn.query(sql)
    const elapsedMs = Math.max(1, Math.round(performance.now() - started))

    // Uniquify duplicate column names and read cells by column index, so a query
    // projecting two `id`s keeps both instead of colliding on the object key.
    const fields = table.schema.fields
    const seenCols = new Map<string, number>()
    const columnNames = fields.map((f) => {
      const name = String(f.name)
      const n = seenCols.get(name) ?? 0
      seenCols.set(name, n + 1)
      return n === 0 ? name : `${name}_${n + 1}`
    })
    const columns = columnNames.map((name, i) => ({
      name,
      type: String(fields[i].type),
    }))

    const total = table.numRows
    const truncated = total > input.maxRows
    const rowCount = truncated ? input.maxRows : total
    const vectors = fields.map((_, i) => table.getChildAt(i))
    const rows: Record<string, unknown>[] = []
    for (let r = 0; r < rowCount; r++) {
      const row: Record<string, unknown> = {}
      for (let c = 0; c < columnNames.length; c++) {
        row[columnNames[c]] = sanitizeValue(vectors[c]?.get(r))
      }
      rows.push(row)
    }

    return { columns, rows, rowCount: rows.length, truncated, elapsedMs, engine: "wasm" }
  } finally {
    await conn.close()
  }
}
