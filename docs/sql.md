# SQL Queries

Run DuckDB SQL directly against documents stored in agent-fs — CSV, TSV, Parquet, Excel, JSON, NDJSON, SQLite databases, and DuckDB databases. Available as a CLI command (`agent-fs sql`), an API op (`sql`), and an MCP tool.

```bash
agent-fs sql "SELECT category, sum(amount) FROM '/finance/2026.csv' GROUP BY category"
```

## Supported formats

| Format | Extensions | Notes |
|--------|------------|-------|
| CSV | `.csv`, `.csv.gz` | Delimiter, header, and types auto-detected |
| TSV | `.tsv`, `.tab`, `.tsv.gz` | Tab-delimited |
| Parquet | `.parquet` | |
| Excel | `.xlsx` | First sheet; header auto-detected |
| JSON | `.json`, `.json.gz` | Arrays of objects or single objects |
| NDJSON | `.ndjson`, `.jsonl` (+ `.gz`) | Newline-delimited JSON |
| SQLite | `.db`, `.sqlite`, `.sqlite3` | All tables exposed — see below |
| DuckDB | `.duckdb` | Tables from the `main` schema |

## Referencing documents

There are two ways to make a document queryable:

### 1. Path literals (file formats)

Reference any stored CSV/TSV/Parquet/Excel/JSON/NDJSON document by its drive path as a quoted string, exactly like DuckDB's own file syntax:

```bash
agent-fs sql "SELECT * FROM '/data/sales.csv' WHERE amount > 100"
agent-fs sql "SELECT a.id FROM '/data/a.parquet' a JOIN '/data/b.ndjson' b USING (id)"
```

Only string literals that resolve to an existing document in the drive are bound — other strings are left untouched, so `WHERE name = 'report.csv'` works as expected.

### 2. Named table bindings

Bind documents to table names with `--table` (repeatable). Required for SQLite/DuckDB databases, and useful for readable multi-file queries:

```bash
agent-fs sql "SELECT s.name, t.tag FROM sales s JOIN tags t ON s.id = t.id" \
  -t sales=/data/sales.csv -t tags=/data/tags.parquet
```

SQLite and DuckDB databases expose every table under the binding name as a schema:

```bash
# /backups/app.db has tables `users` and `orders`
agent-fs sql "SELECT u.email, count(*) FROM app.users u JOIN app.orders o ON o.user_id = u.id GROUP BY 1" \
  -t app=/backups/app.db
```

### Making any document SQL-able (format override)

If a document doesn't have a recognized extension, override the format with a `:format` suffix (CLI) or `{ path, format }` (API/MCP):

```bash
agent-fs sql "SELECT sum(a) FROM logs" -t logs=/raw/data.txt:csv
```

Formats: `csv`, `tsv`, `parquet`, `xlsx`, `json`, `ndjson`, `sqlite`, `duckdb`.

## CLI usage

```bash
agent-fs sql [query] [options]

  -t, --table <name=path[:format]>  Bind a document as a named table (repeatable)
  --max-rows <n>                    Max rows to return (default: 1000, max: 10000)
  --json                            Output the raw result object
```

The query can also be piped via stdin:

```bash
echo "SELECT count(*) FROM '/data/events.ndjson'" | agent-fs sql
```

Multi-statement queries are supported — the result of the last statement is returned:

```bash
agent-fs sql "CREATE TABLE big AS SELECT * FROM '/data/sales.csv' WHERE amount > 100; SELECT count(*) FROM big"
```

## API usage

`sql` is a standard op on the dispatch endpoint:

```bash
curl -X POST http://localhost:7433/orgs/{orgId}/ops \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "op": "sql",
    "driveId": "<driveId>",
    "query": "SELECT s.name, t.tag FROM sales s JOIN tags t ON s.id = t.id",
    "tables": {
      "sales": "/data/sales.csv",
      "tags": { "path": "/data/tags.parquet", "format": "parquet" }
    },
    "maxRows": 1000
  }'
```

Response:

```json
{
  "columns": [{ "name": "name", "type": "VARCHAR" }, { "name": "tag", "type": "VARCHAR" }],
  "rows": [{ "name": "alpha", "tag": "aa" }],
  "rowCount": 1,
  "truncated": false,
  "files": [
    { "table": "sales", "path": "/data/sales.csv", "format": "csv" },
    { "table": "tags", "path": "/data/tags.parquet", "format": "parquet" }
  ],
  "elapsedMs": 42
}
```

Value encoding: `BIGINT`s outside JavaScript's safe integer range and timestamps/dates/UUIDs are returned as strings; decimals as numbers; lists and structs as JSON arrays/objects; blobs as `<blob N bytes>` placeholders. The op requires the `viewer` role.

The same op is exposed as the `sql` MCP tool with identical arguments.

## Web UI

The live UI has a SQL workbench at `/sql/~/{orgId}/{driveId}` — pick documents, write queries (Cmd+Enter to run), and view results as a table or quick chart. CSV/TSV/Parquet/JSON/NDJSON queries run client-side via DuckDB WASM; Excel/SQLite/DuckDB documents automatically run on the server. Open it from any queryable file via the **Query** button in the file detail view.

## Sandboxing & limits

User SQL never touches the host. Referenced documents are downloaded and materialized into an in-memory DuckDB instance during setup; before any user SQL executes, external access is disabled, the local filesystem is turned off, and the configuration is locked. SQLite files are converted in an isolated bridge instance — the instance that runs your query never loads the sqlite extension, closing its direct-I/O escape hatch. Attempts to read host paths, fetch URLs, `ATTACH`, `COPY ... TO`, or change settings fail with a `VALIDATION_ERROR`.

Server-side knobs (environment variables on the daemon/server):

| Variable | Default | Meaning |
|----------|---------|---------|
| `AGENT_FS_SQL_TIMEOUT_MS` | `30000` | Query timeout (the query is interrupted) |
| `AGENT_FS_SQL_MAX_FILE_BYTES` | `268435456` (256 MB) | Per-document size cap |
| `AGENT_FS_SQL_MEMORY_LIMIT` | `512MB` | DuckDB memory limit |

`maxRows` caps the returned rows (default 1000, max 10000); `truncated: true` signals there were more.

Note: the first query that touches an `.xlsx` or SQLite document downloads the DuckDB `excel`/`sqlite` extension on the server (cached in `~/.duckdb` afterwards), so the server needs outbound network access once.
