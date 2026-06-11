import { Command } from "commander";
import type { ApiClient } from "../api-client.js";
import { getConfig, getOpDefinition } from "@/core";
import { outputResult } from "../formatters.js";

const FORMATS = new Set(["csv", "tsv", "parquet", "xlsx", "json", "ndjson", "sqlite", "duckdb"]);

/**
 * Parse a `--table name=path[:format]` binding. The trailing `:format` is only
 * treated as a format override when it matches a known format name, so paths
 * containing colons keep working.
 */
export function parseTableBinding(
  raw: string
): { name: string; value: string | { path: string; format: string } } {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    throw new Error(`Invalid --table binding: ${raw} (expected name=path[:format])`);
  }
  const name = raw.slice(0, eq);
  const rest = raw.slice(eq + 1);
  const colon = rest.lastIndexOf(":");
  if (colon > 0) {
    const maybeFormat = rest.slice(colon + 1).toLowerCase();
    if (FORMATS.has(maybeFormat)) {
      return { name, value: { path: rest.slice(0, colon), format: maybeFormat } };
    }
  }
  return { name, value: rest };
}

export function sqlCommand(
  program: Command,
  client: ApiClient,
  getOrgId: () => string | Promise<string>
): Command {
  const cmd = new Command("sql")
    .description(
      getOpDefinition("sql")?.description ??
        "Run a DuckDB SQL query over documents stored in the drive"
    )
    .argument("[query]", "SQL query (reads stdin if omitted)")
    .option(
      "-t, --table <name=path[:format]>",
      "Bind a document as a named table (repeatable). Append :format to override detection, e.g. logs=/raw/data.txt:csv",
      (value: string, prev: string[]) => [...prev, value],
      [] as string[]
    )
    .option("--max-rows <n>", "Max rows to return (default: 1000, max: 10000)")
    .addHelpText(
      "after",
      `
Examples:
  agent-fs sql "SELECT * FROM '/data/sales.csv' LIMIT 10"
  agent-fs sql "SELECT s.name, t.tag FROM sales s JOIN tags t ON s.id = t.id" \\
    -t sales=/data/sales.csv -t tags=/data/tags.parquet
  agent-fs sql "SELECT * FROM app.users" -t app=/backups/app.db
  agent-fs sql "SELECT sum(a) FROM logs" -t logs=/raw/data.txt:csv
  echo "SELECT count(*) FROM '/data/events.ndjson'" | agent-fs sql
`
    )
    .action(async (queryArg: string | undefined, opts: { table: string[]; maxRows?: string }) => {
      let query = queryArg;
      if (query === undefined) {
        if (!process.stdin.isTTY) {
          query = (await Bun.stdin.text()).trim();
        }
        if (!query) {
          console.error("Error: query required (as argument or via stdin)");
          process.exit(1);
        }
      }

      const params: Record<string, any> = { query };

      if (opts.table.length > 0) {
        const tables: Record<string, unknown> = {};
        for (const raw of opts.table) {
          try {
            const { name, value } = parseTableBinding(raw);
            tables[name] = value;
          } catch (err: any) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
          }
        }
        params.tables = tables;
      }

      if (opts.maxRows !== undefined) {
        params.maxRows = parseInt(opts.maxRows);
      }

      try {
        const orgId = await getOrgId();
        const driveId = program.opts().drive ?? getConfig().defaultDrive;
        if (driveId) {
          params.driveId = driveId;
        }
        const result = await client.callOp(orgId, "sql", params);
        outputResult("sql", result, program.opts().json);
      } catch (err: any) {
        if (err?.cause?.code === "ECONNREFUSED" || err?.message?.includes("fetch failed")) {
          console.error(
            "Cannot connect to agent-fs daemon.\n" +
            "Start with: agent-fs daemon start\n" +
            "Or set AGENT_FS_API_URL to connect to a remote server."
          );
          process.exit(1);
        }
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  return cmd;
}
