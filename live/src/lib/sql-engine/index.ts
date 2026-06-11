import { runOnServer } from "./server"
import type { BoundDoc, SqlEngineContext, SqlRunInput, SqlRunResult } from "./types"

/** Formats DuckDB-WASM can read in the browser. xlsx (broken excel extension)
 *  and sqlite/duckdb (flaky sqlite_scanner) must run on the server. */
const WASM_FORMATS = new Set<string>(["csv", "tsv", "parquet", "json", "ndjson"])

/** Drive-path literal in table position, e.g. `FROM '/data/sales.csv'`. */
const FROM_JOIN_PATH_RE = /\b(?:from|join)\s+(['"])([^'"]+\.[A-Za-z0-9]+(?:\.gz)?)\1/gi

/**
 * True when the query can run entirely in the browser (DuckDB-WASM). Requires:
 * at least one bound doc, every bound doc readable by WASM, and no FROM/JOIN
 * drive-path literal that isn't a bound doc — only the server auto-binds bare
 * path literals, so a query referencing an unbound one must run there.
 */
export function canRunInBrowser(docs: BoundDoc[], query?: string): boolean {
  if (docs.length === 0 || !docs.every((d) => WASM_FORMATS.has(d.format))) return false
  if (query) {
    const bound = new Set(docs.map((d) => d.path.replace(/^\/+/, "")))
    for (const m of query.matchAll(FROM_JOIN_PATH_RE)) {
      if (!bound.has(m[2].replace(/^\/+/, ""))) return false
    }
  }
  return true
}

/**
 * Run a SQL query against the bound documents, picking the engine
 * automatically: browser (DuckDB-WASM) when every bound doc supports it,
 * server otherwise or when `forceServer` is set. The wasm module is
 * dynamically imported so it never affects initial page load.
 */
export async function runSql(
  input: SqlRunInput,
  ctx: SqlEngineContext,
  opts?: { forceServer?: boolean },
): Promise<SqlRunResult> {
  if (!opts?.forceServer && canRunInBrowser(input.docs, input.query)) {
    const { runInBrowser } = await import("./duckdb")
    return runInBrowser(input, ctx)
  }
  return runOnServer(input, ctx)
}

export * from "./types"
