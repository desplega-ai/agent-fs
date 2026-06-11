import type { SqlTableBinding } from "@/api/types"
import type { SqlEngineContext, SqlRunInput, SqlRunResult } from "./types"

/** Run the query via the server's `sql` op (DuckDB on the daemon). */
export async function runOnServer(
  input: SqlRunInput,
  ctx: SqlEngineContext,
): Promise<SqlRunResult> {
  const tables: Record<string, SqlTableBinding> = {}
  for (const doc of input.docs) {
    tables[doc.table] = { path: doc.path, format: doc.format }
  }

  const result = await ctx.client.sqlQuery(ctx.orgId, ctx.driveId, {
    query: input.query,
    tables: input.docs.length > 0 ? tables : undefined,
    maxRows: input.maxRows,
  })

  return {
    columns: result.columns,
    rows: result.rows,
    rowCount: result.rowCount,
    truncated: result.truncated,
    elapsedMs: result.elapsedMs,
    engine: "server",
  }
}
