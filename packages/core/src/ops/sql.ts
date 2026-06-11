import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, and } from "drizzle-orm";
import { schema } from "../db/index.js";
import type {
  OpContext,
  SqlParams,
  SqlResult,
  SqlColumn,
  SqlBoundFile,
  SqlFormat,
} from "./types.js";
import { getS3Key } from "./versioning.js";
import { normalizePath } from "./paths.js";
import { NotFoundError, ValidationError } from "../errors.js";

const DEFAULT_MAX_ROWS = 1000;

const EXT_FORMATS: Record<string, SqlFormat> = {
  csv: "csv",
  tsv: "tsv",
  tab: "tsv",
  parquet: "parquet",
  xlsx: "xlsx",
  json: "json",
  jsonl: "ndjson",
  ndjson: "ndjson",
  db: "sqlite",
  sqlite: "sqlite",
  sqlite3: "sqlite",
  duckdb: "duckdb",
};

/** Formats DuckDB reads as plain files (referenceable as path literals in FROM). */
const FILE_FORMATS = new Set<SqlFormat>(["csv", "tsv", "parquet", "xlsx", "json", "ndjson"]);
/** Text formats DuckDB transparently decompresses when the file ends in .gz. */
const GZIPPABLE = new Set<SqlFormat>(["csv", "tsv", "json", "ndjson"]);

const LOCAL_EXT: Record<SqlFormat, string> = {
  csv: ".csv",
  tsv: ".tsv",
  parquet: ".parquet",
  xlsx: ".xlsx",
  json: ".json",
  ndjson: ".ndjson",
  sqlite: ".db",
  duckdb: ".duckdb",
};

export function detectSqlFormat(
  path: string
): { format: SqlFormat; gzip: boolean } | null {
  const name = path.toLowerCase().split("/").pop() ?? "";
  const parts = name.split(".");
  if (parts.length < 2) return null;
  let gzip = false;
  let ext = parts.pop()!;
  if (ext === "gz" && parts.length >= 2) {
    gzip = true;
    ext = parts.pop()!;
  }
  const format = EXT_FORMATS[ext];
  if (!format) return null;
  if (gzip && !GZIPPABLE.has(format)) return null;
  return { format, gzip };
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function memoryLimit(): string {
  const raw = process.env.AGENT_FS_SQL_MEMORY_LIMIT?.trim();
  if (raw && /^[0-9]+(\.[0-9]+)?\s*(B|KB|MB|GB|TB|KiB|MiB|GiB)?$/i.test(raw)) {
    return raw;
  }
  return "512MB";
}

/** SQL single-quoted string literal (paths we generate never contain quotes, but escape anyway). */
function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** SQL double-quoted identifier. */
function qid(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function readerExpr(format: SqlFormat, filePath: string): string {
  switch (format) {
    case "csv":
      return `read_csv(${lit(filePath)})`;
    case "tsv":
      return `read_csv(${lit(filePath)}, delim=E'\\t')`;
    case "parquet":
      return `read_parquet(${lit(filePath)})`;
    case "json":
    case "ndjson":
      return `read_json_auto(${lit(filePath)})`;
    case "xlsx":
      return `read_xlsx(${lit(filePath)})`;
    default:
      throw new ValidationError(`Format ${format} is not file-readable`);
  }
}

interface Binding {
  table: string;
  path: string;
  format: SqlFormat;
  gzip: boolean;
  /** True when bound from a FROM/JOIN path literal (rewritten to the table id). */
  autoBound?: boolean;
  localFile?: string;
  size: number;
}

const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A quoted path literal in table position (after FROM or JOIN), e.g.
// `FROM '/data/sales.csv'`. Restricting to table position means an ordinary
// string value like `WHERE source = '/data/sales.csv'` is never rewritten.
const FROM_JOIN_PATH_RE =
  /\b(from|join)\s+(['"])([^'"]+\.[A-Za-z0-9]+(?:\.gz)?)\2/gi;

/** True when `path` is a gzipped file and `format` can read gzip. */
function isGzip(path: string, format: SqlFormat): boolean {
  return /\.gz$/i.test(path) && GZIPPABLE.has(format);
}

function findFile(
  ctx: OpContext,
  path: string
): { path: string; size: number } | null {
  const row = ctx.db
    .select({ path: schema.files.path, size: schema.files.size })
    .from(schema.files)
    .where(
      and(
        eq(schema.files.driveId, ctx.driveId),
        eq(schema.files.path, path),
        eq(schema.files.isDeleted, false)
      )
    )
    .get();
  return row ?? null;
}

function collectBindings(ctx: OpContext, params: SqlParams): Binding[] {
  const bindings: Binding[] = [];
  const usedNames = new Set<string>();

  for (const [name, value] of Object.entries(params.tables ?? {})) {
    if (!TABLE_NAME_RE.test(name)) {
      throw new ValidationError(`Invalid table name: ${name}`, {
        field: "tables",
        suggestion: "Table names must match [A-Za-z_][A-Za-z0-9_]*",
      });
    }
    if (usedNames.has(name.toLowerCase())) {
      throw new ValidationError(`Duplicate table name: ${name}`, { field: "tables" });
    }
    usedNames.add(name.toLowerCase());

    const path = normalizePath(typeof value === "string" ? value : value.path);
    const explicitFormat = typeof value === "string" ? undefined : value.format;
    const detected = detectSqlFormat(path);
    const format = explicitFormat ?? detected?.format;
    if (!format) {
      throw new ValidationError(
        `Cannot infer format for ${path}`,
        {
          field: "tables",
          suggestion:
            "Pass an explicit format: { path, format: \"csv\" | \"tsv\" | \"parquet\" | \"xlsx\" | \"json\" | \"ndjson\" | \"sqlite\" | \"duckdb\" }",
        }
      );
    }

    const file = findFile(ctx, path);
    if (!file) {
      throw new NotFoundError(`File not found: ${path}`, { path });
    }
    bindings.push({
      table: name,
      path,
      format,
      // Honor a real .gz suffix even when the format is overridden, so the temp
      // file keeps its .gz extension and DuckDB decompresses it.
      gzip: isGzip(path, format),
      size: file.size,
    });
  }

  // Auto-bind drive-path literals that sit in table position, like
  // `SELECT * FROM '/data/sales.csv'`. Only literals that resolve to an existing
  // document are bound; a path that merely appears as a string value elsewhere
  // (e.g. `WHERE source = '/data/sales.csv'`) is never matched here.
  const seenPaths = new Set<string>();
  let docIdx = 1;
  for (const match of params.query.matchAll(FROM_JOIN_PATH_RE)) {
    const raw = match[3];
    const detected = detectSqlFormat(raw);
    if (!detected || !FILE_FORMATS.has(detected.format)) continue;

    const path = normalizePath(raw);
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);

    const file = findFile(ctx, path);
    if (!file) continue;

    let name = `doc_${docIdx++}`;
    while (usedNames.has(name)) name = `doc_${docIdx++}`;
    usedNames.add(name);

    bindings.push({
      table: name,
      path,
      format: detected.format,
      gzip: detected.gzip,
      autoBound: true,
      size: file.size,
    });
  }

  return bindings;
}

/**
 * Convert DuckDB result values into JSON-safe values:
 * BIGINT -> number (or string when outside the safe integer range),
 * DECIMAL -> number, LIST/ARRAY -> array, STRUCT -> object, MAP -> entry list,
 * BLOB -> placeholder, everything else (timestamps, dates, uuid, ...) -> string.
 */
function toJsonValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "bigint") {
    const b = v as bigint;
    return b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(b)
      : b.toString();
  }
  if (t === "number" || t === "string" || t === "boolean") return v;
  if (v instanceof Uint8Array) return `<blob ${v.byteLength} bytes>`;
  const obj = v as Record<string, unknown>;
  if (typeof (obj as { toDouble?: unknown }).toDouble === "function") {
    return (obj as { toDouble: () => number }).toDouble();
  }
  if (obj.bytes instanceof Uint8Array) {
    return `<blob ${obj.bytes.byteLength} bytes>`;
  }
  if (Array.isArray(obj.items)) {
    return obj.items.map(toJsonValue);
  }
  if (Array.isArray(obj.entries)) {
    return obj.entries.map((e: { key: unknown; value: unknown }) => ({
      key: toJsonValue(e.key),
      value: toJsonValue(e.value),
    }));
  }
  if (obj.entries && typeof obj.entries === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(obj.entries as Record<string, unknown>)) {
      out[k] = toJsonValue(val);
    }
    return out;
  }
  return String(v);
}

function wrapDuckDbError(err: unknown, timedOut: boolean, timeoutMs: number): ValidationError {
  if (timedOut) {
    return new ValidationError(`Query timed out after ${timeoutMs}ms`, {
      suggestion: "Simplify the query or reduce the amount of data it scans",
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/disabled by configuration|has been locked|external access/i.test(message)) {
    return new ValidationError(message, {
      suggestion:
        "Queries can only access bound documents. Reference documents by drive path (e.g. FROM '/data/sales.csv') or bind them via `tables` — and check the path exists with `ls`.",
    });
  }
  return new ValidationError(message);
}

/**
 * Run a DuckDB SQL query over documents stored in the drive.
 *
 * Security model (the hosted API is multitenant, so user SQL is untrusted):
 * all referenced documents are materialized into in-memory tables during a
 * setup phase, then the local filesystem is disabled and the configuration is
 * locked BEFORE any user SQL runs. SQLite databases are converted through a
 * separate bridge instance because the sqlite extension performs its own file
 * I/O and bypasses DuckDB's filesystem sandbox — the instance that executes
 * user SQL never loads it.
 */
export async function sql(ctx: OpContext, params: SqlParams): Promise<SqlResult> {
  const started = Date.now();
  const maxRows = params.maxRows ?? DEFAULT_MAX_ROWS;
  const timeoutMs = envInt("AGENT_FS_SQL_TIMEOUT_MS", 30_000);
  const maxFileBytes = envInt("AGENT_FS_SQL_MAX_FILE_BYTES", 256 * 1024 * 1024);

  const bindings = collectBindings(ctx, params);
  for (const b of bindings) {
    if (b.size > maxFileBytes) {
      throw new ValidationError(
        `File too large for SQL: ${b.path} (${b.size} bytes, limit ${maxFileBytes})`,
        { suggestion: "Raise AGENT_FS_SQL_MAX_FILE_BYTES on the server if needed" }
      );
    }
  }

  const { DuckDBInstance } = await import("@duckdb/node-api");

  let tempDir: string | null = null;
  let instance: Awaited<ReturnType<typeof DuckDBInstance.create>> | null = null;
  let conn: Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>["connect"]>> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Arm the deadline before any work so it covers the whole operation —
  // downloads, extension loads, the sqlite bridge, and materialization — not
  // just the final query. Interrupting the connection stops in-flight DuckDB
  // work; the boundary checks below stop between phases (e.g. during S3 I/O,
  // where there is no connection to interrupt).
  let timedOut = false;
  timer = setTimeout(() => {
    timedOut = true;
    try {
      conn?.interrupt();
    } catch {
      // ignore — not connected yet, or already closed
    }
  }, timeoutMs);
  const checkTimeout = () => {
    if (timedOut) {
      throw new ValidationError(`Query timed out after ${timeoutMs}ms`, {
        suggestion: "Reduce the amount of data the query loads or scans",
      });
    }
  };

  try {
    // --- Download phase ---
    if (bindings.length > 0) {
      tempDir = await mkdtemp(join(tmpdir(), "agent-fs-sql-"));
      for (let i = 0; i < bindings.length; i++) {
        const b = bindings[i];
        const ext = LOCAL_EXT[b.format] + (b.gzip ? ".gz" : "");
        const localFile = join(tempDir, `t${i}${ext}`);
        try {
          const obj = await ctx.s3.getObject(getS3Key(ctx.orgId, ctx.driveId, b.path));
          await writeFile(localFile, obj.body);
        } catch (err: unknown) {
          const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
          if (e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) {
            throw new NotFoundError(`File not found: ${b.path}`, { path: b.path });
          }
          throw err;
        }
        b.localFile = localFile;
        checkTimeout();
      }
    }

    // --- Setup phase: materialize every binding into in-memory tables ---
    instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    await conn.run(`SET memory_limit=${lit(memoryLimit())}`);

    if (bindings.some((b) => b.format === "xlsx")) {
      await conn.run("INSTALL excel");
      await conn.run("LOAD excel");
    }

    const sqliteBindings = bindings.filter((b) => b.format === "sqlite");
    let sqliteTables = new Map<string, Array<{ table: string; parquetFile: string }>>();
    if (sqliteBindings.length > 0 && tempDir) {
      sqliteTables = await bridgeSqliteToParquet(
        DuckDBInstance,
        sqliteBindings,
        tempDir,
        checkTimeout
      );
    }
    checkTimeout();

    for (const b of bindings) {
      try {
        if (b.format === "sqlite") {
          await conn.run(`CREATE SCHEMA ${qid(b.table)}`);
          for (const { table, parquetFile } of sqliteTables.get(b.table) ?? []) {
            await conn.run(
              `CREATE TABLE ${qid(b.table)}.${qid(table)} AS SELECT * FROM read_parquet(${lit(parquetFile)})`
            );
          }
        } else if (b.format === "duckdb") {
          const alias = `src_${b.table}`;
          await conn.run(`ATTACH ${lit(b.localFile!)} AS ${qid(alias)} (READ_ONLY)`);
          const reader = await conn.runAndReadAll(
            `SELECT table_name FROM duckdb_tables() WHERE database_name = ${lit(alias)} AND schema_name = 'main'`
          );
          const tables = reader
            .getRowObjectsJson()
            .map((r) => String(r.table_name));
          if (tables.length === 0) {
            throw new ValidationError(`No tables found in ${b.path}`);
          }
          await conn.run(`CREATE SCHEMA ${qid(b.table)}`);
          for (const table of tables) {
            await conn.run(
              `CREATE TABLE ${qid(b.table)}.${qid(table)} AS SELECT * FROM ${qid(alias)}.main.${qid(table)}`
            );
          }
          await conn.run(`DETACH ${qid(alias)}`);
        } else {
          await conn.run(
            `CREATE TABLE ${qid(b.table)} AS SELECT * FROM ${readerExpr(b.format, b.localFile!)}`
          );
        }
      } catch (err: unknown) {
        if (err instanceof ValidationError) throw err;
        // A timeout fired mid-materialization surfaces as a clean timeout error.
        checkTimeout();
        const message = err instanceof Error ? err.message : String(err);
        throw new ValidationError(`Failed to load ${b.path} as ${b.format}: ${message}`);
      }
    }
    checkTimeout();

    // --- Lockdown phase: no file or network access for user SQL ---
    await conn.run("SET enable_external_access=false");
    await conn.run("SET disabled_filesystems='LocalFileSystem'");
    await conn.run("SET lock_configuration=true");

    // Everything is materialized in memory — drop the temp files before
    // running any user SQL.
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }

    // --- Query phase ---
    // Rewrite only FROM/JOIN path literals (never value-position strings) to the
    // in-memory table they were bound to.
    const autoBound = new Map(
      bindings.filter((b) => b.autoBound).map((b) => [b.path, b.table])
    );
    const query = params.query.replace(
      FROM_JOIN_PATH_RE,
      (full, kw: string, _q: string, raw: string) => {
        const table = autoBound.get(normalizePath(raw));
        return table ? `${kw} ${qid(table)}` : full;
      }
    );

    try {
      const extracted = await conn.extractStatements(query);
      if (extracted.count === 0) {
        throw new ValidationError("Query contains no statements", { field: "query" });
      }
      for (let i = 0; i < extracted.count - 1; i++) {
        const prepared = await extracted.prepare(i);
        await prepared.run();
      }
      const prepared = await extracted.prepare(extracted.count - 1);
      const reader = await prepared.runAndReadUntil(maxRows + 1);

      // Uniquify duplicate column names (e.g. a join projecting two `id`s) so
      // building row objects never drops data by key collision.
      const seenCols = new Map<string, number>();
      const columnNames = reader.columnNames().map((name) => {
        const n = seenCols.get(name) ?? 0;
        seenCols.set(name, n + 1);
        return n === 0 ? name : `${name}_${n + 1}`;
      });
      const columnTypes = reader.columnTypes();
      const columns: SqlColumn[] = columnNames.map((name, i) => ({
        name,
        type: String(columnTypes[i] ?? "UNKNOWN"),
      }));

      const raw = reader.getRows();
      const truncated = raw.length > maxRows || !reader.done;
      const rows = raw.slice(0, maxRows).map((values) => {
        const row: Record<string, unknown> = {};
        for (let i = 0; i < columnNames.length; i++) {
          row[columnNames[i]] = toJsonValue(values[i]);
        }
        return row;
      });

      const files: SqlBoundFile[] = bindings.map((b) => ({
        table: b.table,
        path: b.path,
        format: b.format,
      }));

      return {
        columns,
        rows,
        rowCount: rows.length,
        truncated,
        files,
        elapsedMs: Date.now() - started,
      };
    } catch (err: unknown) {
      if (err instanceof ValidationError) throw err;
      throw wrapDuckDbError(err, timedOut, timeoutMs);
    }
  } finally {
    if (timer) clearTimeout(timer);
    try {
      conn?.closeSync();
    } catch {
      // ignore
    }
    try {
      instance?.closeSync();
    } catch {
      // ignore
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Convert each table of the given SQLite databases to Parquet files using a
 * throwaway DuckDB instance. Returns binding table name -> entries consumed by
 * the main instance. The bridge instance is the only place the sqlite
 * extension is ever loaded.
 */
async function bridgeSqliteToParquet(
  DuckDBInstance: typeof import("@duckdb/node-api").DuckDBInstance,
  bindings: Binding[],
  tempDir: string,
  checkTimeout: () => void
): Promise<Map<string, Array<{ table: string; parquetFile: string }>>> {
  const result = new Map<string, Array<{ table: string; parquetFile: string }>>();
  const bridge = await DuckDBInstance.create(":memory:");
  const conn = await bridge.connect();
  try {
    await conn.run("INSTALL sqlite");
    await conn.run("LOAD sqlite");
    for (let i = 0; i < bindings.length; i++) {
      const b = bindings[i];
      try {
        checkTimeout();
        await conn.run(`ATTACH ${lit(b.localFile!)} AS src (TYPE sqlite, READ_ONLY)`);
        const reader = await conn.runAndReadAll(
          "SELECT table_name FROM duckdb_tables() WHERE database_name = 'src'"
        );
        const tables = reader.getRowObjectsJson().map((r) => String(r.table_name));
        if (tables.length === 0) {
          throw new ValidationError(`No tables found in ${b.path}`);
        }
        const entries: Array<{ table: string; parquetFile: string }> = [];
        for (let j = 0; j < tables.length; j++) {
          checkTimeout();
          const parquetFile = join(tempDir, `sq_${i}_${j}.parquet`);
          await conn.run(
            `COPY (SELECT * FROM src.${qid(tables[j])}) TO ${lit(parquetFile)} (FORMAT parquet)`
          );
          entries.push({ table: tables[j], parquetFile });
        }
        result.set(b.table, entries);
        await conn.run("DETACH src");
      } catch (err: unknown) {
        if (err instanceof ValidationError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new ValidationError(`Failed to load ${b.path} as sqlite: ${message}`);
      }
    }
  } finally {
    try {
      conn.closeSync();
    } catch {
      // ignore
    }
    try {
      bridge.closeSync();
    } catch {
      // ignore
    }
  }
  return result;
}
