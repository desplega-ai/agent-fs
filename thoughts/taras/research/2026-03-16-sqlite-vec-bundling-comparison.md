---
date: 2026-03-16
researcher: claude
topic: "sqlite-vec bundling in agent-fs vs agent-swarm"
git_root: /Users/taras/Documents/code/agent-fs
branch: main
tags: [sqlite, sqlite-vec, bundling, vector-search, bun-compile]
status: complete
related:
  - thoughts/taras/research/2026-03-16-native-extensions-bun-compile.md
---

# Research: sqlite-vec Bundling — agent-fs vs agent-swarm

## Research Question

agent-fs has a complex multi-layer hack for bundling sqlite-vec (native `.dylib`/`.so` files alongside the compiled binary, custom SQLite swapping on macOS, try/catch fallback loading). Meanwhile, agent-swarm uses SQLite with vector search and requires none of these hacks. Why the difference, and how should agent-fs fix this?

## Summary

**The two projects use fundamentally different approaches to vector search.** agent-swarm does NOT use sqlite-vec at all — it stores embeddings as BLOBs in a regular SQLite column and computes cosine similarity in JavaScript (brute-force). agent-fs uses the `sqlite-vec` native extension which provides `vec0` virtual tables with KNN indexing. The "hacks" in agent-fs exist because shipping native SQLite extensions with `bun build --compile` is inherently complex — there is no clean way to embed `.dylib` files in Bun compiled binaries that `loadExtension()` can consume.

## Detailed Findings

### 1. agent-fs: Current sqlite-vec Architecture

agent-fs has a **4-layer sidecar system** to make sqlite-vec work:

#### Layer 1: macOS SQLite Replacement (`packages/core/src/db/setup-sqlite.ts`)

Apple's bundled SQLite and Bun's built-in SQLite both disable `sqlite3_load_extension()`. On macOS, this module swaps in Homebrew's SQLite via `Database.setCustomSQLite()` before any Database instance is created. It searches three paths in priority order:

1. `join(dirname(process.execPath), "libsqlite3.dylib")` — next to compiled binary
2. `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib` — Apple Silicon Homebrew
3. `/usr/local/opt/sqlite3/lib/libsqlite3.dylib` — Intel Homebrew

This is imported as a side-effect at `packages/core/src/db/index.ts:2`.

#### Layer 2: Try/Catch Extension Loading (`packages/core/src/db/index.ts:15-24`)

```ts
function loadSqliteVec(sqlite: Database): void {
  try {
    sqliteVec.load(sqlite);  // Dev mode: resolves via node_modules
  } catch {
    const execDir = dirname(process.execPath);
    sqlite.loadExtension(join(execDir, "vec0"));  // Compiled binary mode: adjacent file
  }
}
```

The npm wrapper's `sqliteVec.load()` uses `import.meta.url` to find `vec0.dylib` in `node_modules`. In `bun build --compile` binaries, `import.meta.url` doesn't resolve to real filesystem paths, so this fails. The fallback loads from the directory containing the executable.

#### Layer 3: Build Script (`scripts/build.sh`)

After `bun build --compile`, the script:
1. Finds `vec0.{dylib,so,dll}` inside `node_modules` for the target platform
2. Copies it to `dist/` next to the binary
3. On macOS, additionally copies Homebrew's `libsqlite3.dylib` to `dist/`

Resulting `dist/` contents: `agent-fs` + `vec0.dylib` + (macOS) `libsqlite3.dylib`.

#### Layer 4: Install Script + CI (`install.sh`, `.github/workflows/release.yml`)

- The install script moves all `.dylib`/`.so` files alongside the binary in `/usr/local/bin/`
- CI explicitly `bun add sqlite-vec-linux-arm64` for cross-compilation (x64 runner building arm64)
- CI installs Homebrew SQLite for macOS builds

#### What agent-fs Uses sqlite-vec For

- `vec0` virtual table: `chunk_vectors USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[768])`
- KNN queries: `WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
- 768-dimensional float vectors (from embedding provider)
- Defined at `packages/core/src/db/raw.ts:127-131`
- Queried at `packages/core/src/ops/search.ts:41-55`

### 2. agent-swarm: No Native Extensions

agent-swarm uses a completely different approach with **zero native dependencies beyond Bun itself**:

#### Approach: BLOB Storage + JS Cosine Similarity

- **SQLite library**: `bun:sqlite` (built into Bun, no external deps)
- **Schema**: `embedding BLOB` column in the `agent_memory` table — a plain BLOB, not a virtual table
- **Embedding model**: OpenAI `text-embedding-3-small`, **512 dimensions** (vs agent-fs's 768)
- **Serialization**: `Float32Array` → `Buffer` for BLOB storage
- **Search**: Brute-force — loads ALL rows with non-null embeddings, deserializes each BLOB to `Float32Array`, computes cosine similarity in a JS loop, sorts, returns top-K
- **Cosine similarity**: Pure JavaScript dot-product computation (`src/be/embedding.ts:43-63`)

#### Why It Works Without Hacks

1. No `loadExtension()` needed — there's no native extension
2. No `setCustomSQLite()` needed — Apple's SQLite is fine for regular BLOB storage
3. No build script copying — `bun build --compile` bundles everything since it's all JS
4. No sidecar files — the compiled binary is self-contained
5. Docker builds are trivial — just `bun build --compile`, single binary output

#### Design Decision (Documented)

From `thoughts/taras/plans/2026-02-20-memory-system.md:90`:
> **NOT using sqlite-vec**: Using BLOB storage + JS cosine similarity for simplicity. Works identically on macOS and Linux. Good for <10K vectors. sqlite-vec can be added later as optimization.

### 3. Comparison Matrix

| Aspect | agent-fs (sqlite-vec) | agent-swarm (BLOB + JS) |
|--------|----------------------|------------------------|
| Native deps | `vec0.dylib` + `libsqlite3.dylib` (macOS) | None |
| Build complexity | 4-layer sidecar system | `bun build --compile` only |
| Vector dimensions | 768 | 512 |
| Search method | KNN via `vec0` virtual table | Brute-force JS cosine |
| Scalability | Good for large datasets (indexed) | Good for <10K vectors |
| Cross-compilation | Requires platform-specific native binaries | Trivial |
| macOS support | Requires Homebrew SQLite | Works out of the box |
| Install complexity | Binary + sidecar `.dylib` files | Single binary |
| Insert | `INSERT INTO chunk_vectors` | `UPDATE agent_memory SET embedding = ?` |
| Query | `WHERE embedding MATCH ? ORDER BY distance` | Load all → JS cosine → sort → top-K |

### 4. Options for Fixing agent-fs

#### Option A: Switch to BLOB + JS Cosine (agent-swarm approach)

Eliminate sqlite-vec entirely. Store embeddings as BLOBs, compute similarity in JS.

**What changes:**
- Remove `sqlite-vec` dependency from `packages/core/package.json` and `packages/cli/package.json`
- Delete `packages/core/src/db/setup-sqlite.ts` entirely
- Remove the side-effect import in `packages/core/src/db/index.ts:2`
- Replace `loadSqliteVec()` in `packages/core/src/db/index.ts:15-24` with nothing
- Change `chunk_vectors` from `vec0` virtual table to regular table with `embedding BLOB`
- Rewrite `packages/core/src/ops/search.ts:37-55` to brute-force cosine
- Simplify `scripts/build.sh` (remove all native extension copying)
- Simplify `install.sh` (no `.dylib` handling)
- Simplify `.github/workflows/release.yml` (no Homebrew SQLite, no cross-platform sqlite-vec)
- Add `cosineSimilarity()` and serialization functions (can copy from agent-swarm's `embedding.ts`)

**Tradeoff:** Loses indexed KNN search. Brute-force works well for <10K vectors. agent-fs's file-based use case may or may not hit this limit depending on the user's drive size and chunking strategy.

#### Option B: Keep sqlite-vec, Clean Up the Sidecar

Keep the current approach but refine it. The existing prior research doc (`2026-03-16-native-extensions-bun-compile.md`) evaluates improvements:

1. **Extract-to-cache-dir**: Embed `vec0.dylib` in the binary via `import ... with { type: "file" }`, extract to `~/.cache/agentfs/` on first run. Eliminates sidecar files but still needs `setCustomSQLite` on macOS.
2. **Custom SQLite with static vec0**: Build `libsqlite3+vec0.dylib` as a single library. Reduces 2 native files to 1. Still needs sidecar or extraction.

Neither fully eliminates the complexity — it's inherent to native SQLite extensions with Bun compiled binaries.

#### Option C: Hybrid — BLOB Storage Now, sqlite-vec Later

Start with Option A (BLOB + JS cosine) which covers current scale. Add sqlite-vec back as an optimization only when vector count demonstrably exceeds the brute-force threshold. This matches agent-swarm's stated design rationale.

### 5. Scale Considerations for agent-fs

To evaluate whether brute-force cosine is viable for agent-fs:

- Each file in agent-fs gets chunked and each chunk gets a 768-dim embedding
- A `Float32Array(768)` is 3,072 bytes (3 KB per vector)
- Brute-force cosine over 10K vectors (768-dim) takes ~5-10ms in JS on modern hardware
- 10K chunks ≈ roughly 2,000-5,000 files (at ~2-5 chunks per file)
- For a personal/team file system, this is likely sufficient

If scaling beyond this becomes needed, options include:
- Re-adding sqlite-vec at that point
- Using a dedicated vector DB as a sidecar service
- Implementing approximate nearest neighbors in JS (e.g., HNSW)

## Code References

### agent-fs
- `packages/core/src/db/setup-sqlite.ts` — macOS SQLite swap
- `packages/core/src/db/index.ts:2` — side-effect import of setup-sqlite
- `packages/core/src/db/index.ts:15-24` — `loadSqliteVec()` try/catch
- `packages/core/src/db/index.ts:26-48` — `createDatabase()` full flow
- `packages/core/src/db/raw.ts:127-131` — `chunk_vectors` vec0 virtual table DDL
- `packages/core/src/ops/search.ts:37-55` — KNN vector query
- `packages/core/src/search/pipeline.ts:100-112` — vector insert
- `packages/core/src/ops/rm.ts:27-54` — vector cleanup on file delete
- `packages/core/src/test-utils.ts:37-44` — test DB with sqlite-vec
- `packages/core/package.json:15` — `sqlite-vec` dependency
- `scripts/build.sh` — native extension copying
- `install.sh:78-93` — native extension placement
- `.github/workflows/release.yml:26-51` — CI cross-platform build

### agent-swarm
- `src/be/db.ts:1,50,56-57` — `bun:sqlite` Database init
- `src/be/embedding.ts:24-26` — OpenAI embedding (512 dims)
- `src/be/embedding.ts:43-63` — JS cosine similarity
- `src/be/embedding.ts:68-80` — Float32Array ↔ Buffer serialization
- `src/be/db.ts:5336-5396` — brute-force vector search
- `src/be/migrations/001_initial.sql:271-287` — `agent_memory` schema (embedding BLOB)
- `thoughts/taras/plans/2026-02-20-memory-system.md:90` — design decision to skip sqlite-vec

### Prior Research
- `thoughts/taras/research/2026-03-16-native-extensions-bun-compile.md` — detailed analysis of native extension options with `bun build --compile`
