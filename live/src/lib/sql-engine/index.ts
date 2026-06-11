import { runOnServer } from "./server"
import type { BoundDoc, SqlEngineContext, SqlRunInput, SqlRunResult } from "./types"

/** Formats DuckDB-WASM can read in the browser. xlsx (broken excel extension)
 *  and sqlite/duckdb (flaky sqlite_scanner) must run on the server. */
const WASM_FORMATS = new Set<string>(["csv", "tsv", "parquet", "json", "ndjson"])

/**
 * True when every bound doc can be read by DuckDB-WASM in the browser. With no
 * bound docs the query can only reference drive paths directly, which only the
 * server resolves — so an empty doc set also routes to the server.
 */
export function canRunInBrowser(docs: BoundDoc[]): boolean {
  return docs.length > 0 && docs.every((d) => WASM_FORMATS.has(d.format))
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
  if (!opts?.forceServer && canRunInBrowser(input.docs)) {
    const { runInBrowser } = await import("./duckdb")
    return runInBrowser(input, ctx)
  }
  return runOnServer(input, ctx)
}

export * from "./types"
