---
date: 2026-03-15
researcher: Claude
git_branch: main
git_commit: 6cd3cab
repository: git@github.com:desplega-ai/agent-fs.git
tags: [architecture, review, simplification, gaps, onboarding]
status: complete
---

# Architecture Review: agentfs

## Research Question

Analyze the current architecture of agentfs — package boundaries, onboarding flow, registration, day-to-day operations, lifecycle management — and identify inconsistencies, gaps, and simplification opportunities. Evaluate from the perspective of an AI agent as the primary user.

---

## Summary

agentfs is a Bun monorepo with 4 packages (`core`, `cli`, `mcp`, `server`) providing a virtual filesystem backed by S3 (content) + SQLite (metadata/search/identity). It has 20 filesystem operations, a multi-tenant identity system (users → orgs → drives), three search mechanisms (FTS5, regex, vector/semantic), and two execution modes (embedded in-process vs daemon HTTP server). The MCP package exposes all operations as MCP tools for AI agent consumption.

The architecture is fundamentally sound, but has several areas worth examining: the daemon vs embedded mode duality creates duplicate code paths, the MCP "daemon mode" doesn't actually proxy to the daemon, the identity model (orgs/drives) adds complexity that may not serve the primary use case, and onboarding requires Docker for MinIO which is a significant friction point.

---

## Detailed Findings

### 1. Overall Architecture and Package Boundaries

#### Package Dependency Graph

```
cli ──→ core
 │        ↑
 └──→ server ──→ core
       ↑
mcp ──→ core
```

- **`core`** (leaf): Database schema, S3 client, all 20 filesystem operations, identity/RBAC, search (FTS5 + vector), config, errors
- **`server`**: Hono HTTP API wrapping core operations, daemon lifecycle (PID file management)
- **`mcp`**: MCP stdio server wrapping core operations via the op registry
- **`cli`**: Commander.js CLI with commands for ops, auth, daemon, config, drives, init; plus inline `mcp` and `server` sub-commands

#### Observation: Server and MCP Are Structurally Identical

Both `server` and `mcp` do the same thing — they wrap `@agentfs/core` operations for external consumption:

| Aspect | `server` | `mcp` |
|--------|----------|-------|
| Transport | HTTP (Hono) | stdio (MCP SDK) |
| Auth | Bearer token middleware | API key in env/config |
| Dispatch | `POST /orgs/:orgId/ops` → `dispatchOp()` | MCP tool handler → `dispatchOp()` |
| Context | Per-request via middleware | Per-request via closure |
| User bootstrap | Via `/auth/register` endpoint | Via `ensureLocalUser()` |
| Added surface | Org/drive CRUD routes, health | None beyond ops |

The server package adds org/drive management HTTP endpoints that the MCP package does not expose. But the MCP package auto-creates a local user, effectively bypassing the need for explicit registration.

#### Observation: CLI Has Three Execution Paths

Every filesystem op in the CLI auto-detects whether the daemon is running (1-second health check timeout):
1. **Daemon up** → HTTP call via `ApiClient.callOp()` → server → core
2. **Daemon down** → `embeddedCallOp()` → core directly in-process

Plus the MCP server is a third path:
3. **MCP embedded** → MCP tool handler → core directly in-process

Paths 2 and 3 are essentially identical — both create a local database, S3 client, auto-bootstrap a user, and call `dispatchOp()` directly.

---

### 2. Onboarding Flow (From an Agent's Perspective)

#### Current Flow

1. **Install**: `curl -fsSL https://raw.githubusercontent.com/desplega-ai/agent-fs/main/install.sh | sh` (downloads compiled binary)
2. **Init**: `agentfs init --local -y` which:
   - Checks Docker is installed and running
   - Creates or starts an `agentfs-minio` Docker container (MinIO S3)
   - Creates the `agentfs` bucket
   - Saves S3 config to `~/.agentfs/config.json`
   - Creates SQLite database at `~/.agentfs/agentfs.db`
   - Creates a `local@agentfs.local` user with auto-generated API key
   - Persists API key to config
3. **Use**: Either start daemon (`agentfs daemon start`) or use embedded mode directly

#### Friction Points

- **Docker dependency**: Requiring Docker for MinIO is a *significant* barrier for agent users. An agent operating in a sandboxed environment may not have Docker access.
- **MinIO is heavyweight**: Running a full S3-compatible server for local single-user usage is arguably over-engineered for the "just works locally" case.
- **Two-step init**: The user must both install and run `init`. The MCP embedded mode auto-bootstraps the user but still requires S3 to be pre-configured.
- **No `init` from MCP**: If an agent is using agentfs purely via MCP tools, there's no `init` tool — they'd need CLI access to set up.
- **The skill's Quick Start says "Requires Docker"**: This immediately signals complexity to an agent or user evaluating the tool.

#### What Works Well

- The `--local -y` flag makes init non-interactive, which is agent-friendly
- Auto-bootstrap of `local@agentfs.local` user eliminates manual registration
- MCP embedded mode requires zero daemon management
- The plugin manifest (`plugin.json`) wires up the MCP server automatically for Claude Code users

---

### 3. Registration / Identity Model

#### Current Model

```
User (API key: af_xxx)
  └── Personal Org (auto-created)
       └── Default Drive (auto-created)
            └── Files live here
```

Every user gets a personal org with a default drive. The RBAC system supports viewer/editor/admin roles on both org and drive levels.

#### Observations

- **Orgs and drives add indirection for single-agent use**: A local agent using embedded mode always operates on their personal org's default drive. The org/drive layer is invisible but still exists in every code path (context resolution, S3 key construction, permission checks).
- **The CLI `drive invite` command invites to the *org*, not the drive** (`inviteToOrg` at `drive.ts:77`). The naming is misleading.
- **S3 keys include orgId and driveId**: e.g., `<orgId>/drives/<driveId>/path/to/file`. This is good for multi-tenancy but creates deep nesting for what is conceptually a flat file store.
- **`resolveContext` always falls back to personal org → default drive** when called without explicit orgId/driveId (which is the MCP path). The multi-tenant resolution logic exists but the MCP package never exercises it.

---

### 4. Day-to-Day Operations (CRUD)

#### What Works Well

- **20 operations** cover a comprehensive POSIX-like surface: write, cat, edit, append, ls, stat, rm, mv, cp, head, tail, mkdir, log, diff, revert, recent, grep, find, search, reindex
- **Op registry pattern** is clean — operations are defined once with Zod schemas and auto-registered as both CLI commands and MCP tools
- **Optimistic concurrency** via `expectedVersion` on write is a good primitive for multi-agent coordination
- **Version history** with semantic operation types (write/edit/append/delete/revert) provides good audit trails
- **Edit captures intent** — storing `old_string` → `new_string` as the diff summary is more useful than raw diffs for understanding what changed

#### Observations

- **All MCP tool descriptions are generic**: Every tool gets `"agentfs {opName}"` as its description (e.g., `"agentfs write"`, `"agentfs cat"`). These provide zero context to an LLM about what the tool does or what parameters mean. This is the single biggest UX gap for agent users.
- **`grep` reads from FTS5, not S3**: This is an optimization (avoids S3 round-trips) but means `grep` results depend on FTS5 being up-to-date. If indexing fails or is delayed, grep returns stale results.
- **`search` (semantic) requires an embedding provider**: If no `OPENAI_API_KEY` or `GEMINI_API_KEY` is set, semantic search silently returns no results. The `reindex` command also silently skips embedding if no provider is available.
- **`ls` fetches all S3 objects under a prefix and filters client-side**: It does NOT use S3's `Delimiter` parameter — instead it lists all descendants recursively and collapses nested paths into directory entries in application code (`ls.ts:42-51`). This means `ls` shows only immediate children (correct behavior) but fetches everything from S3 first (potential performance issue for large drives). Files written directly to S3 outside agentfs will appear but without versions, search indexing, or metadata.
- **`mkdir` creates a zero-byte S3 object with trailing `/`**: This is the standard S3 convention for "directories" but is a no-op in terms of agentfs metadata — no SQLite record, no version, no index entry.

---

### 5. Lifecycle Management

#### Daemon Mode

- **Start**: `agentfs daemon start` → spawns `bun run packages/server/src/index.ts` as detached child, writes PID to `~/.agentfs/agentfs.pid`, logs to `~/.agentfs/agentfs.log`
- **Stop**: `agentfs daemon stop` → reads PID file, sends SIGTERM, removes PID file
- **Status**: `agentfs daemon status` → reads PID, sends signal 0 to probe liveness

This is straightforward and works. The CLI auto-detects whether the daemon is running via a 1-second health check to `http://localhost:7433/health`.

#### Embedded Mode

No lifecycle to manage — the database and S3 client are created in-process and cleaned up on exit. This is the recommended mode for single-agent use.

#### Observations

- **No graceful shutdown for embedded mode in MCP**: The MCP server (`packages/mcp/src/index.ts`) connects stdio transport and that's it — no signal handlers, no cleanup. If the process is killed, in-flight embedding operations could be interrupted.
- **Daemon mode PID file can go stale**: If the daemon process crashes or is killed with SIGKILL, the PID file remains. `startDaemon()` handles this by checking liveness with signal 0 and removing the stale PID file — this works correctly.
- **No S3 connection health check on startup**: Neither embedded nor daemon mode validates that S3 (MinIO) is actually reachable before accepting requests. A misconfigured or stopped MinIO container would cause operations to fail with S3-level errors rather than a clear "S3 not available" message.

---

### 6. Inconsistencies

#### A. MCP "Daemon Mode" Is Not a Real Daemon Mode

`packages/mcp/src/index.ts:10-24` auto-detects daemon vs embedded by probing `localhost:7433/health`. But in `server.ts`, both paths (embedded and daemon) create their own local database, S3 client, and context resolution. **The "daemon" path does NOT proxy requests to the HTTP server** — it's functionally identical to embedded mode, just with different API key resolution logic.

This is misleading: the auto-detection suggests the MCP server will use the daemon, but it doesn't. The only difference is where the API key comes from.

#### B. Duplicate Auto-Bootstrap Logic

User auto-bootstrap (`local@agentfs.local` creation + config persistence) is implemented in three places:
1. `packages/mcp/src/server.ts:26-39` (`ensureLocalUser`)
2. `packages/cli/src/embedded.ts:28-32`
3. `packages/cli/src/commands/init.ts:34-47`

All three do the same thing with slightly different code.

#### C. Duplicate Context Resolution

The pattern of "read config → create database → get user by API key → resolve context" is implemented independently in:
1. `packages/mcp/src/server.ts:88-113` (embedded mode)
2. `packages/mcp/src/server.ts:115-138` (daemon mode)
3. `packages/cli/src/embedded.ts:18-48`
4. `packages/cli/src/commands/auth.ts` (whoami fallback)
5. `packages/cli/src/commands/drive.ts:92-103` (`getLocalContext`)
6. `packages/cli/src/index.ts:24-46` (`getOrgId`)

#### D. `drive invite` Invites to Org, Not Drive

The CLI command at `commands/drive.ts:69-87` is `drive invite <email> --role` but calls `inviteToOrg()`. The UX suggests per-drive invitation but the implementation is per-org.

#### E. Embedding Provider Initialization Is Fire-and-Forget

In `packages/mcp/src/server.ts:83-86`, `createEmbeddingProvider()` is an async call whose result is stored in a closure variable. If the first MCP tool call arrives before the provider is ready, `embeddingProvider` will be `null`, and semantic search/embedding operations will silently fail or skip.

#### F. `auth.apiKey` in Config vs `AGENTFS_API_KEY` Env Var

The API key can come from three sources with different precedence in different packages:
- MCP embedded: `options.apiKey` (from env) → `ensureLocalUser()` (config + auto-create)
- MCP daemon: `options.apiKey` (from env) → `config.auth.apiKey`
- CLI daemon: `AGENTFS_API_KEY` env → `config.auth.apiKey`
- CLI embedded: `config.auth.apiKey` → auto-create

The precedence isn't consistent.

#### G. `/auth/verify` in PUBLIC_PATHS but No Route Handler

`server/src/middleware/auth.ts:6` lists `/auth/verify` in `PUBLIC_PATHS`, exempting it from auth. But no route handler for `/auth/verify` exists in `routes/auth.ts`. Requests to this path would get a 404 from Hono rather than a meaningful response.

---

### 7. Gaps

#### A. MCP Tool Descriptions Are Empty

As mentioned, every MCP tool gets `"agentfs {opName}"` as description. An LLM seeing these tools has no idea what `write` does, what parameters mean, or what the return format is. This is the most impactful gap for the primary use case (AI agents via MCP).

#### B. No Error Recovery Guidance in MCP

MCP tool errors return raw error messages. There's no structured guidance for the agent on what to do when an operation fails (e.g., "File not found — did you mean X?" or "Version conflict — current version is Y, use expectedVersion: Y").

#### C. No `init` or `setup` MCP Tool

An agent using MCP has no way to check if agentfs is properly configured, run initialization, or diagnose issues. The skill document describes CLI-based setup, but an MCP-only agent can't execute CLI commands.

#### D. No Health/Status MCP Tool

There's no MCP tool to check if the system is healthy (S3 reachable, database accessible, embedding provider available). An agent encountering errors has no diagnostic capability.

#### E. Semantic Search Fails Silently

If no embedding provider is configured, `search` returns `{ results: [] }` with a `hint` field — but the `hint` is added as a non-standard field outside the declared `SearchResult` interface, so consumers may not see it. The `reindex` command also silently skips embedding. An agent may not reliably know that semantic search is unavailable or how to enable it.

#### F. No Bulk Operations

There's no batch write, batch read, or transaction support. An agent wanting to write multiple related files has to make individual calls with no atomicity guarantee.

#### G. Missing `tree` or Recursive `ls`

The `ls` operation only shows immediate children (via client-side filtering of a full S3 listing). There's no recursive listing or tree view, which agents often need for understanding project structure.

#### H. `find` Is FTS5 Token Search, Not Glob Pattern

Despite the name suggesting file pattern matching (like Unix `find`), the `find` operation does FTS5 full-text search. The `pattern` parameter is an FTS5 query, not a glob pattern. This could confuse agents expecting POSIX-like behavior. The grep op does regex matching but over content, not filenames.

---

### 8. Simplification Opportunities

#### ~~A. Eliminate the Daemon/Server Package for v1~~ (REJECTED — needed for hosted mode)

For the primary use case (single agent or small team), the embedded mode already works. The server/daemon adds:
- A second execution path to maintain
- HTTP serialization overhead
- Auth middleware complexity
- Org/drive CRUD endpoints that MCP doesn't expose

If the multi-user HTTP API is deferred, the entire `server` package and the `cli/commands/daemon.ts` could be removed, reducing the surface area significantly.

#### ~~B. Consider Eliminating Orgs/Drives for v1~~ (REJECTED — this is core)

For local single-agent use, the identity hierarchy (user → org → drive) is pure overhead:
- Every operation resolves context through 3 joins
- S3 keys are nested under `<orgId>/drives/<driveId>/`
- RBAC checks happen on every operation even though the local user is admin of their own drive

A simpler model: single user, single namespace, flat S3 keys. Multi-tenancy could be added later as a layer on top.

#### ~~C. Consider Local Filesystem Backend Instead of MinIO~~ (PARKED)

The Docker/MinIO requirement is the single biggest onboarding friction. For local use:
- SQLite already stores metadata and FTS5 content
- File content could live on the local filesystem (e.g., `~/.agentfs/data/`)
- S3 could be an optional backend for when users want cloud storage

This would make agentfs work out of the box with zero dependencies.

#### D. Consolidate Auto-Bootstrap Logic

The user auto-creation logic is duplicated in 3 places. It should be a single function in `@agentfs/core` called by both CLI and MCP.

#### E. Make MCP Tool Descriptions Rich

Instead of `"agentfs write"`, generate descriptions from Zod schemas:
```
Write or overwrite a file. Parameters: path (required), content (required),
message (optional, version commit message), expectedVersion (optional, for
optimistic concurrency). Returns: { version: number }
```

This is the highest-impact change for agent UX.

#### F. Remove MCP Daemon Mode

Since MCP "daemon mode" doesn't actually proxy to the daemon (it creates its own local context identically to embedded mode), the auto-detection and mode flag can be removed. Just always run embedded.

---

### 9. Command Audit: Keep, Remove, Add

#### Current 20 Operations — Verdict

| Op | Category | Verdict | Rationale |
|----|----------|---------|-----------|
| `write` | Essential | **Keep** | Core write primitive, optimistic concurrency |
| `cat` | Essential | **Keep** | Core read primitive with pagination |
| `edit` | Essential | **Keep** | Surgical find-and-replace, captures intent |
| `ls` | Essential | **Keep** | Directory listing (now uses S3 Delimiter) |
| `stat` | Essential | **Keep** | File metadata without reading content |
| `rm` | Essential | **Keep** | Delete with proper cleanup (S3 + FTS5 + vectors) |
| `mv` | Essential | **Keep** | Move with versioning semantics |
| `log` | Essential | **Keep** | Version history, needed for diff/revert |
| `grep` | Essential | **Keep** | Regex content search with line numbers — distinct from find/search |
| `search` | Essential | **Keep** | Semantic/vector search (complementary to grep) |
| `reindex` | Essential | **Keep** | Only way to repair broken indexes |
| `tail` | Nice-to-have | **Keep** | Can't easily replicate via cat (requires totalLines upfront) |
| `cp` | Nice-to-have | **Keep** | S3 server-side copy is more efficient than cat+write |
| `append` | Nice-to-have | **Keep** | Convenience for log-style files, avoids read-modify-write |
| `diff` | Nice-to-have | **Keep** | Useful with versioning, structured patch output |
| `recent` | Nice-to-have | **Keep** | Drive-wide activity feed, good for situational awareness |
| `revert` | Nice-to-have | **Keep** | Safety net for undoing agent mistakes |
| `head` | Removable | **Remove** | Pure 5-line wrapper: `cat(ctx, {offset:0, limit:20})`. Zero added value. |
| `mkdir` | Removable | **Remove** | S3 directories are implicit. Writing `foo/bar.txt` auto-creates `foo/`. Only creates an empty marker object with no SQLite record, no version, no index. |
| `find` | Rename | **Rename to `fts`** | Name suggests Unix `find` (file-by-name), but does FTS5 content search. Rename to `fts` to clarify it's full-text search. Distinct from `grep` (regex) and `search` (semantic). |

**Proposed result: 18 ops** (remove `head`, `mkdir`; rename `find` → `fts`)

#### Missing Operations — Proposed Additions

| Op | Category | Description |
|----|----------|-------------|
| `tree` | **Add** | Recursive directory listing with optional depth limit. Agents need this to understand project structure without calling `ls` repeatedly. Uses `listObjects` without delimiter + client-side tree building. |
| `glob` | **Add** | Find files by name pattern (e.g., `*.md`, `config.*`). Currently there's no way to find files by name — `find`/`fts` does content search, `grep` does regex content search. Agents regularly need "show me all markdown files". |

**Proposed final: 20 ops** (remove 2, rename 1, add 2)

---

### 10. CLI Output Format

**Current**: All CLI commands output raw JSON (`JSON.stringify(result, null, 2)` at `ops.ts:98`).

**Proposal**: Pretty-printed human-friendly output by default, with `--json` flag for structured JSON output.

This means:
- **Default (no flag)**: Formatted, readable output tailored per command (e.g., `ls` shows a table, `cat` shows raw content with line numbers, `log` shows a formatted version history)
- **`--json` flag**: Current behavior — raw JSON, suitable for programmatic consumption and MCP

This is a CLI-only concern — MCP tools always return JSON. The `--json` flag would be a global option on the root `program`, not per-command.

Implementation approach:
- Add a `formatters` module with per-op pretty-print functions
- The op action handler in `ops.ts` checks `program.opts().json` — if true, `JSON.stringify`; if false, call the formatter
- Each formatter gets the result object and returns a formatted string

---

## Code References

| Component | File | Line |
|-----------|------|------|
| Op registry | `packages/core/src/ops/index.ts` | 30-167 |
| `dispatchOp` | `packages/core/src/ops/index.ts` | 169-192 |
| MCP tool registration | `packages/mcp/src/tools.ts` | 7-39 |
| MCP mode detection | `packages/mcp/src/index.ts` | 10-24 |
| MCP embedded context | `packages/mcp/src/server.ts` | 88-114 |
| MCP daemon context | `packages/mcp/src/server.ts` | 115-138 |
| MCP `ensureLocalUser` | `packages/mcp/src/server.ts` | 26-39 |
| CLI embedded context | `packages/cli/src/embedded.ts` | 18-48 |
| CLI auto-detection | `packages/cli/src/commands/ops.ts` | 92-97 |
| CLI init | `packages/cli/src/commands/init.ts` | 11-54 |
| CLI MinIO setup | `packages/cli/src/commands/init.ts` | 57-133 |
| Server app factory | `packages/server/src/app.ts` | 13-33 |
| Server daemon | `packages/server/src/daemon.ts` | 14-74 |
| Auth middleware | `packages/server/src/middleware/auth.ts` | 8-45 |
| RBAC | `packages/core/src/identity/rbac.ts` | 1-65 |
| Context resolution | `packages/core/src/identity/context.ts` | 13-86 |
| Config system | `packages/core/src/config.ts` | 1-130 |
| S3 key construction | `packages/core/src/ops/versioning.ts` | 10-13 |
| FTS5 indexing | `packages/core/src/search/fts.ts` | 1-65 |
| Embedding pipeline | `packages/core/src/search/pipeline.ts` | 1-148 |
| Schema | `packages/core/src/db/schema.ts` | 1-130 |
| Plugin manifest | `.claude-plugin/plugin.json` | 1-20 |
| Skill definition | `skills/agentfs/SKILL.md` | 1-207 |
| Command reference | `skills/agentfs/references/commands.md` | 1-769 |

---

## Methodology

Five parallel sub-agents analyzed each area:
1. **Core package**: All source files in `packages/core/src/` — database schema, operations, identity, search, config, errors
2. **CLI package**: All source files in `packages/cli/src/` — commands, embedded mode, API client
3. **MCP package**: All source files in `packages/mcp/src/` — MCP server, tool registration, mode detection
4. **Server package**: All source files in `packages/server/src/` — HTTP routes, middleware, daemon lifecycle
5. **Config/plugin**: `.mcp.json`, `.claude-plugin/`, `skills/`, `scripts/`, `.github/`, `install.sh`, tsconfigs, `thoughts/`

All source files were read in full (no sampling).

---

## Review Errata

_Reviewed: 2026-03-15 by Claude_

Verification: 13 claims cross-checked against source code. 12 accurate, 1 inaccurate (corrected below).

### Resolved

- [x] **`/auth/verify` ghost route** — Removed from `PUBLIC_PATHS` in `server/src/middleware/auth.ts`. Documented as inconsistency 6.G.
- [x] **`ls` performance fix** — Added `Delimiter: "/"` to `AgentS3Client.listObjects()` and refactored `ls.ts` to use S3's `CommonPrefixes` for directory entries instead of client-side filtering. Typecheck passes.
- [x] **Inaccurate claim: `ls` uses S3 delimiter** — Was inaccurate, now fixed in both the code and the document.
- [x] **Imprecise claim: `search` "silently" returns empty** — Corrected to note the `hint` field exists but is outside the declared interface.
- [x] **Missing inconsistency added** — `/auth/verify` ghost route added as section 6.G.
- [x] **Simplification section updated** — Sections A, B, C marked with Taras's decisions (REJECTED/PARKED) from file-review.
- [x] **Command audit added** — Section 9 with keep/remove/add proposals.
- [x] **CLI output format proposal added** — Section 10 with pretty-print default + `--json` flag.
