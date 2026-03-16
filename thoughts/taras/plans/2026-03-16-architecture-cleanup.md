---
date: 2026-03-16
planner: Claude
topic: architecture-cleanup
status: completed
source: thoughts/taras/research/2026-03-15-architecture-review.md
autonomy: critical
---

# Architecture Cleanup Implementation Plan

## Overview

Implement the non-rejected action items from the architecture review: consolidate duplicated bootstrap logic, remove the fake MCP daemon mode, clean up the op set (remove `head`/`mkdir`, rename `find` → `fts`), add new `tree` and `glob` operations, add rich MCP tool descriptions, add CLI pretty-print formatting with `--json` flag, and fix the `drive invite` naming inconsistency.

## Current State Analysis

- **20 operations** in `packages/core/src/ops/index.ts:30-167`, registered as `{ handler, schema }` pairs
- **MCP tools** generated in `packages/mcp/src/tools.ts:19-37` with generic `"agentfs {opName}"` descriptions — no useful context for LLMs
- **Auto-bootstrap** duplicated in 3 places: `packages/mcp/src/server.ts:26-39`, `packages/cli/src/embedded.ts:28-32`, `packages/cli/src/commands/init.ts:34-47`
- **MCP daemon mode** in `packages/mcp/src/index.ts:9-24` auto-detects daemon but `server.ts:115-138` creates its own local DB/S3 — never proxies to the HTTP daemon
- **CLI output** is always `JSON.stringify(result, null, 2)` at `packages/cli/src/commands/ops.ts:98`
- **CLI command definitions** are hand-maintained in `OP_COMMANDS` array at `packages/cli/src/commands/ops.ts:12-33`, separate from the core registry
- **RBAC** maps ops to roles in `packages/core/src/identity/rbac.ts:15-36` — includes `head`, `mkdir`, `find`
- **Types** defined in `packages/core/src/ops/types.ts` — includes `HeadParams`, `MkdirParams`, `MkdirResult`
- **Re-exports** in `packages/core/src/ops/index.ts:203` and `packages/core/src/index.ts:29-33`

### Key Discoveries:
- `head.ts` is 15 lines, just calls `cat(ctx, { path, offset: 0, limit: lines ?? 20 })` — zero added value
- `mkdir.ts` is 15 lines, creates a zero-byte S3 marker with no SQLite record, no version, no index entry
- `find.ts` does FTS5 content search but its name suggests Unix file-by-name matching
- MCP daemon mode (`server.ts:115-138`) is functionally identical to embedded mode — both create their own DB + S3
- Embedding provider init is fire-and-forget (`server.ts:82-86`) — `embeddingProvider` can be `null` when first tool call arrives
- `OP_COMMANDS` in the CLI duplicates the registry — descriptions, args, and options are maintained independently

## Desired End State

- **18 core ops** (remove `head`, `mkdir`; rename `find` → `fts`; add `tree`, `glob` → net 20 ops)
- **Rich MCP tool descriptions** generated from a `description` field on `OpDefinition`, not hardcoded `"agentfs {opName}"`
- **CLI descriptions sourced from registry** — `OP_COMMANDS` uses `description` from `OpDefinition`, eliminating the parallel maintenance
- **Single auto-bootstrap function** in `@agentfs/core`, consumed by both MCP and CLI
- **MCP always runs embedded** — no daemon mode detection, no mode flag
- **CLI pretty-print output** by default, `--json` flag for structured JSON
- **Embedding provider awaited** before first tool call
- **`drive invite` renamed** to reflect it invites to org

## Quick Verification Reference

- `bun run typecheck` — TypeScript type checking
- `bun run test` — run all tests
- `bun run build` — compile CLI binary

Key files:
- `packages/core/src/ops/index.ts` — op registry
- `packages/core/src/ops/types.ts` — param/result types
- `packages/core/src/identity/rbac.ts` — RBAC role mapping
- `packages/mcp/src/tools.ts` — MCP tool registration
- `packages/mcp/src/server.ts` — MCP server setup
- `packages/mcp/src/index.ts` — MCP entry point
- `packages/cli/src/commands/ops.ts` — CLI command definitions
- `packages/cli/src/embedded.ts` — CLI embedded mode

## What We're NOT Doing

- Eliminating the daemon/server package (REJECTED — needed for hosted mode)
- Eliminating orgs/drives model (REJECTED — this is core)
- Adding local filesystem backend instead of MinIO (PARKED)
- Bulk/batch operations
- MCP `init` or `health` tools
- Structured error recovery guidance in MCP

## Implementation Approach

Six phases, ordered to minimize churn: internal cleanup first, then op set changes, then descriptions (written once for the final set), then CLI formatting.

### Test Isolation Convention

**All automated tests must use `AGENTFS_HOME` env var to isolate the config directory to a temp path.** The `AGENTFS_HOME` env var (checked at `packages/core/src/config.ts:5`) overrides `~/.agentfs/`. The canonical pattern exists in `packages/core/src/config.test.ts:12-34` — save/restore the env var in `beforeEach`/`afterEach` and point it at a `tmpdir()`-based unique path.

As part of Phase 1, we will extract this pattern into a reusable helper in `packages/core/src/test-utils.ts` (e.g., `createTestConfigDir(): { dir: string, cleanup: () => void }`) so all test files can use it consistently.

---

## Phase 1: Consolidate Auto-Bootstrap & Remove MCP Daemon Mode

### Overview
Extract duplicated user auto-bootstrap logic into a single core function. Remove the MCP daemon/embedded mode duality since daemon mode doesn't actually proxy to the daemon. Fix the embedding provider race condition.

### Changes Required:

#### 1. Add `ensureLocalUser` to core identity module
**File**: `packages/core/src/identity/bootstrap.ts` (new)
**Changes**: Create a single `ensureLocalUser(db: DB): { apiKey: string }` function that:
- Reads config's `auth.apiKey`
- If valid user exists for that key, returns it
- Otherwise creates `local@agentfs.local` user and persists key to config
- This consolidates the identical logic from `packages/mcp/src/server.ts:26-39` and `packages/cli/src/embedded.ts:25-32`

#### 2. Export from core
**File**: `packages/core/src/identity/index.ts`
**Changes**: Re-export `ensureLocalUser` from `bootstrap.ts`

**File**: `packages/core/src/index.ts`
**Changes**: Add `ensureLocalUser` to the identity re-exports (line 34-50)

#### 3. Simplify MCP server — remove daemon mode
**File**: `packages/mcp/src/server.ts`
**Changes**:
- Remove the `mode` field from `McpServerOptions` interface (line 18)
- Remove `ensureLocalUser` function (lines 26-39) — now imported from core
- Remove the `if/else` branching on `options.mode` (lines 88-138) — always run embedded logic
- Await `providerReady` before registering tools to fix the race condition (line 84-86)

**File**: `packages/mcp/src/index.ts`
**Changes**:
- Remove all daemon auto-detection logic (lines 5-24)
- Remove `--embedded` and `--daemon` flags
- Just create server with `{ apiKey }` and connect transport

#### 4. Simplify CLI embedded mode
**File**: `packages/cli/src/embedded.ts`
**Changes**:
- Replace inline bootstrap logic (lines 25-32) with `ensureLocalUser(db)` from core
- Keep the rest of `getEmbeddedContext()` as-is (lazy singleton, context resolution)

#### 5. Update init command
**File**: `packages/cli/src/commands/init.ts`
**Changes**:
- Replace inline user creation (lines 34-47) with `ensureLocalUser(db)` from core
- Update the MCP usage message at line 51 from `"Or use MCP directly: agentfs mcp --embedded"` to `"Or use MCP directly: agentfs mcp"` (the `--embedded` flag no longer exists)

#### 6. Remove `--embedded`/`--daemon` CLI flags
**File**: `packages/cli/src/index.ts`
**Changes**:
- Remove `--embedded` and `--daemon` options from the `mcp` subcommand (lines 60-61)
- Update the `mcp` subcommand action handler to no longer pass mode flags to the MCP server

#### 7. Add test config dir helper
**File**: `packages/core/src/test-utils.ts`
**Changes**: Add a `createTestConfigDir()` helper that:
- Creates a unique temp dir via `tmpdir()` + `Date.now()` + random suffix
- Sets `process.env.AGENTFS_HOME` to that path
- Returns `{ dir: string, cleanup: () => void }` where `cleanup` restores the original env var and `rmSync`s the temp dir
- This follows the existing pattern in `packages/core/src/config.test.ts:12-34` but makes it reusable

Update existing tests that do inline `AGENTFS_HOME` management to use this helper instead.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run typecheck`
- [x] Tests pass: `bun run test`
- [x] MCP server starts without `--embedded`/`--daemon` flags: `echo '{}' | bun run packages/mcp/src/index.ts 2>&1 | head -3`

#### Manual Verification:
- [x] `agentfs init --local -y` still auto-creates user when no config exists
- [x] MCP embedded mode works without mode flag
- [x] No references to "daemon mode" remain in MCP package

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 2: Op Set Cleanup (Remove `head`, `mkdir`; Rename `find` → `fts`)

### Overview
Remove the `head` and `mkdir` operations (confirmed removable in architecture review). Rename `find` to `fts` for clarity (clean break, no alias).

### Changes Required:

#### 1. Remove `head` operation
**File**: `packages/core/src/ops/head.ts` — **DELETE**
**File**: `packages/core/src/ops/types.ts` — Remove `HeadParams` interface (lines 65-68)
**File**: `packages/core/src/ops/index.ts`:
- Remove `import { head }` (line 13)
- Remove `head` entry from `opRegistry` (lines 92-98)
- Remove `head` from the re-export line (line 203)
**File**: `packages/core/src/identity/rbac.ts` — Remove `head: "viewer"` from `OP_ROLES` (line 18)
**File**: `packages/cli/src/commands/ops.ts` — Remove `head` entry from `OP_COMMANDS` (line 22)

#### 2. Remove `mkdir` operation
**File**: `packages/core/src/ops/mkdir.ts` — **DELETE**
**File**: `packages/core/src/ops/types.ts` — Remove `MkdirParams` (lines 75-77) and `MkdirResult` (lines 167-169) interfaces
**File**: `packages/core/src/ops/index.ts`:
- Remove `import { mkdir }` (line 15)
- Remove `mkdir` entry from `opRegistry` (lines 106-108)
- Remove `mkdir` from the re-export line (line 203)
**File**: `packages/core/src/identity/rbac.ts` — Remove `mkdir: "editor"` from `OP_ROLES` (line 33)
**File**: `packages/cli/src/commands/ops.ts` — Remove `mkdir` entry from `OP_COMMANDS` (line 24)

#### 3. Rename `find` → `fts`
**File**: `packages/core/src/ops/find.ts` — **RENAME** to `packages/core/src/ops/fts.ts`
- Rename exported function `find` → `fts`
- Rename types: `FindParams` → `FtsParams`, `FindMatch` → `FtsOpMatch` (avoids collision with `FtsMatch` in `search/fts.ts`), `FindResult` → `FtsResult`
**File**: `packages/core/src/ops/index.ts`:
- Change import: `import { fts } from "./fts.js"`
- Change registry key from `find` to `fts`
- Update re-export line: `find` → `fts`
**File**: `packages/core/src/identity/rbac.ts` — Rename `find: "viewer"` → `fts: "viewer"` in `OP_ROLES`
**File**: `packages/cli/src/commands/ops.ts` — Rename `find` entry to `fts` in `OP_COMMANDS`, update description to `"Full-text content search (FTS5)"`

#### 4. Update test files
The following test files reference `head`, `mkdir`, or `find` by name and must be updated:

**File**: `packages/core/src/ops/__tests__/ops-integration.test.ts`
**Changes**:
- Remove `import { head }` and `import { mkdir }` statements
- Remove the `"head and tail operations"` describe block (tests `head` directly)
- Remove the `"ls and mkdir operations"` describe block (tests `mkdir` directly)
- Rename `"find operation"` describe block to `"fts operation"`; update `dispatchOp(ctx, "find", ...)` → `dispatchOp(ctx, "fts", ...)`

**File**: `packages/core/src/ops/__tests__/ops.test.ts`
**Changes**:
- Remove `dispatchOp(ctx, "head", ...)` test case
- Remove `dispatchOp(ctx, "mkdir", ...)` test case
- Rename `"find operation"` describe block; update `dispatchOp(ctx, "find", ...)` → `dispatchOp(ctx, "fts", ...)`

**File**: `packages/core/src/ops/__tests__/search.test.ts`
**Changes**:
- Change `import { find }` from `../find.js` → `import { fts }` from `../fts.js`
- Rename `"FTS5 find"` describe block → `"FTS5 fts"`
- Update all `find(ctx, ...)` calls → `fts(ctx, ...)`

**File**: `packages/core/src/ops/__tests__/registry.test.ts`
**Changes**:
- Remove `"head"` and `"mkdir"` from expected ops array
- Rename `"find"` → `"fts"` in expected ops array
- Update expected count from 20 → 18

**File**: `packages/core/src/__tests__/rbac-mapping.test.ts`
**Changes**:
- Remove `"head"` from `viewerOps`, remove `"mkdir"` from `editorOps`
- Rename `"find"` → `"fts"` in `viewerOps`

**File**: `packages/mcp/src/__tests__/mcp.test.ts`
**Changes**:
- Remove `"head"` and `"mkdir"` from expected ops array
- Rename `"find"` → `"fts"` in expected ops array

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run typecheck`
- [x] Tests pass: `bun run test`
- [x] Registry has 18 ops: `bun -e "const { getRegisteredOps } = require('@agentfs/core'); console.log(getRegisteredOps().length)"`
- [x] No references to removed ops: `grep -r "\"head\"" packages/core/src/ops/ packages/mcp/ packages/cli/` (should find nothing)
- [x] No references to old find: `grep -r "\"find\"" packages/core/src/ops/ packages/mcp/ packages/cli/` (should find nothing relevant)

#### Manual Verification:
- [x] `agentfs fts "search term"` works from CLI
- [x] `agentfs head` and `agentfs mkdir` produce "unknown command" errors
- [x] MCP tool list no longer includes `head`, `mkdir`, or `find`; includes `fts`

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 3: Add New Operations (`tree`, `glob`)

### Overview
Add two new operations that fill gaps identified in the architecture review: `tree` for recursive directory listing (agents need this to understand project structure) and `glob` for finding files by name pattern (no way to do this currently).

### Changes Required:

#### 1. Add `tree` operation
**File**: `packages/core/src/ops/tree.ts` (new)
**Changes**: Implement recursive directory listing:
- Params: `{ path: string, depth?: number }` — `depth` limits recursion (default unlimited)
- Uses `s3.listObjects(prefix)` WITHOUT delimiter to get all objects recursively
- Builds a tree structure from flat S3 keys
- Returns `{ tree: TreeEntry[] }` where `TreeEntry = { name, type, size?, children?: TreeEntry[] }`
- Enriches with SQLite metadata where available (author, modifiedAt)

**File**: `packages/core/src/ops/types.ts`
**Changes**: Add `TreeParams`, `TreeEntry`, `TreeResult` interfaces

**File**: `packages/core/src/ops/index.ts`
**Changes**: Import `tree`, add to registry with schema `z.object({ path: z.string(), depth: z.number().int().min(1).optional() })`, add to re-exports

**File**: `packages/core/src/identity/rbac.ts`
**Changes**: Add `tree: "viewer"` to `OP_ROLES`

**File**: `packages/cli/src/commands/ops.ts`
**Changes**: Add `tree` to `OP_COMMANDS` with `--depth <n>` option

#### 2. Add `glob` operation
**File**: `packages/core/src/ops/glob.ts` (new)
**Changes**: Implement file name pattern matching:
- Params: `{ pattern: string, path?: string }` — `pattern` is a glob (e.g., `*.md`, `config.*`)
- Lists all S3 objects under the drive prefix (or `path` if provided)
- Filters by converting glob to regex (use `picomatch` or simple hand-rolled conversion for `*`, `?`, `**`)
- Returns `{ matches: GlobMatch[] }` where `GlobMatch = { path: string, size: number, modifiedAt?: Date }`

**File**: `packages/core/src/ops/types.ts`
**Changes**: Add `GlobParams`, `GlobMatch`, `GlobResult` interfaces

**File**: `packages/core/src/ops/index.ts`
**Changes**: Import `glob`, add to registry with schema, add to re-exports

**File**: `packages/core/src/identity/rbac.ts`
**Changes**: Add `glob: "viewer"` to `OP_ROLES`

**File**: `packages/cli/src/commands/ops.ts`
**Changes**: Add `glob` to `OP_COMMANDS` with `path` as optional arg

#### 3. Add numeric option parsing for new ops
**File**: `packages/cli/src/commands/ops.ts`
**Changes**: Add `"depth"` to the numeric parsing list at line 83

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run typecheck`
- [x] Tests pass: `bun run test`
- [x] Registry has 20 ops: `bun -e "const { getRegisteredOps } = require('@agentfs/core'); console.log(getRegisteredOps().length)"`

#### Manual Verification:
- [x] `agentfs tree /` returns a recursive listing of the drive
- [x] `agentfs tree / --depth 1` returns only immediate children
- [x] `agentfs glob "*.md"` returns matching files
- [x] `agentfs glob "*.md" --path /docs` scopes to a path prefix (note: path is `--path` flag, not positional)
- [x] Both operations appear as MCP tools

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 4: Rich MCP Tool Descriptions

### Overview
Add a `description` field to `OpDefinition` so each operation carries a human-friendly description. Update MCP tool registration to use it. Update CLI to source descriptions from the registry instead of the hand-maintained `OP_COMMANDS` array.

### Changes Required:

#### 1. Add `description` to `OpDefinition`
**File**: `packages/core/src/ops/index.ts`
**Changes**:
- Add `description: string` to the `OpDefinition` interface (line 25-28)
- Add descriptions to every entry in `opRegistry`. Each description should explain what the op does, key parameters, and return format. Examples:

```typescript
write: {
  description: "Write or overwrite a file. Creates the file if it doesn't exist, or creates a new version if it does. Use expectedVersion for optimistic concurrency control. Returns { version, path, size }.",
  handler: write,
  schema: z.object({ ... }),
},
cat: {
  description: "Read file content with optional pagination. Returns { content, totalLines, truncated }. Use offset and limit for large files.",
  handler: cat,
  schema: z.object({ ... }),
},
```

Full descriptions for all 20 ops:
- `write`: "Write or overwrite a file. Creates the file if it doesn't exist, or creates a new version. Use expectedVersion for optimistic concurrency. Returns { version, path, size }."
- `cat`: "Read file content with optional pagination via offset/limit. Returns { content, totalLines, truncated }."
- `edit`: "Replace a specific string in a file (surgical find-and-replace). Captures the edit intent as a diff summary in version history. Returns { version, path, changes }."
- `append`: "Append content to the end of an existing file. Creates a new version. Returns { version, size }."
- `ls`: "List immediate children of a directory. Returns { entries } where each entry has name, type (file/directory), size, author, modifiedAt."
- `stat`: "Get file metadata without reading content. Returns path, size, contentType, author, currentVersion, createdAt, modifiedAt, isDeleted, embeddingStatus."
- `rm`: "Delete a file. Removes from S3, cleans up FTS5 index and vector embeddings. Returns { path, deleted }."
- `mv`: "Move or rename a file. Preserves version history at the new path. Returns { from, to, version }."
- `cp`: "Copy a file using server-side S3 copy. Creates a new version at the destination. Returns { from, to, version }."
- `tail`: "Read the last N lines of a file (default 20). Returns { content, totalLines, truncated }."
- `log`: "Show version history for a file. Returns { versions } with version number, author, timestamp, operation type, message, and diff summary."
- `diff`: "Show the diff between two versions of a file. Specify v1 and v2 version numbers. Returns { changes } as add/remove/context hunks."
- `revert`: "Revert a file to a previous version. Creates a new version with the old content. Returns { version, revertedTo }."
- `recent`: "Show recent activity across the drive. Optionally filter by path prefix and time window (since). Returns { entries } with path and version details."
- `grep`: "Search file content using regex pattern within a specific path. Returns matching lines with line numbers. Searches the FTS5 index, not S3 directly."
- `fts`: "Full-text search across all file content using FTS5 tokens. Different from grep (regex) and search (semantic). Returns { matches } with path, snippet, and rank."
- `search`: "Semantic/vector search using natural language queries. Requires an embedding provider (OPENAI_API_KEY or GEMINI_API_KEY). Returns { results } ranked by relevance."
- `reindex`: "Re-index files with failed or missing FTS5/embedding entries. Optionally scope to a path prefix. Use after bulk writes or provider changes."
- `tree`: "Recursively list all files and directories. Use depth to limit recursion. Returns a nested tree structure with name, type, size, and children."
- `glob`: "Find files by name pattern (e.g., *.md, config.*). Optionally scope to a path prefix. Returns { matches } with path, size, and modifiedAt."

#### 2. Export description accessor
**File**: `packages/core/src/ops/index.ts`
**Changes**: The existing `getOpDefinition()` already returns the full `OpDefinition`, so consumers can access `.description` directly. No new function needed.

#### 3. Update MCP tool registration
**File**: `packages/mcp/src/tools.ts`
**Changes**: Change line 21 from `` `agentfs ${opName}` `` to `def.description`

#### 4. Update MCP tools test
**File**: `packages/mcp/src/__tests__/tools.test.ts`
**Changes**: Update the description assertion at line 42 from `tool.description === "agentfs ${tool.name}"` to verify descriptions come from the registry (e.g., `expect(tool.description).toBe(getOpDefinition(tool.name).description)` or simply `expect(tool.description.length).toBeGreaterThan(20)` to ensure rich descriptions).

#### 5. Update CLI to source descriptions from registry
**File**: `packages/cli/src/commands/ops.ts`
**Changes**: Instead of duplicating descriptions in `OP_COMMANDS`, look up `getOpDefinition(name).description` for each command's `.description()`. The `OP_COMMANDS` array still needs to define args and options (since those are CLI-specific), but `description` can be removed from the array type and sourced from the registry.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run typecheck`
- [x] Tests pass: `bun run test`
- [x] No `"agentfs "` prefix in MCP descriptions: `grep -r '"agentfs "' packages/mcp/`

#### Manual Verification:
- [x] MCP tool listing shows rich descriptions for all tools (not just `"agentfs write"`)
- [x] `agentfs --help` shows descriptions sourced from the registry
- [x] Each MCP tool description explains what parameters mean and what the return shape is

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 5: CLI Pretty-Print Output

### Overview
Add human-friendly formatted output as the CLI default, with a `--json` flag for structured JSON output. MCP always returns JSON — this is a CLI-only change.

### Changes Required:

#### 1. Create formatters module
**File**: `packages/cli/src/formatters.ts` (new)
**Changes**: Per-op pretty-print functions. Each takes the result object and returns a formatted string. Examples:

- `ls`: Table with columns `NAME`, `TYPE`, `SIZE`, `MODIFIED` (like Unix `ls -l` but simpler)
- `cat`: Raw content with line numbers (like `cat -n`)
- `stat`: Key-value pairs (like `stat` output)
- `log`: Formatted version history (version, date, author, message per line)
- `write`/`edit`/`append`: One-line confirmation (e.g., `✓ wrote /path (v3, 1.2 KB)`)
- `rm`: One-line confirmation (e.g., `✓ deleted /path`)
- `tree`: Indented tree with `├──` / `└──` connectors
- `grep`/`fts`/`search`/`glob`: Results list with paths and snippets

Export an `outputResult(opName: string, result: any, json: boolean): void` function that encapsulates the decision:

```typescript
export function outputResult(opName: string, result: any, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatResult(opName, result));
  }
}
```

This is the single entry point for all CLI output — both the JSON vs pretty decision and the per-op formatting are fully encapsulated here.

#### 2. Add `--json` global option
**File**: `packages/cli/src/index.ts`
**Changes**: Add `program.option(‘--json’, ‘Output raw JSON’)` as a global option

#### 3. Update op action handler — single global change
**File**: `packages/cli/src/commands/ops.ts`
**Changes**: This is already a global change — all 20 ops converge through a single loop at `registerOpCommands` (lines 40-107), and the output happens at one line (line 98). Replace that single `console.log(JSON.stringify(result, null, 2))` with:
```typescript
outputResult(def.name, result, program.opts().json);
```
Pass `program` reference to `registerOpCommands` (add it as a 4th parameter). The formatting logic lives entirely in `formatters.ts`, and the single `outputResult` call in the loop is the only integration point — no per-command code needed.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run typecheck`
- [x] Tests pass: `bun run test`

#### Manual Verification:
- [x] `agentfs ls /` shows a formatted table (not JSON)
- [x] `agentfs ls / --json` shows raw JSON
- [x] `agentfs cat /some-file` shows content with line numbers
- [x] `agentfs write /test --content "hello"` shows a one-line confirmation
- [x] `agentfs tree /` shows indented tree with connectors
- [x] All 20 ops have formatters that produce readable output

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 6: Fix `drive invite` Naming

### Overview
The `drive invite` CLI command invites to the org, not the drive. Fix the naming to match the actual behavior.

### Changes Required:

#### 1. Keep `drive invite` with clarified help text
**File**: `packages/cli/src/commands/drive.ts`
**Changes**:
- The description at line 73 already says "Invite a user to the current org", so the help text is already accurate
- Update the `--help` long description to explicitly note: "This invites the user to the organization that owns the current drive. The user will have access to all drives in the org based on their role."
- No command rename needed — `drive invite` is the natural UX since users think in terms of drives, and the help text clarifies the org-level scope

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run typecheck`
- [x] Tests pass: `bun run test`

#### Manual Verification:
- [x] `agentfs drive invite --help` clearly states it invites to the org
- [x] The actual invite behavior is unchanged

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Testing Strategy

- **Test isolation**: All tests that touch config/bootstrap must use `createTestConfigDir()` from `test-utils.ts` to set `AGENTFS_HOME` to a temp directory. This ensures tests never read/write `~/.agentfs/`.
- **Unit tests**: Each new operation (`tree`, `glob`) should have unit tests following the pattern in `packages/core/src/ops/__tests__/`, using `createTestContext()` from `test-utils.ts` (in-memory DB + MockS3)
- **Integration tests**: The bootstrap consolidation should be verified by the existing init/embedded tests (updated to use `createTestConfigDir()`)
- **Type checking**: `bun run typecheck` after each phase
- **Manual E2E**: After all phases:

```bash
# Verify init still works
agentfs init --local -y

# Verify removed ops are gone
agentfs head /test      # should error: unknown command
agentfs mkdir /test     # should error: unknown command

# Verify renamed op
agentfs fts "search term"

# Verify new ops
agentfs write /test-tree/a.md --content "hello"
agentfs write /test-tree/b.txt --content "world"
agentfs write /test-tree/sub/c.md --content "nested"
agentfs tree /test-tree
agentfs tree /test-tree --depth 1
agentfs glob "*.md"
agentfs glob "*.md" --path /test-tree

# Verify pretty output
agentfs ls /test-tree
agentfs cat /test-tree/a.md
agentfs stat /test-tree/a.md
agentfs log /test-tree/a.md

# Verify --json flag
agentfs ls /test-tree --json
agentfs cat /test-tree/a.md --json

# Verify MCP descriptions (check tool list)
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | bun run packages/mcp/src/index.ts 2>/dev/null
```

### E2E Results (2026-03-16)

All 40 manual E2E tests passed. Tests run with `AGENTFS_HOME` pointed at a temp dir for full isolation. Notable: `bun run build` compiled binary has a pre-existing sqlite-vec native extension loading issue — all E2E tests ran via `bun run packages/cli/src/index.ts` instead.

## References

- Architecture review: `thoughts/taras/research/2026-03-15-architecture-review.md`
- Testing coverage plan: `thoughts/taras/plans/2026-03-15-testing-coverage.md`

---

## Review Errata

_Reviewed: 2026-03-16 by Claude_

All findings addressed inline in the plan above. Summary of changes made:

### Resolved

- [x] **Phase 2 test files enumerated** — Replaced vague "update any test files" with explicit list of 6 test files and specific changes for each
- [x] **Phase 1 CLI flags added** — Added step 6 to remove `--embedded`/`--daemon` from `packages/cli/src/index.ts:60-61`
- [x] **Phase 1 stale message fixed** — Added `init.ts:51` message update to step 5
- [x] **Phase 4 tools.test.ts added** — Added step 4 to update the `"agentfs ${tool.name}"` assertion
- [x] **Frontmatter corrected** — `author` → `planner`, added `topic` field
- [x] **`FtsMatch` collision avoided** — Changed rename to `FtsOpMatch` instead of `FtsMatch`
- [x] **Phase 6 specified** — Committed to keeping `drive invite` with clarified long help text (no rename needed)
- [x] Verified 14/17 codebase claims are fully accurate; 3 have minor line-range offsets (off-by-one) that don't affect correctness
- [x] `packages/server/` uses generic `dispatchOp()` — no op-name references, no changes needed for op removal/rename
- [x] `packages/core/src/test-utils.ts` already exists with `createTestDb`, `MockS3Client`, `createTestContext` — the proposed `createTestConfigDir()` addition is compatible
- [x] No existing `tree.ts` or `glob.ts` files — no conflicts with new ops
- [x] MCP package has no daemon-specific dependencies — no `package.json` changes needed
