import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
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
import { assertPathInsideDrive, normalizePath } from "./paths.js";
import { glob } from "./glob.js";
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

/**
 * A DuckDB reader call. `source` is SQL: one string literal, or a list literal
 * for the readers that take one (every file format except xlsx).
 */
function readerCall(format: SqlFormat, source: string, options: string[] = []): string {
  const call = (fn: string, extra: string[] = []) =>
    `${fn}(${[source, ...extra, ...options].join(", ")})`;
  switch (format) {
    case "csv":
      return call("read_csv");
    case "tsv":
      return call("read_csv", ["delim=E'\\t'"]);
    case "parquet":
      return call("read_parquet");
    case "json":
    case "ndjson":
      return call("read_json_auto");
    case "xlsx":
      return call("read_xlsx");
    default:
      throw new ValidationError(`Format ${format} is not file-readable`);
  }
}

/** One stored document behind a binding. */
interface BoundSource {
  /** Drive path. */
  path: string;
  size: number;
  gzip: boolean;
  /** Temp file it was downloaded to. Never shown to the caller. */
  localFile?: string;
}

interface Binding {
  table: string;
  /** Drive path, or the normalized pattern for a glob. */
  path: string;
  format: SqlFormat;
  /** True when bound from a FROM/JOIN path literal (rewritten to the table id). */
  autoBound?: boolean;
  /** True when `path` is a glob: every match is read into one table. */
  glob?: boolean;
  /** Add a `filename` column with each row's drive path. */
  includeFilename?: boolean;
  /** One entry for a document, every match (sorted by path) for a glob. */
  sources: BoundSource[];
}

/**
 * The SELECT that materializes a file-format binding. A glob reads all of its
 * files as one table with columns unified by name. The optional `filename`
 * column carries drive paths; the temp paths DuckDB reads never reach it.
 */
function bindingSelect(b: Binding): string {
  const first = b.sources[0];
  if (!b.glob && !b.includeFilename) {
    return `SELECT * FROM ${readerCall(b.format, lit(first.localFile!))}`;
  }
  if (b.format === "xlsx") {
    // read_xlsx takes one file only: union the per-file reads by column name.
    return b.sources
      .map((s) => {
        const name = b.includeFilename ? `, ${lit(s.path)} AS filename` : "";
        return `SELECT *${name} FROM ${readerCall("xlsx", lit(s.localFile!))}`;
      })
      .join(" UNION ALL BY NAME ");
  }
  const list = `[${b.sources.map((s) => lit(s.localFile!)).join(", ")}]`;
  if (!b.includeFilename) {
    return `SELECT * FROM ${readerCall(b.format, list, ["union_by_name=true"])}`;
  }
  // No ELSE branch: an unmapped value becomes NULL rather than a temp path.
  const cases = b.sources
    .map((s) => `WHEN ${lit(s.localFile!)} THEN ${lit(s.path)}`)
    .join(" ");
  return `SELECT * REPLACE (CASE filename ${cases} END AS filename) FROM ${readerCall(
    b.format,
    list,
    ["union_by_name=true", "filename=true"]
  )}`;
}

/** Replace temp paths in a DuckDB error with the drive paths they hold. */
function scrubTempPaths(message: string, b: Binding, tempDir: string | null): string {
  let out = message;
  for (const s of b.sources) {
    if (s.localFile) out = out.split(s.localFile).join(s.path);
  }
  return tempDir ? out.split(tempDir).join("<tmp>") : out;
}

const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A quoted path literal in table position (after FROM or JOIN), e.g.
// `FROM '/data/sales.csv'`. Restricting to table position means an ordinary
// string value like `WHERE source = '/data/sales.csv'` is never rewritten.
// The second alternative takes a glob without an extension (`'/lake/*'`). Its
// first class excludes the wildcards, so the split point is unique and the
// match stays linear in the literal's length.
const FROM_JOIN_PATH_RE =
  /\b(from|join)\s+(['"])([^'"]+\.[A-Za-z0-9]+(?:\.gz)?|[^'"*?]*[*?][^'"]*)\2/gi;

const GLOB_CHARS_RE = /[*?]/;

/**
 * True when a FROM/JOIN literal is a drive glob. It needs a `/` or a known
 * extension, so a double-quoted identifier like `"t?"` is left alone.
 */
function isGlobLiteral(raw: string): boolean {
  return GLOB_CHARS_RE.test(raw) && (raw.includes("/") || detectSqlFormat(raw) !== null);
}

/**
 * Normalize a glob to an absolute drive path. `.` and `..` segments resolve
 * and stop at the drive root, so `/../*` reads `/*`, never a path outside it.
 * Returns the pattern and its split at the first segment with a wildcard.
 */
function normalizeGlob(raw: string): { pattern: string; prefix: string; rest: string } {
  let pattern = posix.normalize(`/${raw}`);
  if (pattern.length > 1 && pattern.endsWith("/")) pattern = pattern.slice(0, -1);
  // Refuses NUL bytes and `..` hidden behind a backslash separator.
  assertPathInsideDrive(pattern);
  const segments = pattern.slice(1).split("/");
  const idx = segments.findIndex((seg) => GLOB_CHARS_RE.test(seg));
  const head = segments.slice(0, idx);
  return {
    pattern,
    prefix: head.length > 0 ? `/${head.join("/")}/` : "/",
    rest: segments.slice(idx).join("/"),
  };
}

/** Key a FROM/JOIN literal by the drive path or pattern it binds. */
function literalKey(raw: string): string {
  return isGlobLiteral(raw) ? normalizeGlob(raw).pattern : normalizePath(raw);
}

/** True when `path` is a gzipped file and `format` can read gzip. */
function isGzip(path: string, format: SqlFormat): boolean {
  return /\.gz$/i.test(path) && GZIPPABLE.has(format);
}

function findFileByPath(
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

const FILE_FORMAT_LIST = "csv, tsv, parquet, xlsx, json, ndjson";

/**
 * Resolve a glob through the `glob` op into the live documents it matches, all
 * of one file format. No match is a NotFoundError; mixed or unknown formats,
 * database formats and more than AGENT_FS_SQL_MAX_GLOB_FILES matches are
 * refused.
 */
async function resolveGlob(
  ctx: OpContext,
  raw: string,
  explicitFormat: SqlFormat | undefined
): Promise<{ pattern: string; format: SqlFormat; sources: BoundSource[] }> {
  const maxFiles = envInt("AGENT_FS_SQL_MAX_GLOB_FILES", 200);
  const { pattern, prefix, rest } = normalizeGlob(raw);
  const { matches } = await glob(ctx, { pattern: rest, path: prefix });
  matches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const found: Array<{ path: string; size: number }> = [];
  for (const m of matches) {
    // The listing comes from storage; only paths with a live document count.
    const file = findFileByPath(ctx, m.path);
    if (!file) continue;
    found.push({ path: m.path, size: file.size });
    if (found.length > maxFiles) {
      throw new ValidationError(`Glob ${pattern} matches more than ${maxFiles} files`, {
        field: "query",
        suggestion: "Narrow the pattern, or raise AGENT_FS_SQL_MAX_GLOB_FILES on the server",
      });
    }
  }
  if (found.length === 0) {
    throw new NotFoundError(`No files match ${pattern}`, { path: pattern });
  }

  let format = explicitFormat;
  if (!format) {
    const formats = new Set<SqlFormat>();
    for (const f of found) {
      const detected = detectSqlFormat(f.path);
      if (!detected) {
        throw new ValidationError(
          `Cannot infer format for ${f.path}, matched by ${pattern}`,
          {
            field: "query",
            suggestion: "Narrow the pattern to one extension (e.g. /lake/*.csv), or bind it via `tables` with an explicit format",
          }
        );
      }
      formats.add(detected.format);
    }
    if (formats.size > 1) {
      throw new ValidationError(
        `Glob ${pattern} matches files of more than one format (${[...formats].sort().join(", ")})`,
        {
          field: "query",
          suggestion: "Narrow the pattern to one extension, e.g. /lake/*.csv",
        }
      );
    }
    format = [...formats][0];
  }
  if (!FILE_FORMATS.has(format)) {
    throw new ValidationError(`Glob reads support ${FILE_FORMAT_LIST} files, not ${format}`, {
      field: "query",
      suggestion: "Bind each sqlite or duckdb database by name via `tables`",
    });
  }
  const resolved = format;
  return {
    pattern,
    format: resolved,
    sources: found.map((f) => ({ path: f.path, size: f.size, gzip: isGzip(f.path, resolved) })),
  };
}

async function collectBindings(ctx: OpContext, params: SqlParams): Promise<Binding[]> {
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

    const rawPath = typeof value === "string" ? value : value.path;
    const explicitFormat = typeof value === "string" ? undefined : value.format;
    const includeFilename = typeof value === "string" ? false : value.includeFilename === true;

    if (GLOB_CHARS_RE.test(rawPath)) {
      const resolved = await resolveGlob(ctx, rawPath, explicitFormat);
      bindings.push({
        table: name,
        path: resolved.pattern,
        format: resolved.format,
        glob: true,
        includeFilename,
        sources: resolved.sources,
      });
      continue;
    }

    const path = normalizePath(rawPath);
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

    if (includeFilename && !FILE_FORMATS.has(format)) {
      throw new ValidationError(`includeFilename needs a file format, not ${format}`, {
        field: "tables",
      });
    }

    const file = findFileByPath(ctx, path);
    if (!file) {
      throw new NotFoundError(`File not found: ${path}`, { path });
    }
    bindings.push({
      table: name,
      path,
      format,
      includeFilename,
      sources: [
        {
          path,
          size: file.size,
          // Honor a real .gz suffix even when the format is overridden, so the
          // temp file keeps its .gz extension and DuckDB decompresses it.
          gzip: isGzip(path, format),
        },
      ],
    });
  }

  // Auto-bind drive-path literals that sit in table position, like
  // `SELECT * FROM '/data/sales.csv'`. Only literals that resolve to an existing
  // document are bound; a path that merely appears as a string value elsewhere
  // (e.g. `WHERE source = '/data/sales.csv'`) is never matched here. A glob
  // literal binds every match, and fails when nothing matches.
  const seenPaths = new Set<string>();
  let docIdx = 1;
  const nextName = () => {
    let name = `doc_${docIdx++}`;
    while (usedNames.has(name)) name = `doc_${docIdx++}`;
    usedNames.add(name);
    return name;
  };
  for (const match of params.query.matchAll(FROM_JOIN_PATH_RE)) {
    const raw = match[3];
    if (isGlobLiteral(raw)) {
      const key = literalKey(raw);
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      const resolved = await resolveGlob(ctx, raw, undefined);
      bindings.push({
        table: nextName(),
        path: resolved.pattern,
        format: resolved.format,
        autoBound: true,
        glob: true,
        sources: resolved.sources,
      });
      continue;
    }
    if (GLOB_CHARS_RE.test(raw)) continue;

    const detected = detectSqlFormat(raw);
    if (!detected || !FILE_FORMATS.has(detected.format)) continue;

    const path = normalizePath(raw);
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);

    const file = findFileByPath(ctx, path);
    if (!file) continue;

    bindings.push({
      table: nextName(),
      path,
      format: detected.format,
      autoBound: true,
      sources: [{ path, size: file.size, gzip: detected.gzip }],
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

/** Approximate JSON size of a string in UTF-8 bytes, counting escapes. */
function jsonStringSize(s: string): number {
  let n = s.length + 2;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20) n += 5; // worst case \uXXXX
    else if (c === 0x22 || c === 0x5c) n += 1; // \" and \\
    else if (c >= 0x800) n += 2; // 3 UTF-8 bytes (a surrogate pair totals 4)
    else if (c >= 0x80) n += 1; // 2 UTF-8 bytes
  }
  return n;
}

/** Approximate JSON size of a value produced by toJsonValue. */
function jsonSize(v: unknown): number {
  if (typeof v === "string") return jsonStringSize(v);
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + jsonSize(x) + 1, 2);
  if (v && typeof v === "object") {
    let n = 2;
    for (const [k, x] of Object.entries(v)) n += k.length + 4 + jsonSize(x);
    return n;
  }
  return 8;
}

// Each query opens its own DuckDB instance with its own memory limit, so the
// number in flight is what bounds the process total.
let activeQueries = 0;

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
  const maxConcurrent = envInt("AGENT_FS_SQL_MAX_CONCURRENT", 4);
  if (activeQueries >= maxConcurrent) {
    throw new ValidationError(`Too many SQL queries running (limit ${maxConcurrent})`, {
      suggestion: "Retry when a running query finishes",
    });
  }
  activeQueries++;
  try {
    return await runSql(ctx, params);
  } finally {
    activeQueries--;
  }
}

async function runSql(ctx: OpContext, params: SqlParams): Promise<SqlResult> {
  const started = Date.now();
  const maxRows = params.maxRows ?? DEFAULT_MAX_ROWS;
  const timeoutMs = envInt("AGENT_FS_SQL_TIMEOUT_MS", 30_000);
  const maxFileBytes = envInt("AGENT_FS_SQL_MAX_FILE_BYTES", 256 * 1024 * 1024);
  const maxResultBytes = envInt("AGENT_FS_SQL_MAX_RESULT_BYTES", 16 * 1024 * 1024);

  const maxTotalBytes = envInt("AGENT_FS_SQL_MAX_TOTAL_BYTES", 512 * 1024 * 1024);

  const { DuckDBInstance } = await import("@duckdb/node-api");

  let tempDir: string | null = null;
  let instance: Awaited<ReturnType<typeof DuckDBInstance.create>> | null = null;
  let conn: Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>["connect"]>> | null = null;
  // The bridge runs on its own connection; track it so the deadline can
  // interrupt an in-flight sqlite -> parquet COPY too.
  let bridgeConn: { interrupt: () => void } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Arm the deadline before any work so it covers the whole operation —
  // downloads, extension loads, the sqlite bridge, and materialization — not
  // just the final query. Interrupting the active connection stops in-flight
  // DuckDB work; the boundary checks below stop between phases (e.g. during S3
  // I/O, where there is no connection to interrupt).
  let timedOut = false;
  const downloadAbort = new AbortController();
  const timeoutError = () =>
    new ValidationError(`Query timed out after ${timeoutMs}ms`, {
      suggestion: "Reduce the amount of data the query loads or scans",
    });
  // Rejects at the deadline, so a phase with nothing to interrupt (the glob
  // listing) still ends the operation and frees its concurrency slot.
  let rejectAtDeadline: (err: Error) => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    rejectAtDeadline = reject;
  });
  deadline.catch(() => {});
  timer = setTimeout(() => {
    timedOut = true;
    rejectAtDeadline(timeoutError());
    // Abort in-flight S3 downloads and interrupt active DuckDB connections.
    downloadAbort.abort();
    for (const c of [conn, bridgeConn]) {
      try {
        c?.interrupt();
      } catch {
        // ignore — not connected yet, or already closed
      }
    }
  }, timeoutMs);
  const checkTimeout = () => {
    if (timedOut) throw timeoutError();
  };

  try {
    // --- Binding phase: resolve paths and list globs, bounded by the deadline ---
    // shortcut: the glob op takes no abort signal, so a listing still running
    // at the deadline is abandoned (its result ignored), not cancelled; thread
    // an AbortSignal through glob -> listObjects if abandoned listings pile up.
    const listing = collectBindings(ctx, params);
    listing.catch(() => {});
    const bindings = await Promise.race([listing, deadline]);
    let totalBytes = 0;
    for (const b of bindings) {
      for (const s of b.sources) {
        if (s.size > maxFileBytes) {
          throw new ValidationError(
            `File too large for SQL: ${s.path} (${s.size} bytes, limit ${maxFileBytes})`,
            { suggestion: "Raise AGENT_FS_SQL_MAX_FILE_BYTES on the server if needed" }
          );
        }
        totalBytes += s.size;
      }
    }
    if (totalBytes > maxTotalBytes) {
      throw new ValidationError(
        `Documents too large for SQL: ${totalBytes} bytes in total, limit ${maxTotalBytes}`,
        {
          suggestion:
            "Bind fewer or smaller documents (narrow the glob), or raise AGENT_FS_SQL_MAX_TOTAL_BYTES on the server",
        }
      );
    }

    // --- Download phase ---
    if (bindings.length > 0) {
      tempDir = await mkdtemp(join(tmpdir(), "agent-fs-sql-"));
      for (let i = 0; i < bindings.length; i++) {
        const b = bindings[i];
        // Each document, including every glob match, gets its own temp file.
        for (let j = 0; j < b.sources.length; j++) {
          const s = b.sources[j];
          const ext = LOCAL_EXT[b.format] + (s.gzip ? ".gz" : "");
          const localFile = join(tempDir, `t${i}_${j}${ext}`);
          try {
            const obj = await ctx.s3.getObject(
              getS3Key(ctx.orgId, ctx.driveId, s.path),
              undefined,
              { abortSignal: downloadAbort.signal }
            );
            await writeFile(localFile, obj.body);
          } catch (err: unknown) {
            // A timeout aborts the download — surface it as a clean timeout.
            checkTimeout();
            const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
            if (e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) {
              throw new NotFoundError(`File not found: ${s.path}`, { path: s.path });
            }
            throw err;
          }
          s.localFile = localFile;
          checkTimeout();
        }
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
        checkTimeout,
        (c) => {
          bridgeConn = c;
        }
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
          await conn.run(`ATTACH ${lit(b.sources[0].localFile!)} AS ${qid(alias)} (READ_ONLY)`);
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
          await conn.run(`CREATE TABLE ${qid(b.table)} AS ${bindingSelect(b)}`);
        }
      } catch (err: unknown) {
        if (err instanceof ValidationError) throw err;
        // A timeout fired mid-materialization surfaces as a clean timeout error.
        checkTimeout();
        const message = scrubTempPaths(
          err instanceof Error ? err.message : String(err),
          b,
          tempDir
        );
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
        const table = autoBound.get(literalKey(raw));
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

      // Convert value by value against a byte budget, so a few huge computed
      // values cannot produce an unbounded JSON result. The rows already read
      // into DuckDB chunks above are not covered by this budget.
      const available = Math.min(reader.currentRowCount, maxRows);
      let truncated = reader.currentRowCount > maxRows || !reader.done;
      let resultBytes = 0;
      const rows: Record<string, unknown>[] = [];
      convert: for (let r = 0; r < available; r++) {
        const row: Record<string, unknown> = {};
        for (let i = 0; i < columnNames.length; i++) {
          const value = toJsonValue(reader.value(i, r));
          resultBytes += columnNames[i].length + 4 + jsonSize(value);
          if (resultBytes > maxResultBytes) {
            truncated = true;
            break convert;
          }
          row[columnNames[i]] = value;
        }
        rows.push(row);
      }
      if (rows.length === 0 && truncated && available > 0) {
        throw new ValidationError(
          `Result row exceeds the result size limit (${maxResultBytes} bytes)`,
          {
            suggestion:
              "Select fewer or shorter columns (e.g. left(col, 1000)), or raise AGENT_FS_SQL_MAX_RESULT_BYTES on the server",
          }
        );
      }

      const files: SqlBoundFile[] = bindings.map((b) => ({
        table: b.table,
        path: b.path,
        format: b.format,
        ...(b.glob ? { matches: b.sources.map((s) => s.path) } : {}),
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
  checkTimeout: () => void,
  registerConn: (conn: { interrupt: () => void } | null) => void
): Promise<Map<string, Array<{ table: string; parquetFile: string }>>> {
  const result = new Map<string, Array<{ table: string; parquetFile: string }>>();
  const bridge = await DuckDBInstance.create(":memory:");
  const conn = await bridge.connect();
  registerConn(conn);
  try {
    await conn.run("INSTALL sqlite");
    await conn.run("LOAD sqlite");
    for (let i = 0; i < bindings.length; i++) {
      const b = bindings[i];
      try {
        checkTimeout();
        await conn.run(`ATTACH ${lit(b.sources[0].localFile!)} AS src (TYPE sqlite, READ_ONLY)`);
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
        // A timeout interrupt surfaces as a clean timeout error.
        checkTimeout();
        const message = err instanceof Error ? err.message : String(err);
        throw new ValidationError(`Failed to load ${b.path} as sqlite: ${message}`);
      }
    }
  } finally {
    // Stop the deadline from touching a connection we're about to close.
    registerConn(null);
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
