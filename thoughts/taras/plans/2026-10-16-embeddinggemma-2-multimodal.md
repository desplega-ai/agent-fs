---
date: 2026-10-16
planner: Claude
git_commit: b69b36b
branch: embeddinggemma
worktree: /Users/taras/worktrees/agent-fs/2026-10-16-embeddinggemma
repository: agent-fs
topic: EmbeddingGemma 2 local model, multimodal indexing (images, PDFs), deploy to my swarm
tags: [plan, search, embeddings, embeddinggemma, multimodal, pdf, transformers-js, my-swarm]
status: in-progress
autonomy: critical
commit_per_phase: true
last_updated: 2026-10-17
last_updated_by: Claude (review)
---

# EmbeddingGemma 2 and Multimodal Indexing Implementation Plan

## Overview

Add EmbeddingGemma 2 (`onnx-community/embeddinggemma-2-ONNX`, q8, on transformers.js) as a second local embedding model.
Then index PDF text for every provider, and images plus PDF page images when the model supports them.
Then show image and page matches in the CLI, MCP and live, and make EmbeddingGemma 2 the default for fresh indexes.
Run it on Taras's swarm (`fs.taras.cc`) after the text model ships, and again after multimodal ships.

- **Motivation**: on 208 files and 40 queries, prod today scores R@1 0.42. EmbeddingGemma 2 with images and PDF pages scores R@1 0.75 and R@5 1.00. On text only, the two models are within noise. The gain comes from multimodal search.
- **Related**:
  - Spike: `/Users/taras/Documents/code/agent-fs/thoughts/taras/research/2026-10-16-embeddinggemma-2-spike.md` (untracked, use the absolute path)
  - Planning research reports: `/tmp/eg2-plan/reports/*.md` (providers, index, write, surfaces, packaging, libs_tjs, libs_pdf, measure, swarm)
  - Planning measurement scripts and model cache: `/tmp/eg2-plan/measure/src/`, `/tmp/eg2-plan/tjs-cache/` (535 MB, q8 text + vision)
  - Code: `packages/core/src/search/`, `packages/core/src/ops/`, `packages/server/src/index.ts`, `live/src/components/search/`

## Decisions (Taras, 2026-10-16)

| Topic | Decision |
| --- | --- |
| Provider interface | Capability-based: `embedQuery`, `embedDocuments`, `supportsMime(mime)`, `embedParts(parts)`. No branching on `provider.name`. Each provider applies its own prefixes. |
| Model selection | `EMBEDDING_PROVIDER=local` plus `EMBEDDING_MODEL=embeddinggemma-2` or `nomic-embed-text-v1.5`. Empty `EMBEDDING_MODEL` means the default local model. More than one local model is supported. |
| Default local model | EmbeddingGemma 2 becomes the default for fresh indexes in the last phase, after multimodal ships. An index that nomic built stays on nomic (sticky rule). Nobody is forced to switch. |
| Format key | nomic keeps `local:v3`. EmbeddingGemma 2 uses `embeddinggemma:v2`. A model switch re-embeds the full index through the existing migration. |
| Runtime | transformers.js `@huggingface/transformers` 4.3.1 (exact pin), q8, CPU. No native sidecar. A root `overrides` entry makes chonkie use 4.3.1 too. |
| Dependency | Declared in the root `package.json` (private, so the Docker image installs it and npm never publishes it). Not in core, not in cli. `--external` in the CLI build. CLI users opt in with `bun add -g @desplega.ai/agent-fs`, then `bun add -g @huggingface/transformers@4.3.1`. `npm i -g` installs are not supported for EmbeddingGemma 2. Same rule for `@napi-rs/canvas`. |
| Model files | Download on first use into `$AGENT_FS_HOME/models` with a per-call `cache_dir`. Nothing baked into the Docker image. |
| Vision loading | Job-scoped: queries and text use a text-only instance. The image job loads a separate text+vision instance and disposes it when the job goes idle. |
| Dimensions | 768 for all providers. Configurable width is a later plan. |
| Display | `kind` and `page` fields on results, marker snippets (`[image]`, `[PDF page 3]`), and image thumbnails in the live search modal. One row per file stays. |
| Env precedence | Fixed in Phase 1: an explicit `EMBEDDING_PROVIDER` env var wins over `OPENAI_API_KEY` and `GEMINI_API_KEY`. |
| gemini-embedding-2 | Later plan. |
| Nomic prefixes | None. The spike showed no gain, and a change would force a re-embed for every `local` user. |

## Current State Analysis

### Provider interface and selection

- `EmbeddingProvider` has `name`, `dimensions`, `embed(text)`, `embedBatch(texts)` and an optional `dispose()` (`packages/core/src/search/embeddings/provider.ts:1-7`). It cannot tell a query from a document.
- Providers:
  - `local`: nomic-embed-text-v1.5 Q8_0 GGUF through node-llama-cpp. It loads lazily and downloads into `$AGENT_FS_HOME/models` (`embeddings/local.ts:27-48`). The #90 fix sets `contextSize` and `batchSize` to `trainContextSize` (`local.ts:41-48`).
  - `openai`: text-embedding-3-small at 768 dims (`embeddings/openai.ts:14-30`).
  - `gemini`: gemini-embedding-001 at 768 dims, one request per text (`embeddings/gemini.ts:15-34`).
- Providers return raw vectors. Callers normalize with `toUnitVector` (`search/vectors.ts:13-27`).
- Callers:
  - Documents: only `search/pipeline.ts:170` (`provider.embedBatch(texts)` in `indexFileEmbeddings`).
  - Queries: `ops/vec-search.ts:37` and `ops/search.ts:128` (`provider.embed(query)`).
- Selection order in `createEmbeddingProviderFromEnv` (`embeddings/index.ts:39-80`): `OPENAI_API_KEY`, then `GEMINI_API_KEY`, then `config.provider` with `config.apiKey`, then `local`.
- `config.ts:276-279` copies `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL` and `EMBEDDING_API_KEY` into `config.embedding`. No provider reads `config.embedding.model`.
- `getConfig` writes `DEFAULT_CONFIG` (with `provider: "local"`) to `config.json` on first run (`config.ts:306-311`). So `"local"` in a config file does not mean the user chose nomic.
- Telemetry reports any provider outside `{local, openai, gemini}` as `other` (`telemetry.ts:27, 163`).
- Prod (`agent-fs-taras` on Fly) has the secrets `EMBEDDING_PROVIDER` and `EMBEDDING_API_KEY`, and no `OPENAI_API_KEY` or `GEMINI_API_KEY` (`fly secrets list`, 2026-10-16). Prod selects OpenAI through config, not through key precedence.

### Index schema, pipeline and migration

- `content_chunks(id, file_path, drive_id, chunk_index, content NOT NULL, char_offset, token_count)` (`db/raw.ts:186-199`, `db/schema.ts:215-232`). It has no kind and no locator.
- `chunk_vectors` is `vec0(chunk_id, embedding float[768])` (`db/raw.ts:224-229`). The optional int8 index is `int8[768]` (`search/quantized-index.ts:27-40`). Its rows follow `content_chunks` deletes through a trigger. `chunk_vectors` rows need explicit deletes.
- FTS is one row per file (`files_fts_docs`, `db/raw.ts:206-264`).
- Schema migrations are idempotent `ALTER TABLE ADD COLUMN` steps in `db/migrate.ts` (pattern at `migrate.ts:58-65`).
- `files.embedding_status` is `pending | indexed | failed | NULL` (`db/raw.ts:54`). It is the only work list. There is no job table.
- Text indexing: FTS runs inline. Embedding runs in `scheduleEmbedding`, fire-and-forget, with a 2-permit semaphore (`search/pipeline.ts:45, 236-267`).
- `indexFileEmbeddings` chunks, embeds, then replaces all chunks of the file in one transaction with a version guard (`pipeline.ts:150-234`).
- Format migration: `embeddingFormat` is `${provider.name}:v${REVISIONS[name] ?? 2}`, with `REVISIONS = { local: 3 }` (`search/embedding-migration.ts:30-40`). On change, every `indexed` file becomes `pending` (`:43-65`). `runPendingEmbeddings` re-embeds them in keyset batches of 50, paced by `AGENT_FS_EMBEDDING_MIGRATION_CPU_SHARE` (default 0.25) (`:102-196`). It does not refresh FTS.
- `pauseForCpuShare`, `processCpuMs`, `migrationCpuShare` and `withEmbeddingSlot` are exported and reusable (`embedding-migration.ts:78-100`, `pipeline.ts:48-55`).
- The server starts the migration after `Bun.serve` (`packages/server/src/index.ts:101-110`). Shutdown does not await background jobs. Resume works through the `pending` status.

### Write path and MIME

- `decodeIndexableText` is the only text gate (`ops/mime.ts:104-118`). It accepts strict UTF-8 for text-like MIME types and SVG. Images and PDFs return `null`, so `indexBytesForSearch` calls `clearSearchData` (`ops/search-index.ts:65-79`).
- MIME comes from the file extension only (`MIME_MAP`, `ops/mime.ts:1-48`) and is stored in `files.content_type`.
- `write`, `cp` and `revert` go through `indexBytesForSearch`. `edit` and `append` call `indexFile` and `scheduleEmbedding` directly. `mv` re-paths chunks for text and clears the target for binary files (`ops/mv.ts:72-89`). `rm` deletes FTS, chunks and vectors inline (`ops/rm.ts:38-60`). `reindex` re-reads files with status `failed`, `NULL` or `pending` and redoes FTS and embeddings (`ops/reindex.ts:21-101`).
- Upload cap: 50 MiB for raw writes (`config.ts:4-11`).

### Query path and display

- Hybrid search fuses vector and FTS results with RRF, keyed by path (`ops/search.ts:28-111`). Results are `{path, score, snippet, author?, modifiedAt?}` (`search.ts:11-17`).
- Vector candidates keep the best chunk per file. The snippet is `content.slice(0, 200)` (`search/vector-candidates.ts:139-191`).
- CLI `formatSearch` prints path, score and snippet (`packages/cli/src/formatters.ts:187-200`). MCP returns the op JSON as text (`packages/mcp/src/tools.ts:35-40`). Live `ResultRow` shows glyph, name, score and an optional snippet (`live/src/components/search/SearchModal.tsx:~255-305`).
- Live opens a hit with `selectFile(path)` (`live/src/contexts/browser.tsx:64-71`). `PdfViewer` renders an iframe from a signed URL and has no page prop (`live/src/components/viewers/PdfViewer.tsx:31-37`). `useSignedUrl(path, disposition)` exists (`live/src/hooks/use-signed-url.ts:18`).

### Packaging and deploy

- `node-llama-cpp` is a regular dependency of core and cli. The CLI build marks 14 packages `--external` (`packages/cli/package.json:29`).
- The install layout is per-package:
  - `packages/cli/node_modules` holds only CLI deps, `packages/core/node_modules` holds core deps, and root `node_modules` holds root deps.
  - The image runs `packages/cli/dist/cli.js`. It resolves from `packages/cli/node_modules`, then `/app/node_modules`.
  - A dependency declared only in `packages/core` is invisible to it.
- chonkie 0.3.0 already pulls `@huggingface/transformers` 3.8.1, `onnxruntime-node` 1.21.0 and sharp. chonkie uses it for its `Xenova/gpt2` tokenizer.
  - transformers 3.8.1 statically imports `onnxruntime-node` 1.21 (`node_modules/.bun/@huggingface+transformers@3.8.1/.../src/backends/onnx.js:23`).
  - `chunkContent` runs before every document embed, so ORT 1.21 loads before ORT 1.30.
  - On Linux, both ship `libonnxruntime.so.1` with the same SONAME. The second binding may bind to the first library and fail.
  - macOS dylibs carry versioned install names. So a Mac test can pass while Linux fails.
- Docker: `oven/bun:1.4.1` (Debian glibc), `WORKDIR /app`, `bun install --frozen-lockfile --production` in the runtime stage, `AGENT_FS_HOME=/data`. Multi-arch images build only at tag time (`docker-publish.yml`). No PR job builds the main `Dockerfile`.
- Every merge to `main` deploys prod through `fly-deploy.yml`. Prod runs on `shared-cpu-1x`, 2 GB (`fly.toml:40-43`).
- E2E forces `EMBEDDING_PROVIDER=openai` with empty keys, so no model downloads in CI (`scripts/e2e.ts:98-105, 270-273`). No E2E covers embeddings.

### Measured facts (planning spike, M2 Pro CPU, transformers.js 4.3.1 q8)

- Text-only load: 0.43 to 0.46 GB RSS at rest, about 0.84 GB after chunk embeds, 1.02 to 1.10 GB peak. Load takes about 0.45 s warm.
- Text+vision: the vision weights add about 0.3 GB at rest. Image activations push RSS to 1.2 to 1.9 GB, and RSS grows with each image.
- transformers.js has no public API to add the vision encoder to a loaded model. A second instance loads the mmapped text weights again (about 0.4 s).
- Image token budget (`processor.image_processor.max_soft_tokens`, allowed 70, 140, 280, 560, 1120): 280 takes 3.8 s per image, 140 takes 1.7 s, 70 takes 0.9 s. At 70, the invoice image keeps only cosine 0.78 to the 280 vector. All 7 test queries still rank their own image first.
- Batching texts gives identical vectors (cosine 1.0). Padding to the longest text makes mixed batches about 2x slower.
- `onnxruntime-node` 1.30.0 ships glibc binaries for linux x64 and arm64, darwin arm64 and win32. It has no darwin x64 and no musl build. sharp is a hard import of transformers.js.
- EmbeddingGemma 2: context 8192 tokens, `sentence_embedding` is already unit length, apache-2.0, not gated.

### My swarm (read-only checks, 2026-10-16)

- Hetzner cx33, 4 vCPU, 7.7 GB RAM, 5.9 GB available, no swap, 35 GB free disk.
- `agent-fs` service: `ghcr.io/desplega-ai/agent-fs:${AGENT_FS_VERSION:-0.16.7}`, `platform: linux/amd64`, volume `agent_fs_data` at `/data`, no memory limit.
- Compose maps `EMBEDDING_PROVIDER=${AGENT_FS_EMBEDDING_PROVIDER:-local}` and `EMBEDDING_MODEL=${AGENT_FS_EMBEDDING_MODEL:-}`. The swarm `.env` sets neither, so the container runs `local` with an empty model.
- Index: 34 files, 170 chunks, `meta.embedding_format = local:v3`, 3 images, no PDFs. `/data/models` already holds the nomic GGUF.
- `docker stats`: agent-fs 259 MiB, api 633 MiB, lead 368 MiB.

## Desired End State

- `EMBEDDING_PROVIDER=local EMBEDDING_MODEL=embeddinggemma-2` runs EmbeddingGemma 2 q8 on CPU with task prefixes. Its vectors match the sentence-transformers reference at cosine 0.999 or better.
- An explicit `EMBEDDING_PROVIDER` env var wins over API keys. Prod keeps OpenAI with no re-embed.
- PDFs are searchable by text with every provider. Text chunks carry a page number.
- With EmbeddingGemma 2, image files and the first 3 PDF pages (as images) are embedded by a paced background job. Their matches appear in `search` and `vec-search` with `kind: "image"`, an optional `page`, and a marker snippet.
- The CLI prints the markers and pages. The live search modal shows a chip, an image thumbnail, and opens PDFs at the matched page.
- A fresh index with transformers installed uses EmbeddingGemma 2 by default. An index that nomic built stays on nomic.
- The swarm runs EmbeddingGemma 2 with multimodal indexing. Its RSS, query latency and re-embed time are recorded in this plan.

Verify the end state with the Manual E2E section.

## What We're NOT Doing

- No configurable vector width. Every provider stays at 768.
- No gemini-embedding-2 provider.
- No prefixes for nomic, OpenAI or Gemini. Their vectors and format keys do not change.
- No llama.cpp sidecar, no node-llama-cpp path for EmbeddingGemma 2, no GPU or CoreML execution provider.
- No model files in the Docker image.
- No audio or video embedding.
- No MIME sniffing for images or PDFs saved without an extension.
- No garbled-PDF-text detection.
- No re-embed on rename. Under EmbeddingGemma 2, a renamed file keeps the old filename in its document prefix until its content changes.
- No per-page result rows. Search keeps one row per file, with the best unit's page.
- No change to how `mv` handles the pre-existing duplicate-chunk gap for text files (see Derail notes).

## Implementation Approach

- Rename the interface first, with byte-identical behavior for existing providers. Then add EmbeddingGemma 2 behind `EMBEDDING_MODEL`. Ship and measure it on the swarm before multimodal work.
- A dual-runtime spike runs before any provider code. It checks that chonkie's ORT and the EmbeddingGemma 2 ORT load in one Linux process.
- The server warms the provider up before any format migration. A provider that cannot load never changes the stored format.
- PDF text rides the existing text pipeline. `extractIndexableText` turns PDF bytes into text plus page start offsets. FTS, chunking, embedding, `reindex` and the format migration all reuse it.
- Images and PDF page images use a second, independent work list: `files.image_embedding_status` plus `content_chunks.kind`. The text job replaces only `kind = 'text'` chunks. The image job replaces only `kind = 'image'` chunks. They never overwrite each other.
- Deletes are kind-scoped. Only `rm` deletes both kinds.
- The image job is a paced, single-flight background loop. A binary write marks the file pending and kicks the loop. Boot resumes pending work. It reuses `pauseForCpuShare`, `withEmbeddingSlot` and the version guard.
- The image job starts after the text migration ends. The two jobs never run at the same time.
- The provider owns its vision lifecycle. `embedParts` creates the text+vision instance on demand. It disposes it after 60 s idle, and recreates it after 50 images. The interface stays the four decided members.
- Every phase keeps prod (OpenAI) working. Each code phase is one PR with one release.
- Implementation spans at least two sessions. Break after Phase 3 (the swarm milestone).

### PR and release map

Versions assume `main` stays at 0.16.7 until Phase 1 merges. If `main` moved, use the next free version of the same kind.

| Phase | Branch | Release | Prod (OpenAI) effect |
| --- | --- | --- | --- |
| 1. Provider interface + precedence | `eg2/p1-provider-interface` | 0.17.0 (minor: env precedence changes) | None. Format `openai:v2` stays. |
| 2. EmbeddingGemma 2 text model | `eg2/p2-embeddinggemma-text` | 0.17.1 | None. The image swaps chonkie's transformers 3.8.1 for 4.3.1 (one ORT). |
| 3. Swarm deploy + measure | none (ops) | none | None |
| 4. PDF text indexing | `eg2/p4-pdf-text` | 0.17.2 | Existing PDFs are embedded once through OpenAI at boot. |
| 5. Image and PDF-page embedding | `eg2/p5-multimodal` | 0.17.3 | None. OpenAI does not support images, so no image work runs. |
| 6. Display | `eg2/p6-display` | 0.17.4 | CLI and live show page numbers for PDF text hits. |
| 7. Default for fresh indexes | `eg2/p7-default` | 0.18.0 (minor: new default) | None. Prod sets `EMBEDDING_PROVIDER=openai`. |

- Each phase starts after the previous PR merges: `git fetch origin && git switch -c <branch> origin/main`.
- **Implementation override (Taras, 2026-10-17)**: all phases stack on the `embeddinggemma` branch in this worktree, not on per-phase branches. Before a PR opens, the branch takes in the current `origin/main`, and the PR adapts to it.
  - At the start, `main` was 0.16.8 (`0a40d53`). #93 removed the int8 index (`quantized-index.ts`) and moved the vector KNN to a worker thread (`search/vector-worker.ts`). #95 moved prod to `performance-1x`.
  - So the int8 steps in this plan are void. `page` and `kind` (Phases 4 and 5) also go through the worker query in `vector-worker.ts`.
  - **Version shift (2026-10-17)**: #100 (retry failed embeddings once, skip blank text, split OpenAI requests) took 0.17.1. So every later release moves up one patch: Phase 2 ships as 0.17.2, Phase 4 as 0.17.3, Phase 5 as 0.17.4, Phase 6 as 0.17.5. Phase 7 stays 0.18.0. Read "0.17.1" in Phase 3 and in the swarm steps as 0.17.2, and "0.17.4" in Manual E2E §3 as 0.17.5.
  - #100 also re-queues `failed` files once per format and `FAILED_RETRY` revision, and skips blank text in `indexFileEmbeddings` and the migration. So the Phase 2 "re-queue failed files on a format change" item is covered by main, and part of Phase 4 §5 (empty chunk list) may already hold. Check before coding Phase 4.
  - Taras authorized PR merges through the merge queue on 2026-10-17 (overnight). The Phase 3 swarm backup, `.env` edit and deploy still need his explicit approval.
- Before `./scripts/release.sh`, each phase runs `bun install --frozen-lockfile` and `bun run scripts/sync-versions.ts --check`. Both run again after the release commit.
- Taras merges through the merge queue. Never push to `main`.

## Quick Verification Reference

Run from the worktree root (`/Users/taras/worktrees/agent-fs/2026-10-16-embeddinggemma`). It has no `.env`. Never copy the repo `.env` into it.

- Typecheck: `bun run typecheck`
- Unit tests: `bun run test`
- CLI bundle: `bun run build`
- Version sync: `bun run scripts/sync-versions.ts --check`
- Lockfile: `bun install --frozen-lockfile`
- E2E, credential-free: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only`
- E2E, full (Docker MinIO): `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"`
- Live UI: `cd live && pnpm build`
- Scratch, model cache and downloads go under `/tmp/eg2-plan/` only. Never use `~/.cache` or `~/.agent-fs`.

### Index invariant queries

Read-only checks on an `agent-fs.db`. Phases 3, 4 and 5 and both swarm checks (Phase 3, Manual E2E §3) use them. Expect every number to be `0`.

- Chunks without a vector: `SELECT count(*) FROM content_chunks c LEFT JOIN chunk_vectors v ON v.chunk_id=c.id WHERE v.chunk_id IS NULL`
- Vectors without a chunk: `SELECT count(*) FROM chunk_vectors v LEFT JOIN content_chunks c ON c.id=v.chunk_id WHERE c.id IS NULL`
- Failed files: `SELECT count(*) FROM files WHERE is_deleted=0 AND (embedding_status='failed' OR image_embedding_status='failed')`. The image column exists from Phase 5.
- When the int8 index is on: `SELECT count(*) FROM chunk_vectors_int8` equals `SELECT count(*) FROM content_chunks`.

Save this as `/tmp/eg2-plan/scripts/index-invariants.js`. It loads `sqlite-vec`, because `chunk_vectors` is a `vec0` table. It skips the image column and the int8 table when they do not exist.

```js
const { Database } = require("bun:sqlite");
if (process.platform === "darwin") Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
const db = new Database(process.env.DB || "/data/agent-fs.db", { readonly: true });
require("sqlite-vec").load(db);
const n = (sql) => db.query(sql).get().n;
const fileCols = db.query("PRAGMA table_info(files)").all().map((c) => c.name);
const imageFailed = fileCols.includes("image_embedding_status") ? " OR image_embedding_status = 'failed'" : "";
const int8 = db.query("SELECT 1 FROM sqlite_master WHERE name = 'chunk_vectors_int8'").get();
console.log({
  chunksWithoutVector: n("SELECT count(*) AS n FROM content_chunks c LEFT JOIN chunk_vectors v ON v.chunk_id = c.id WHERE v.chunk_id IS NULL"),
  vectorsWithoutChunk: n("SELECT count(*) AS n FROM chunk_vectors v LEFT JOIN content_chunks c ON c.id = v.chunk_id WHERE c.id IS NULL"),
  failedFiles: n(`SELECT count(*) AS n FROM files WHERE is_deleted = 0 AND (embedding_status = 'failed'${imageFailed})`),
  int8MinusChunks: int8 ? n("SELECT count(*) AS n FROM chunk_vectors_int8") - n("SELECT count(*) AS n FROM content_chunks") : 0,
});
```

- Local home: `cd /Users/taras/worktrees/agent-fs/2026-10-16-embeddinggemma/packages/core && DB=<home>/agent-fs.db bun run - < /tmp/eg2-plan/scripts/index-invariants.js`
- Swarm: `ssh swarm-taras 'docker exec -i -w /app/packages/cli/dist my-swarm-agent-fs-1 bun run -' < /tmp/eg2-plan/scripts/index-invariants.js`
- `bun run -` reads the script from stdin and resolves `sqlite-vec` from the current directory.

---

## Phase 1: Capability-based provider interface and env precedence

### Overview

Deliverable: `EmbeddingProvider` exposes `embedQuery(text)` and `embedDocuments(texts, { title })` instead of `embed` and `embedBatch`. An explicit `EMBEDDING_PROVIDER` env var wins over API keys. nomic, OpenAI and Gemini send the same inputs as before, so their vectors and format keys do not change.

### Changes Required:

#### 1. Interface
**File**: `packages/core/src/search/embeddings/provider.ts`
**Changes**:
- Replace `embed` and `embedBatch` with:
  - `embedQuery(text: string): Promise<number[]>`
  - `embedDocuments(texts: string[], opts: { title: string }): Promise<number[][]>`
- `title` is the file's basename. Providers that use no prefix ignore it.
- Keep `name`, `dimensions` and `dispose?`. Do not add `supportsMime` or `embedParts` yet. Phase 5 adds them with their first caller.

#### 2. Existing providers
**Files**: `packages/core/src/search/embeddings/local.ts`, `openai.ts`, `gemini.ts`
**Changes**: Rename the methods. Both methods send the raw text, exactly as today. No prefixes.

#### 3. Callers
**Files**: `packages/core/src/search/pipeline.ts:170`, `packages/core/src/ops/search.ts:128`, `packages/core/src/ops/vec-search.ts:37`
**Changes**:
- `pipeline.ts`: `provider.embedDocuments(texts, { title: basename(params.path) })`.
- `search.ts` and `vec-search.ts`: `provider.embedQuery(query)`.
- Keep `toUnitVector` at the callers.

#### 4. Env precedence
**File**: `packages/core/src/search/embeddings/index.ts`
**Changes**:
- If `process.env.EMBEDDING_PROVIDER` is set and not empty, build that provider first.
  - `openai` takes `config.apiKey`, else `OPENAI_API_KEY`. `config.apiKey` already includes `EMBEDDING_API_KEY` (`config.ts:279`), and it keeps a key from `config.json`.
  - `gemini` takes `config.apiKey`, else `GEMINI_API_KEY`.
  - A missing key logs one line and returns `null`, as today. E2E relies on this.
- Without the env var, keep today's order unchanged.
- Update the doc comment on `createEmbeddingProviderFromEnv`.

#### 5. Tests
**Files**: `packages/core/src/search/__tests__/embedding-factory.test.ts`, `embedding-migration.test.ts`, `quantized-index.test.ts`, `packages/core/src/ops/__tests__/search-regressions.test.ts`, `packages/server/src/__tests__/embedding-errors.test.ts`, `packages/core/src/__manual_tests__/embedding.test.ts`, `local-embedding.test.ts`
**Changes**:
- Move the inline fake providers to the new methods.
- Add precedence cases:
  - `EMBEDDING_PROVIDER=local` with `OPENAI_API_KEY` set gives `local`.
  - `EMBEDDING_PROVIDER=gemini` with `OPENAI_API_KEY` set gives `gemini`.
  - `EMBEDDING_PROVIDER=openai` with only `EMBEDDING_API_KEY` gives `openai` (the prod case).
  - `EMBEDDING_PROVIDER=openai` with the key only in `config.json` gives `openai`.
  - `EMBEDDING_PROVIDER=openai` with no key gives `null` (the E2E case).
  - No `EMBEDDING_PROVIDER` with `OPENAI_API_KEY` gives `openai` (unchanged).
- Assert that `embeddingFormat` stays `local:v3`, `openai:v2` and `gemini:v2`.
- Assert that the OpenAI and Gemini request bodies carry the raw text (mock the SDK clients).
- Assert that `pipeline.ts` passes the basename as `title`.

#### 6. Docs and release
**Files**: `DEPLOYMENT.md` (env table and a short "Upgrading to 0.17.0" note on precedence), `skills/agent-fs/SKILL.md` (only if it describes provider selection)
**Changes**: Document the new precedence. Run `./scripts/release.sh 0.17.0` as the last commit of the PR.

### Success Criteria:

#### Automated Verification:
- [x] Typecheck passes: `bun run typecheck`
- [x] Unit tests pass: `bun run test`
- [x] No old method names remain: `grep -rnE "\bembed\(|embedBatch\(" packages/*/src --include=*.ts` prints nothing
- [x] Build passes: `bun run build`
- [x] E2E local mode passes: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only` (185/185, 18 skipped)
- [ ] Full E2E passes: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"` (207/208 after the rebase on `deca707`. The one failure, `share-create returns a public link on the API host`, fails the same way on clean `origin/main` `0a40d53`. It is not from this phase.)
- [x] Lockfile and versions are clean before release: `bun install --frozen-lockfile && bun run scripts/sync-versions.ts --check`
- [x] Versions in sync after release: `bun run scripts/sync-versions.ts --check` (0.17.0, PR #97)

#### Automated QA:
- [x] Start a throwaway daemon with `AGENT_FS_HOME=/tmp/eg2-plan/p1-home EMBEDDING_PROVIDER=local OPENAI_API_KEY=sk-dummy` and confirm from its log that the local provider loads (not OpenAI). Stop it and delete `/tmp/eg2-plan/p1-home`. (2026-10-17: nomic downloaded and loaded, `local:v3` stored, no OpenAI lines.)
- [x] After the PR merges and Fly deploys: fetch `https://agent-fs-taras.fly.dev/health` (with `ctx_execute`, since a hook blocks curl) and confirm `version` is `0.17.0`. Confirm `fly status -a agent-fs-taras` shows the machine `started` with passing checks. (2026-10-17: #97 merged as `3720089`. `/health` reports 0.17.0, and the machine is started with 1/1 checks passing.)

#### Manual Verification:
- [ ] Taras confirms prod search still returns results after the deploy (this needs a fresh prod API key, because the stored one is invalid since 2026-09-22).

**Implementation Note**: After this phase, pause for manual confirmation. Then commit `[phase 1] capability-based embedding provider interface`, run `bun install --frozen-lockfile` and `bun run scripts/sync-versions.ts --check`, run `./scripts/release.sh 0.17.0`, and open the PR.

---

## Phase 2: EmbeddingGemma 2 text model on transformers.js

### Overview

Deliverable: `EMBEDDING_PROVIDER=local EMBEDDING_MODEL=embeddinggemma-2` embeds text with EmbeddingGemma 2 q8 and task prefixes. The model downloads into `$AGENT_FS_HOME/models` on first use. The Docker image runs it on `linux/amd64` and `linux/arm64`. Release 0.17.1.

### Changes Required:

#### 0. Dual-runtime spike (before any provider code)
**Files**: scratch only, under `/tmp/eg2-plan/dual-runtime/`
**Changes**:
- Goal: check that chonkie's transformers 3.8.1 (ORT 1.21) and EmbeddingGemma 2 on 4.3.1 (ORT 1.30) load in one Linux process.
- Use a scratch project with `chonkie@0.3.0` and `@huggingface/transformers@4.3.1` and no `overrides`, so both ORT versions install.
- Run it in a `linux/arm64` container. Also run it in `linux/amd64` if QEMU allows.
- In ONE bun process: run chonkie `RecursiveChunker` on a text, then load EmbeddingGemma 2 q8 text-only and embed one query.
- Record pass or fail for each platform in the Appendix.

#### 1. Dependency and bundle
**Files**: `package.json` (root), `packages/cli/package.json`, `bun.lock`
**Changes**:
- Add `"@huggingface/transformers": "4.3.1"` (exact) to the root `package.json` `dependencies`. Do not list it in core or cli.
  - The root is `private: true`, so npm never publishes it. The Docker image installs it into `/app/node_modules`.
  - Core typechecks through walk-up resolution to the root.
- Add `"@huggingface/transformers": "4.3.1"` to the existing root `overrides`. chonkie then also uses 4.3.1 in the workspace and in Docker: one ORT, about 300 MB less in the image.
- Check that chonkie still chunks the same:
  - Write `/tmp/eg2-plan/scripts/chunk-compare.ts`. It imports `chunkContent` from the worktree source by absolute path and prints `{content, charOffset, tokenCount}` for every chunk of 20 repo markdown files as JSON.
  - Before the override, save its output to `/tmp/eg2-plan/chunks-before.json`. After the override, compare (see Automated Verification).
- Add `--external @huggingface/transformers` to the CLI `build:npm` script.
- Run `bun install`, then commit `bun.lock`. Bun reports blocked postinstalls for `onnxruntime-node` and `protobufjs`. That is expected. The binaries ship in the tarball. Do not add `trustedDependencies`.

#### 2. Provider
**File**: `packages/core/src/search/embeddings/embeddinggemma.ts` (new)
**Changes**:
- `class EmbeddingGemmaProvider implements EmbeddingProvider`, `name = "embeddinggemma"`, `dimensions = 768`.
- Export a small helper `loadTransformers()`. The doctor (§5) and the Phase 7 resolver reuse it.
  - It runs `await import("@huggingface/transformers")` and requires `mod.env.version === "4.3.1"`.
  - `Bun.resolveSync` alone is not enough. A hoisted transformers 3.x also passes `import()` and `Bun.resolveSync`.
  - An import failure or another version counts as missing. The helper reports the reason, for example `missing (found 3.8.1)`.
  - **Linux guard (added 2026-10-17 after the §0 spike failed on Linux, Taras chose "guard now, swap later")**: on Linux, the helper also reads the version of the `@huggingface/transformers` that chonkie resolves. If it is not 4.3.1, the result is missing, with a reason that names chonkie's version and says to use the Docker image. Two ONNX runtimes cannot load in one Linux process. In Docker and in the workspace, the root override gives chonkie 4.3.1, so the guard passes.
- Lazy init, single-flight like `local.ts`:
  - Call `loadTransformers()`. If transformers is missing, throw an `Error` that says: `EMBEDDING_MODEL=embeddinggemma-2 needs @huggingface/transformers 4.3.1 (<reason>). Run: bun add -g @huggingface/transformers@4.3.1`.
  - Each instance loads its own config, because the text instance changes its config: `AutoConfig.from_pretrained(MODEL, { cache_dir })`. Then set `config.vision_config = null` and `config.audio_config = null`.
  - `AutoProcessor.from_pretrained(MODEL, { cache_dir })`.
  - `AutoModel.from_pretrained(MODEL, { config, dtype: "q8", device: "cpu", cache_dir })`.
  - `cache_dir = join(getHome(), "models")`. Pass it per call. Never set the global `env.cacheDir` or `env.allowRemoteModels`.
  - Reason: with the root override, chonkie and the provider share one transformers module in Docker. A global `env` change would also change how chonkie loads its gpt2 tokenizer.
  - When init rejects, clear `initPromise`, so the next call retries (§4).
  - Log `[agent-fs] Resolving local embedding model...` and `[agent-fs] Model ready: embeddinggemma-2` to stderr. The swarm log greps use these lines.
- `embedQuery(q)`: embed `task: search result | query: ${q}`.
- `embedDocuments(texts, { title })`: embed `title: ${title} | text: ${text}` for each text, one forward pass per text. No batching (padding makes mixed batches 2x slower).
- Read `sentence_embedding` and return the 768 floats.
- #90 guarantee: one forward pass takes the whole sequence. Do not enable truncation. If the tokenized input exceeds 8192 tokens, throw `EmbeddingProviderError`. The chunker never produces that.
- `dispose()` disposes the model.

#### 3. Model selection
**Files**: `packages/core/src/search/embeddings/index.ts`, `packages/core/src/config.ts`
**Changes**:
- In `createEmbeddingProvider`, `case "local"` reads `config.model`:
  - `""` or `nomic-embed-text-v1.5`: `LocalEmbeddingProvider` (unchanged default in this phase).
  - `embeddinggemma-2`: `EmbeddingGemmaProvider`.
  - Anything else: throw `Unknown local embedding model: <value>. Use nomic-embed-text-v1.5 or embeddinggemma-2.`
  - The throw happens inside the factory's try/catch. So an unknown model gives a `null` provider plus one stderr line.
- Export the two model ids as constants.
- `openai` and `gemini` ignore `config.model`, with no warning. Onboarding writes model names for those providers (`onboard.ts:150,158`).

#### 4. Boot gate
**Files**: `packages/server/src/index.ts`, `packages/core/src/search/embeddings/local.ts`, `packages/core/src/search/embeddings/embeddinggemma.ts`, `packages/core/src/search/embedding-migration.ts`
**Changes**:
- In the background chain after `Bun.serve`, compare the stored format with `embeddingFormat(provider)`. Only when they differ, run `await provider.embedQuery("warmup")` BEFORE `prepareEmbeddingMigration`.
  - So a normal boot makes no extra call. Prod (OpenAI) does not send a warmup request on every deploy.
- On failure: log the error, skip the migration, and keep the stored format.
- Do not block `Bun.serve`. The first model download can take minutes.
- `local.ts` and `embeddinggemma.ts` clear `initPromise` when init rejects, so the next call retries.
- In `prepareEmbeddingMigration`, a format change re-queues `indexed` AND `failed` files.
- Test: a provider whose init throws leaves `meta.embedding_format` unchanged and queues nothing.

#### 5. Doctor
**File**: `packages/cli/src/commands/config-cmd.ts` (`config validate` at `:58`, embeddings block `:141-170`, local branch `:164-169`)
**Changes**:
- The doctor is `agent-fs config validate`. It runs on the client and may point at a remote daemon.
- So it prints only the configured local model and whether transformers 4.3.1 loads locally (`loadTransformers()`).
- If transformers does not load, it prints the reason and the install command.
- The model the daemon really uses comes from the daemon boot log.
- Telemetry needs no change: it reports `config.embedding.provider`, which stays `local` (`telemetry.ts:156-163`).

#### 6. E2E opt-in mode
**File**: `scripts/e2e.ts`
**Changes**:
- Add `--local-model <id> --models-dir <dir>`.
  - Parse both with `rawArgs.indexOf`, and exclude their values from `positional`.
  - Update the usage line at `e2e.ts:31`.
- The mode sets `EMBEDDING_PROVIDER=local` and `EMBEDDING_MODEL=<id>`. It symlinks `<AGENT_FS_HOME>/models` to `<dir>` so no download runs. It clears the forced `openai` env.
- Add one test, skipped without the flag: write two markdown files on unrelated topics, poll `vec-search` (timeout 120 s) until both are indexed, and assert that a paraphrased query ranks the right file first.
- CI keeps running without the flag.

#### 7. Manual model test
**File**: `packages/core/src/__manual_tests__/embeddinggemma.test.ts` (new)
**Changes**:
- Skip unless `AGENT_FS_TEST_EMBEDDINGGEMMA_HOME` is set. Use that dir as `AGENT_FS_HOME`.
- Assert 768 dims and unit norm.
- Assert that a cat query ranks a cat document over a car document.
- Assert that a text of about 1600 tokens embeds without truncation: the processor's `input_ids` length equals the tokenizer's token count.

#### 8. Docs and skill
**Files**: `DEPLOYMENT.md`, `skills/agent-fs/SKILL.md`, `.env.example`
**Changes**:
- Env table: `EMBEDDING_MODEL` selects the local model (`nomic-embed-text-v1.5`, `embeddinggemma-2`). OpenAI and Gemini ignore it.
- New section "Using EmbeddingGemma 2 (0.17.1)":
  - 339 MB download on first use into `$AGENT_FS_HOME/models`.
  - RSS about 0.5 GB at rest, about 1.1 GB peak on text.
  - A switch re-embeds every file, paced by `AGENT_FS_EMBEDDING_MIGRATION_CPU_SHARE`. Search quality drops until the run finishes.
  - CLI installs: `bun add -g @desplega.ai/agent-fs`, then `bun add -g @huggingface/transformers@4.3.1`. The Docker image includes it.
  - `npm i -g` installs are not supported for EmbeddingGemma 2. The CLI's own `node_modules` holds chonkie's transformers 3.8.1 first.
  - Linux global installs: not supported (the §0 spike: chonkie's ORT 1.21 and ORT 1.30 cannot share one Linux process). Linux uses the Docker image. macOS global installs work. The Phase 2 Automated QA confirms both with the packed CLI.
  - Unsupported: Intel Macs (no `onnxruntime-node` darwin x64 binary) and Alpine/musl.
- Fix the stale "512 MB default" in "Instance Sizing" (`fly.toml` says 2 GB).
- Skill: mention `EMBEDDING_MODEL` where the skill describes setup or providers.

### Success Criteria:

#### Automated Verification:
- [x] Lockfile is committed and frozen, and versions are in sync before release: `bun install --frozen-lockfile && bun run scripts/sync-versions.ts --check`
- [x] chonkie still chunks the same with the override: `bun test packages/core/src/search/__tests__/chunker.test.ts` (5 pass)
- [x] Chunk boundaries are identical before and after the override: `bun /tmp/eg2-plan/scripts/chunk-compare.ts > /tmp/eg2-plan/chunks-after.json && cmp /tmp/eg2-plan/chunks-before.json /tmp/eg2-plan/chunks-after.json` (98 chunks over 20 files snapshotted in `/tmp/eg2-plan/chunk-inputs/`, identical. The lockfile now holds only transformers 4.3.1 and onnxruntime-node 1.30.0.)
- [x] Typecheck passes: `bun run typecheck`
- [x] Unit tests pass (no model download), including the boot gate test: `bun run test` (1471 pass, 60 skip, 0 fail)
- [x] Bundle keeps transformers external: `bun run build && grep -q 'import("@huggingface/transformers")' packages/cli/dist/cli.js && ! grep -q "onnxruntime-node" packages/cli/dist/cli.js`
- [x] E2E local mode passes without the flag: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only` (186/186, 19 skipped)
- [ ] Full E2E passes: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"` (207/208. Only the pre-existing `share-create returns a public link on the API host` failure, as on `main`.)
- [x] Manual model test passes with the planning cache: `mkdir -p /tmp/eg2-plan/p2-home && ln -sfn /tmp/eg2-plan/tjs-cache /tmp/eg2-plan/p2-home/models && AGENT_FS_TEST_EMBEDDINGGEMMA_HOME=/tmp/eg2-plan/p2-home bun test packages/core/src/__manual_tests__/embeddinggemma.test.ts` (3 pass)
- [x] E2E with the real model passes: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only --local-model embeddinggemma-2 --models-dir /tmp/eg2-plan/tjs-cache` (187/187, including "local model ranks a paraphrased query")
- [x] Versions in sync after release: `bun run scripts/sync-versions.ts --check` (0.17.2)

#### Automated QA:
- [x] The dual-runtime spike (§0) result is in the Appendix for `linux/arm64`, and for `linux/amd64` if QEMU allowed it. (Both FAIL. darwin passes. See the Appendix.)
- [x] Offline load (added 2026-10-17): transformers 4.3.1 sends a Range request for `tokenizer_config.json` to huggingface.co on every load by model id, even with every file cached (`tokenization_utils.js:35` calls `get_tokenizer_files` without `cache_dir`). Offline, the load failed. The provider now loads from the cache directory path when the 8 text-model files exist, else by model id. Checked: a fresh home downloads exactly those 8 files (330 MB) in 6 s, then loads again with a dead proxy. A try-path-then-id fallback was tried first and rejected: a model load from a path with missing ONNX files hangs instead of throwing.
- [x] Reference check (worst cosine 0.999905 over 8 queries and 2 documents): write `/tmp/eg2-plan/scripts/ref-check.ts`. It imports `EmbeddingGemmaProvider` from the worktree source, embeds the `q_*` and `d_*` inputs from `/tmp/eg2-spike/results/corr-inputs.json` (strip the prefix the provider adds), and compares them to `/tmp/eg2-spike/results/vec-ref.json`. Expect cosine of 0.999 or better for every input.
- [x] Docker arm64 (native on this Mac). Every run resolves from the CLI bundle dir, like `cli.js`: (resolve 4.3.1, smoke 768 in about 1 s. Extra check: the image's own server with `--network none` and a read-only models mount indexed 2 files as `embeddinggemma:v2` and ranked the right one first, 0.705 vs 0.560. chonkie in the image resolves transformers 4.3.1, and the image holds one onnxruntime-node, 1.30.0.)
  - Build: `docker buildx build --platform linux/arm64 -t agent-fs:eg2-arm64 --load .`
  - Resolve: `docker run --rm --platform linux/arm64 --workdir /app/packages/cli/dist -e AGENT_FS_HOME=/data -v /tmp/eg2-plan/tjs-cache:/data/models agent-fs:eg2-arm64 bun -e 'const t=await import("@huggingface/transformers"); console.log(t.env.version)'` prints `4.3.1`.
  - Embed: write `/tmp/eg2-plan/scripts/eg2-smoke.ts`. It loads the model with the provider's calls and `cache_dir: "/data/models"`, embeds one query, and prints the vector length.
  - Run: `docker run --rm --platform linux/arm64 --workdir /app/packages/cli/dist -e AGENT_FS_HOME=/data -v /tmp/eg2-plan/tjs-cache:/data/models -v /tmp/eg2-plan/scripts/eg2-smoke.ts:/app/packages/cli/dist/eg2-smoke.ts:ro agent-fs:eg2-arm64 bun eg2-smoke.ts` prints `768`.
- [x] Docker amd64 (QEMU): (build OK, resolve 4.3.1, smoke 768 in 5 s wall) build with `--platform linux/amd64 -t agent-fs:eg2-amd64` and run the same two commands with `--platform linux/amd64`. If inference under emulation fails or takes over 5 minutes, record that and rely on the Phase 3 swarm deploy for amd64.
- [x] Global CLI install on Linux, in a `linux/arm64` container with only bun: (result: not supported, as the spike predicted. Before and after `bun add -g @huggingface/transformers@4.3.1`, `config validate` prints the guard reason "chonkie loads @huggingface/transformers 3.8.1, and two ONNX runtimes cannot run in one Linux process. Use the Docker image". The daemon logs one "Embedding warmup failed. Migration skipped" line and changes nothing. The same check on macOS with an isolated `BUN_INSTALL` passes: `missing (found 3.8.1)` first, "loads locally" after, and `vec-search` finds the file.)
  - Pack the CLI: `bun run build && (cd packages/cli && bun pm pack --destination /tmp/eg2-plan/pack)`.
  - Start the container: `docker run --rm -it --platform linux/arm64 -e BUN_INSTALL=/tmp/bun-global -e AGENT_FS_HOME=/data -v /tmp/eg2-plan/pack:/pkg:ro -v /tmp/eg2-plan/tjs-cache:/data/models oven/bun:1.4.1 bash`.
  - Inside: `bun add -g /pkg/<tarball>`, then `EMBEDDING_PROVIDER=local EMBEDDING_MODEL=embeddinggemma-2 agent-fs config validate`. Expect `missing (found 3.8.1)`.
  - Inside: `bun add -g @huggingface/transformers@4.3.1`. Start a daemon with the same env, write a markdown file, and confirm that `vec-search` finds it. Model load and chunking then run in one process.
  - Record the result in DEPLOYMENT.md: Linux global installs are supported or not.
- [x] Record the image size before and after: `docker image ls agent-fs:eg2-arm64` versus an image built from `origin/main`. (arm64: 977 MB on `origin/main` 0.17.0, 1073 MB with this phase, +96 MB. The plan's "about 300 MB less" assumed 3.8.1 stays plus 4.3.1. In fact one ORT 1.30 replaces one ORT 1.21 and is bigger.)
- [x] Delete the local test images after the checks: `docker image rm agent-fs:eg2-arm64 agent-fs:eg2-amd64`.
- [x] After the PR merges: `/health` on prod returns `0.17.1`, and the GHCR workflow pushed `ghcr.io/desplega-ai/agent-fs:0.17.1` for both platforms (`gh run list --workflow docker-publish.yml --limit 1`). (Shipped as 0.17.2, #101, `92b5071`. `/health` 0.17.2, machine started with 1/1 checks, GHCR 0.17.2 has amd64 and arm64, npm 0.17.2, no embedding migration in the prod log.)

#### Manual Verification:
- [ ] Taras reviews the DEPLOYMENT.md section for RAM and download guidance.

**Implementation Note**: After this phase, pause for manual confirmation. Then commit `[phase 2] EmbeddingGemma 2 local text model`, run `bun install --frozen-lockfile` and `bun run scripts/sync-versions.ts --check`, run `./scripts/release.sh 0.17.1`, and open the PR.

---

## Phase 3: Run EmbeddingGemma 2 on my swarm and measure it

### Overview

Deliverable: the swarm runs agent-fs 0.17.1 with `EMBEDDING_MODEL=embeddinggemma-2`. A "Swarm measurements" table in this plan's Appendix records RSS, query latency and re-embed duration for nomic (before) and EmbeddingGemma 2 (after). This is the "EmbeddingGemma in my swarm" milestone. No code changes.

### Changes Required:

#### 1. Baseline (read-only, no approval needed)
Use the `my-swarm` skill for conventions and for the swarm agent-fs API key.
- `ssh swarm-taras 'free -m; docker stats --no-stream --format "{{.Name}} {{.MemUsage}} {{.CPUPerc}}"'`
- Pick 10 queries that match known swarm files. Time each one: `time AGENT_FS_API_URL=https://fs.taras.cc AGENT_FS_API_KEY=<swarm key> agent-fs vec-search "<query>"`. Record the median.
- Record `meta.embedding_format` and the indexed-file count with a read-only `bun:sqlite` query inside the container, as in the planning check.

#### 2. Backup and deploy (ask Taras before each step)
- Ask Taras with one `AskUserQuestion` that lists: the volume backup, the `.env` change, and the deploy. Say that `fs-ui` also moves to the new `AGENT_FS_VERSION`.
- Backup. It stops agent-fs, archives the volume without `models`, and starts agent-fs again:
  `ssh swarm-taras 'df -h / && cd /opt/my-swarm && docker compose stop agent-fs && mkdir -p /root/backups && docker run --rm -v my-swarm_agent_fs_data:/data:ro -v /root/backups:/b busybox tar czf /b/agent-fs-data-$(date +%F).tgz --exclude ./models -C /data . ; docker compose start agent-fs'`
- `.env` in `~/Documents/my-swarm`: set `AGENT_FS_VERSION=0.17.1` and add `AGENT_FS_EMBEDDING_MODEL=embeddinggemma-2`. Leave `AGENT_FS_EMBEDDING_PROVIDER` unset (compose default `local`).
  - Edit `.env` with `sed -i ''` (BSD sed on macOS). Never print `.env`.
  - Mirror the change in `.env.example`, with no secret values.
- Pre-deploy checks in `~/Documents/my-swarm`:
  - `bash -n scripts/*.sh` and `docker compose config -q`.
  - Compare the live pool (`scripts/api.sh GET /api/runtime-pools`) with `grep '^POOL_' .env`. `deploy.sh` runs `bootstrap.sh`, so the two must match.
- Deploy: `(cd ~/Documents/my-swarm && scripts/deploy.sh swarm-taras)`. The script runs `ssh root@<arg>`.

#### 3. Measure (read-only)
- Model download and load time, right after the deploy (no `--since`): `ssh swarm-taras 'cd /opt/my-swarm && docker compose logs -t agent-fs' | grep -E "Resolving local embedding model|Model ready|embedding migration"`
- Re-embed duration: from container start to the `embedding migration done:` line.
- RSS: `docker stats --no-stream` during the re-embed and 10 minutes after it ends.
- Query latency: the same 10 queries as the baseline. Record the median, and the first query after boot separately.
- Write the results into the Appendix table.

#### 4. Rollback (only if Taras asks)
- (a) Model: set `AGENT_FS_EMBEDDING_MODEL=` (empty) in the swarm `.env` and redeploy. The format changes back to `local:v3`, and nomic re-embeds the files.
- (b) Version: set `AGENT_FS_VERSION=0.16.7` and redeploy.
  - Rule: first switch the model back to nomic on the CURRENT version, and let the re-embed finish. Then downgrade.
  - Reason: code before 0.17.3 cannot delete image chunks.
- (c) Data: restore the backup.
  - `ssh swarm-taras 'cd /opt/my-swarm && docker compose stop agent-fs && docker run --rm -v my-swarm_agent_fs_data:/data -v /root/backups:/b busybox tar xzf /b/agent-fs-data-<date>.tgz -C /data && docker compose up -d agent-fs'`
- Note: during a deploy, `up -d --wait api` can block for up to about 5 min (30 retries x 10 s) on a first-boot model download.

### Success Criteria:

#### Automated Verification:
- [ ] The container runs 0.17.1: `ssh swarm-taras 'docker ps --format "{{.Names}} {{.Image}} {{.Status}}"' | grep agent-fs`
- [ ] The container sees the model: `ssh swarm-taras 'docker exec my-swarm-agent-fs-1 printenv EMBEDDING_MODEL'` prints `embeddinggemma-2` (check the real container name with `docker ps`)
- [ ] The format switched and no files stay pending: `ssh swarm-taras "docker exec my-swarm-agent-fs-1 bun -e 'const {Database}=require(\"bun:sqlite\");const d=new Database(\"/data/agent-fs.db\",{readonly:true});console.log(d.query(\"SELECT value FROM meta WHERE key=?\").get(\"embedding_format\"), d.query(\"SELECT count(*) AS n FROM files WHERE embedding_status=? AND is_deleted=0\").get(\"pending\"))'"`. The output contains `embeddinggemma:v2` and `n: 0`. A read-only open of the WAL DB works as root in the container.
- [ ] The re-embed finished: `ssh swarm-taras 'cd /opt/my-swarm && docker compose logs -t agent-fs' | grep "embedding migration done"` prints a line.
- [ ] Index invariants hold: `ssh swarm-taras 'docker exec -i -w /app/packages/cli/dist my-swarm-agent-fs-1 bun run -' < /tmp/eg2-plan/scripts/index-invariants.js` prints only zeros.

#### Automated QA:
- [ ] Run the 10 queries against `https://fs.taras.cc`. Each returns its expected file in the top 5.
- [ ] The Appendix "Swarm measurements" table is filled for both models.

#### Manual Verification:
- [ ] Taras approved the backup, the `.env` change and the deploy before they ran.
- [ ] Taras checks that the swarm API and lead stay healthy during the re-embed (no OOM, normal task latency).

**Implementation Note**: This is the end of the first implementation session. Pause for manual confirmation. No commit in the agent-fs repo, except the measurement table in this plan (commit it on the Phase 4 branch).

---

## Phase 4: PDF text indexing for every provider

### Overview

Deliverable: PDFs are searchable by their text with every provider. Text chunks of a PDF carry a page number in `content_chunks.page`, and `search` and `vec-search` results expose it as `page`. Existing PDFs are indexed once at boot. Release 0.17.2.

### Changes Required:

#### 1. Dependency
**Files**: `packages/core/package.json`, `packages/cli/package.json`, `bun.lock`
**Changes**: Add `"unpdf": "1.9.0"` (exact, 2.1 MB, no dependencies) to core and cli dependencies. Add `--external unpdf` to `build:npm`. Its `@napi-rs/canvas` peer is optional and not needed for text.

#### 2. PDF text extraction
**File**: `packages/core/src/search/pdf.ts` (new)
**Changes**:
- `extractPdfText(bytes: Uint8Array): Promise<{ text: string; pageStarts: number[] }>`.
- unpdf detaches the input buffer. Open the document with `getDocumentProxy(bytes.slice(), { isEvalSupported: false })`, never with the caller's buffer. Call `pdf.destroy()` in `finally`.
- Do not block the event loop. For each page, call `pdf.getPage(n)` and `getTextContent()`, then `await Bun.sleep(0)` before the next page.
- Stop once the text length reaches `MAX_EMBED_CHARS`. The rest is not indexed, and the file still ends `indexed`.
- Join pages with `"\n\n"`. `pageStarts[i]` is the char offset where page `i + 1` starts.
- Whitespace-only text counts as `""`. An image-only PDF returns `text: ""`. That is not an error.
- Catch every pdf.js error (encrypted, truncated, malformed). Log one line and return `{ text: "", pageStarts: [] }`.
- A `write`, `cp`, `revert`, `mv` or `reindex` never fails because of extraction.

#### 3. One extraction entry point
**File**: `packages/core/src/ops/mime.ts`
**Changes**:
- Add `extractIndexableText(bytes, mime): Promise<{ text: string; pageStarts?: number[] } | null>`. Text MIME types use `decodeIndexableText` (`mime.ts:104-118`). `application/pdf` uses `extractPdfText`. Everything else returns `null`.
- `cat.ts:21` and `share.ts:417` keep calling `decodeIndexableText`. They need text for display, not PDF extraction.

#### 4. Callers
**Files**: `packages/core/src/ops/search-index.ts`, `ops/write.ts`, `ops/cp.ts`, `ops/revert.ts`, `ops/reindex.ts`, `ops/mv.ts`, `search/embedding-migration.ts`, `search/pipeline.ts`
**Changes**:
- Replace `decodeIndexableText` with `extractIndexableText` in `indexBytesForSearch`, `reindex`, the `mv` text check and `runPendingEmbeddings` (`embedding-migration.ts:102-196`).
- `indexBytesForSearch` becomes `async`. `write`, `cp` and `revert` await it.
- Thread `pageStarts` through `indexTextForSearch` and `scheduleEmbedding` into `indexFileEmbeddings`.
- `runPendingEmbeddings` also refreshes FTS (`indexFile`), for PDFs only. Existing PDFs have no FTS row yet.
  - The refresh runs inside the `indexFileEmbeddings` transaction, after `isCurrent()`. Pass a flag or the text.
  - An old version then never overwrites a newer FTS row.

#### 5. Page column, page mapping and empty chunk lists
**Files**: `packages/core/src/db/raw.ts`, `db/schema.ts`, `db/migrate.ts`, `search/pipeline.ts`
**Changes**:
- Add `page INTEGER` (nullable) to `content_chunks`: one idempotent `ALTER TABLE ADD COLUMN` step in `runMigrations`, plus the `CREATE TABLE` SQL and the Drizzle mirror.
- In `indexFileEmbeddings`, set each chunk's `page` to `1 + (the last index i with pageStarts[i] <= charOffset)`. Without `pageStarts`, `page` is `NULL`.
- In `indexFileEmbeddings`, if `chunks.length === 0`, skip the provider call. Delete the file's text chunks, set `embedding_status='indexed'`, and return `true`.

#### 6. Boot backfill for existing PDFs
**File**: `packages/core/src/search/embedding-migration.ts`
**Changes**:
- In `prepareEmbeddingMigration`, also run `UPDATE files SET embedding_status='pending' WHERE embedding_status IS NULL AND is_deleted=0 AND content_type='application/pdf'`.
- After processing, a PDF always ends `indexed` (zero chunks for an image-only PDF) or `failed`. It never returns to `NULL`, so the query runs once per PDF.

#### 7. Results
**Files**: `packages/core/src/search/vector-candidates.ts`, `ops/search.ts`, `ops/vec-search.ts`
**Changes**:
- Select `page` with the best chunk and add `page?: number` to `SearchResultItem` and the vec-search item. FTS-only hits have no page.
- Touch points (Phase 5 carries `kind` along the same path):
  - `VectorCandidate` (`vector-candidates.ts:13-19`) and the `addDistinctFiles` select (`:148-155`)
  - `RankedItem` (`search.ts:115-120`) and the `vectorSearch` map (`search.ts:131-138`)
  - the RRF `merged` map value (`search.ts:52-55`) and the final map (`search.ts:97-103`)
  - `vec-search.ts`
- Rule for the FTS override at `search.ts:81-84`: `page` always comes from the best vector unit. A text unit takes the FTS snippet when FTS also hit, as today. `page` then names the best semantic match.

#### 8. Tests and fixtures
**Files**: `packages/core/src/search/__tests__/fixtures/text.pdf` (new), `image-only.pdf` (new), `encrypted.pdf` (new), `truncated.pdf` (new), `packages/core/src/search/__tests__/pdf.test.ts` (new), `packages/core/src/ops/__tests__/search-regressions.test.ts`, `scripts/e2e.ts`
**Changes**:
- Fixtures under 50 KB each. Make them on this Mac in `/tmp/eg2-plan/fixtures/`. Phase 5 tests and the Manual E2E use these exact phrases.
  - `text.pdf`: page 1 contains "quarterly aurora invoice", page 2 contains "basalt lighthouse maintenance log". Put a form feed between the two pages in `in.txt`. Then run `cupsfilter -m application/pdf in.txt > text.pdf` (it writes to stdout).
  - `image-only.pdf`: render a PNG with `@napi-rs/canvas` that shows the words "SOLAR KITE" in large letters. Convert it with `sips -s format pdf`, so the PDF has no text layer. The repo adds `@napi-rs/canvas` only in Phase 5, so install it in `/tmp/eg2-plan/fixtures/` for this step.
  - `truncated.pdf`: the first half of `text.pdf`: `head -c $(( $(wc -c < text.pdf) / 2 )) text.pdf > truncated.pdf`.
  - `encrypted.pdf`: `qpdf --encrypt u o 256 -- text.pdf encrypted.pdf` if `qpdf` is present. Otherwise skip this fixture and note it in the PR.
- Unit tests:
  - Extraction returns both phrases and the right `pageStarts`.
  - The image-only PDF returns `""`.
  - `encrypted.pdf` and `truncated.pdf` return `{ text: "", pageStarts: [] }`, and a `write` of each succeeds.
  - A chunk on page 2 gets `page = 2`.
  - An empty chunk list skips the provider: with a provider that throws on an empty batch, the file still ends `indexed`.
  - The backfill marks a `NULL` PDF pending once.
- E2E (credential-free): write `text.pdf` with the CLI, then assert that `fts` and `search` find it by "basalt lighthouse maintenance log".

#### 9. Docs and skill
**Files**: `DEPLOYMENT.md`, `skills/agent-fs/SKILL.md`
**Changes**:
- DEPLOYMENT.md "Upgrading to 0.17.2": existing PDFs are indexed once at boot, paced. With OpenAI or Gemini this sends PDF text to the provider. Without a provider, run `agent-fs reindex` per drive for FTS.
- Skill: PDFs are searchable, and results carry `page` for PDF hits.

### Success Criteria:

#### Automated Verification:
- [x] Lockfile frozen and versions in sync before release: `bun install --frozen-lockfile && bun run scripts/sync-versions.ts --check`
- [x] Typecheck passes: `bun run typecheck`
- [x] Unit tests pass: `bun run test`
- [x] Build passes: `bun run build`
- [x] E2E local mode passes, including the new PDF test: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only` (187/187)
- [ ] Full E2E passes: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"` (208/209. Only the pre-existing `share-create` failure.)
- [x] E2E with the real model passes: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only --local-model embeddinggemma-2 --models-dir /tmp/eg2-plan/tjs-cache` (188/188)
- [x] Versions in sync after release: `bun run scripts/sync-versions.ts --check` (0.17.3)

#### Automated QA:
- [x] Migration check, with a provider (the backfill runs only when a provider exists): (2026-10-17: a home made by 0.17.2 held text.pdf with status NULL. The new daemon backfilled it to `indexed`, and `fts`, `search` and `vec-search` found it.)
  - Copy a DB made by 0.17.1 that holds a PDF with `embedding_status` `NULL` into `/tmp/eg2-plan/p4-home`. Symlink `/tmp/eg2-plan/p4-home/models` to `/tmp/eg2-plan/tjs-cache`.
  - Boot the new daemon on it with `EMBEDDING_PROVIDER=local EMBEDDING_MODEL=embeddinggemma-2`.
  - Confirm the PDF becomes `indexed` and `fts` finds its text.
- [x] Index invariants hold on the migrated home: `cd /Users/taras/worktrees/agent-fs/2026-10-16-embeddinggemma/packages/core && DB=/tmp/eg2-plan/p4-home/agent-fs.db bun run - < /tmp/eg2-plan/scripts/index-invariants.js` prints only zeros. (all 0)
- [x] Event loop stays free on a large PDF: (1000 pages, 1.5 MB: no `event-loop was blocked` line, max lag 48 ms, extraction 1.5 s, capped at 2,000,000 chars after 699 pages.)
  - Generate a 1000-page PDF with a script into `/tmp/eg2-plan/fixtures/big.pdf`.
  - Write it to a daemon in a `--cpus=1` linux container, or locally.
  - The event-loop watchdog (`server/src/index.ts:123-134`) logs no `event-loop was blocked` line (it logs only lags over 5 s).
- [x] Docker arm64 smoke: build the image and run `extractPdfText` on `text.pdf` inside it (inline `bun -e`, `--workdir /app`). (fallback: the image ships only `cli.js`, so its server ran with `--network none`, and `fts` found both page phrases.)
- [x] After merge: prod `/health` returns `0.17.2`. `fly logs --no-tail` returns only a short buffer, so watch `fly logs -a agent-fs-taras` live during the deploy. Expect `embedding migration done` with no failures from the PDF backfill. (Shipped as 0.17.3, #102, `e946c73`. Live log: `embedding migration done: 87 embedded, 0 failed, 0 skipped, 0 superseded` about 1.5 min after boot, no PDF extraction errors, no event-loop blocks. `/health` 0.17.3, GHCR amd64 and arm64, npm 0.17.3.)

#### Manual Verification:
- [ ] Taras confirms that a known prod PDF appears in `agent-fs search` with a page number.

**Implementation Note**: After this phase, pause for manual confirmation. Then commit `[phase 4] PDF text indexing`, run `bun install --frozen-lockfile` and `bun run scripts/sync-versions.ts --check`, run `./scripts/release.sh 0.17.2`, and open the PR.

---

## Phase 5: Image and PDF-page embedding

### Overview

Deliverable: with EmbeddingGemma 2, a paced background job embeds image files (`png`, `jpeg`, `webp`, `gif`). It also embeds the first 3 pages of each PDF, rendered as images. They become `kind = 'image'` chunks with an optional `page`. `search` and `vec-search` return them with `kind: "image"` and a marker snippet. Text-only providers skip all of it. Release 0.17.3.

### Changes Required:

#### 1. Image token budget (measure first, before code)
**Files**: scratch only, under `/tmp/eg2-spike/scripts/` and `/tmp/eg2-plan/`
**Changes**:
- Add a budget argument to the `tjs` mode of `/tmp/eg2-spike/scripts/embed-corpus.ts` (set `processor.image_processor.max_soft_tokens`). Run it at 140 and 70 with `env.cacheDir = /tmp/eg2-plan/tjs-cache`, then `bun eval.ts` for config E3t.
- Rule: pick the lowest budget that keeps I R@5 = 1.00 and P R@5 = 1.00, and R@1 within 0.03 of the 280 run. Otherwise keep 280.
- Record the table (R@1, R@5, MRR, ms per image) in the Appendix.
- Ask Taras before deleting `/tmp/eg2-spike/data` and `results/units.json`. They hold copies of prod file content.

#### 2. Interface
**File**: `packages/core/src/search/embeddings/provider.ts`
**Changes**:
- `export interface EmbeddingPart { mime: string; data: Uint8Array }`
- `supportsMime(mime: string): boolean`
- `embedParts(parts: EmbeddingPart[]): Promise<number[][]>`, one vector per part.
- nomic, OpenAI and Gemini: `supportsMime` returns `false`, and `embedParts` throws.

#### 3. EmbeddingGemma 2 images
**File**: `packages/core/src/search/embeddings/embeddinggemma.ts`
**Changes**:
- `supportsMime`: `image/png`, `image/jpeg`, `image/webp`, `image/gif`. Not SVG (it stays a text file).
- `embedParts`: on first call, create a second instance. It loads its own `AutoConfig` (with the vision config), and uses `dtype: { model: "q8", vision_encoder: "q8" }` and the same `cache_dir`. Set `max_soft_tokens` to the budget from step 1 (one constant).
- Decode each part with `RawImage.fromBlob(new Blob([data]))`, run `processor(null, image)`, read `sentence_embedding`. No prefix.
- Dispose the vision instance after 60 s without calls (an `unref`'d timer). The text instance stays.
- Also dispose and recreate the vision instance after 50 images. Never dispose it while a call is in flight.

#### 4. Schema
**Files**: `packages/core/src/db/raw.ts`, `db/schema.ts`, `db/migrate.ts`
**Changes**:
- `content_chunks.kind TEXT NOT NULL DEFAULT 'text'` (`'text' | 'image'`).
- `files.image_embedding_status TEXT` (`pending | indexed | failed | NULL`).
- Both through idempotent `ALTER TABLE ADD COLUMN` steps, plus the `CREATE TABLE` SQL and the Drizzle mirror.

#### 5. Page rendering
**Files**: `packages/core/src/search/pdf.ts`, `package.json` (root), `packages/cli/package.json`
**Changes**:
- A constant `PDF_PAGE_IMAGES = 3` (validated by the spike). No env var.
- `renderPdfPages(bytes, n): Promise<Uint8Array[]>`:
  - Open the document once with `getDocumentProxy(bytes.slice())`.
  - For pages 1 to `min(n, pdf.numPages)`, sequentially: `renderPageAsImage(pdf, page, { canvasImport: () => import("@napi-rs/canvas"), width: 1024 })`.
  - Wrap each returned `ArrayBuffer` with `new Uint8Array(...)`.
  - On a render error, log it and skip that page.
  - Call `pdf.destroy()` in `finally`.
  - Callers pass `PDF_PAGE_IMAGES`.
- Add `"@napi-rs/canvas": "1.0.11"` (exact) to the root `package.json` `dependencies` (not core, not cli), and `--external @napi-rs/canvas` to `build:npm`.
- At boot, resolve `pdfPageImages = provider.supportsMime("image/png") && canvas loads` once. The write branch (§7) and the boot query (§8) use it.
- Without `pdfPageImages`, PDFs get no page images and keep `image_embedding_status` `NULL`. The boot query then excludes PDFs, so nothing loops. If the canvas import fails, log the install command once.

#### 6. Image job
**File**: `packages/core/src/search/image-embedding.ts` (new)
**Changes**:
- `runPendingImageEmbeddings(db, s3, provider, { cpuShare, log })`: keyset scan over `files` with `image_embedding_status='pending' AND is_deleted=0`. For each file:
  - Before the file, write `meta.image_job_current = <file id>`. Clear it after the file.
  - Read the version with `readCurrentVersion`, then the bytes with `s3.getObject`.
  - An image gives one part with `page = NULL`. A PDF gives one part per rendered page with `page = n`.
  - Pace per part: acquire `withEmbeddingSlot`, call `embedParts` for that part, release the slot, then `pauseForCpuShare`. Apply `toUnitVector` to each vector.
  - Commit once per file. Collect the vectors, then run one transaction with the version guard. The transaction:
    - deletes the file's `kind='image'` chunks and their `chunk_vectors` rows
    - inserts the new chunks (`content = ''`, `kind = 'image'`), their vectors and int8 rows
    - sets `image_embedding_status='indexed'`.
  - On a file error, set `failed` unless a newer write owns the file.
  - A provider init error (for example a failed 195 MB vision download) stops the loop. The files stay `pending`, with no mass `failed`.
- At boot, if `meta.image_job_current` is set, mark that file `image_embedding_status='failed'` and clear the key. A crash or OOM on one file then cannot loop.
- `scheduleImageEmbeddings(...)`: single-flight. If a run is active, set a rerun flag, and the loop scans again when it ends. The single-flight flag resets in `finally`.
- Pacing uses `AGENT_FS_EMBEDDING_MIGRATION_CPU_SHARE`.

#### 7. Write path and lifecycle
**Files**: `packages/core/src/ops/search-index.ts`, `ops/mv.ts`, `ops/reindex.ts`, `ops/rm.ts`, `search/pipeline.ts`
**Changes**:
- Kind-scoped deletes: `clearSearchData`, `clearEmbeddings` and `deleteChunks` take `kind: "text" | "image" | "all"`.
  - Default callers pass `"text"`. The text job deletes only `kind='text'`.
  - Only `rm` passes `"all"`.
  - `"image"`: the image job, the image write branch, the format change, and the two resets below (`indexTextForSearch`, the `mv` target).
- In `indexBytesForSearch`, for a file whose MIME is an image the provider supports, or a PDF while `pdfPageImages` is true:
  - delete its `kind='image'` chunks
  - set `image_embedding_status='pending'`
  - call `scheduleImageEmbeddings`.
  - Otherwise set `image_embedding_status` to `NULL`.
- `indexTextForSearch` (reached from the `write.ts:125-126` text path, `edit.ts:94` and `append.ts:64`) resets the path's image chunks and sets `image_embedding_status` to `NULL`. It leaves the image side alone when the file's MIME is a supported image or a PDF.
- `reindex` never deletes image chunks. It resets `failed` image rows to `pending`.
- `mv` never deletes the image chunks of a supported image. It:
  - deletes the target's image chunks first, then re-paths
  - carries `image_embedding_status` with an explicit `files` UPDATE for `to`
  - decides by MIME type (no PDF re-parse)
  - kicks the job if the carried status is `pending`.

#### 8. Migration and boot
**Files**: `packages/core/src/search/embedding-migration.ts`, `packages/server/src/index.ts`
**Changes**:
- On a format change, in the same transaction: delete all `kind='image'` chunks and their vectors, and set every `image_embedding_status` to `NULL`. The boot query below re-queues the supported files. One model then embeds the full index.
- Every boot: `UPDATE files SET image_embedding_status='pending' WHERE image_embedding_status IS NULL AND is_deleted=0 AND content_type IN (<supported MIME types, plus application/pdf when pdfPageImages is true>)`. The job always ends in `indexed` or `failed`. This also queues the images of an index that EmbeddingGemma 2 built before 0.17.3 (the swarm after Phase 3).
- At boot, handle a stale `meta.image_job_current` (§6) before the job starts.
- In `server/src/index.ts`, start `runPendingImageEmbeddings` only when the provider supports `image/png`:
  - in the `.finally()` of the text migration run
  - or directly when no text run started.
  - Never run both jobs at once.

#### 9. Results and markers
**Files**: `packages/core/src/search/vector-candidates.ts`, `ops/search.ts`, `ops/vec-search.ts`
**Changes**:
- Carry `kind` with the best chunk, through the same touch points as `page` (Phase 4 §7). Add `kind?: "text" | "image"` to both result items.
- For `kind = 'image'`, the snippet is `[image]`, or `[PDF page N]` when `page` is set.
- Rule for the FTS override at `search.ts:81-84`: `kind` and `page` always come from the best vector unit.
  - An image unit keeps its marker snippet.
  - A text unit takes the FTS snippet when FTS also hit, as today.
  - `page` then names the best semantic match.

#### 10. Tests
**Files**: `packages/core/src/search/__tests__/image-embedding.test.ts` (new), `packages/core/src/ops/__tests__/search-regressions.test.ts`, `packages/core/src/__manual_tests__/embeddinggemma.test.ts`, `scripts/e2e.ts`
**Changes**:
- A fake provider with `supportsMime` true for PNG and deterministic `embedParts` covers:
  - write, job run, `indexed` status, chunk kind and page
  - an overwrite during the job (version guard)
  - `rm` and `mv`
  - format change clears image chunks
  - the text job leaves image chunks alone
  - `reindex` on an indexed image keeps its image chunks
  - a large PDF over `MAX_EMBED_CHARS` keeps its page images
  - a PDF with both text and image chunks survives a text re-embed and an image re-run, each on its own.
- A text-only fake provider leaves images untouched.
- Manual model test: an image generated at runtime with `@napi-rs/canvas` (for example a large red circle) ranks first for the query "a red circle" among two images.
- E2E `--local-model` mode: write a generated PNG and `image-only.pdf`. Poll `vec-search` until both appear (query "SOLAR KITE" for the PDF). Assert `kind: "image"` and `page: 1` for the PDF.

#### 11. Docs and skill
**Files**: `DEPLOYMENT.md`, `skills/agent-fs/SKILL.md`
**Changes**:
- DEPLOYMENT.md "Upgrading to 0.17.3":
  - Image and PDF-page embedding runs only with EmbeddingGemma 2.
  - It is a paced background job. Cost: about 4 to 12 s CPU per image on 2 vCPU at budget 280.
  - Each PDF gets page images for its first 3 pages (a code constant).
  - RSS: no fixed GB claim before a Linux measurement. Tell readers to measure on their host. This plan records the swarm measurement.
  - Env table: the CPU share note.
- Skill: image and PDF-page matches, `kind`, markers, and `agent-fs signed-url` to fetch the file.

### Success Criteria:

#### Automated Verification:
- [x] Lockfile frozen and versions in sync before release: `bun install --frozen-lockfile && bun run scripts/sync-versions.ts --check`
  - Result: lockfile clean, all targets at 0.17.3 before the release.
- [x] Typecheck passes: `bun run typecheck`
- [x] Unit tests pass (fake providers, no model): `bun run test`
  - Result: 1535 pass, 61 skip, 0 fail.
- [x] Build passes: `bun run build`
  - Result: `cli.js` about 460 KB. `@napi-rs/canvas`, `unpdf` and `@huggingface/transformers` stay external (dynamic imports only).
- [x] E2E local mode passes: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only`
  - Result: 187/187 passed, 20 skipped.
- [x] Full E2E passes: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"`
  - Result: 208/209 passed. The one failure is the known `share-create returns a public link on the API host`, which also fails on clean main.
- [x] Manual model test passes: `AGENT_FS_TEST_EMBEDDINGGEMMA_HOME=/tmp/eg2-plan/p2-home bun test packages/core/src/__manual_tests__/embeddinggemma.test.ts`
  - Result: 4 pass, 0 fail.
- [x] E2E with the real model passes, including images: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only --local-model embeddinggemma-2 --models-dir /tmp/eg2-plan/tjs-cache`
  - Result: 189/189 passed, 18 skipped, including "local model indexes image files and PDF page images".
- [ ] Versions in sync after release: `bun run scripts/sync-versions.ts --check`

#### Automated QA:
- [x] The budget table is in the Appendix, and the code constant matches its decision.
  - Result: `IMAGE_TOKEN_BUDGET = 140` in `embeddinggemma.ts`, as the Appendix decides.
- [x] RSS check on this Mac: run a daemon with EmbeddingGemma 2, write 20 images, then sample RSS with `ps -o rss= -p <pid>` during the job and 2 minutes after it ends. Expect RSS to drop after the vision instance is disposed. If it does not drop, record it and try `session_options: { enableCpuMemArena: false }`, then measure again.
  - Result: 931 MB with the text model loaded, peak 1915 MB, about 1130 MB during the job, 310-330 MB about 60 s after the last image (vision instance disposed). RSS drops, so `enableCpuMemArena` is not needed. About 26 s per image at the default CPU share 0.25 (20 images in 520 s).
- [x] Index invariants hold on the RSS-check daemon home after the job ends: `cd /Users/taras/worktrees/agent-fs/2026-10-16-embeddinggemma/packages/core && DB=<home>/agent-fs.db bun run - < /tmp/eg2-plan/scripts/index-invariants.js` prints only zeros.
  - Result: all zeros, all 20 files `indexed`.
- [x] Memory under load: in a `linux/arm64` container with `--memory=2g`, write 100 images and 10 PDFs while a text re-embed also runs. Expect no OOM (`docker inspect -f '{{.State.OOMKilled}}' <container>` prints `false`).
  - Result: 30 markdown files, 99 PNGs and 10 PDFs in a `--memory=2g --network none` arm64 container, text on-write embedding running alongside. Peak 1421 MiB, OOMKilled false, invariants all zeros. One write (`g24.png`) failed with stderr discarded. A rerun after the review fixes wrote 300 PNGs (sequential, during the job, and 4 parallel writers): all exited 0, peak 991 MiB, invariants all zeros. About 30 to 33 s per image in the container.
- [x] Docker arm64 smoke: render page 1 of `image-only.pdf` with `@napi-rs/canvas` inside the image (inline `bun -e`, `--workdir /app/packages/cli/dist`, so it resolves like `cli.js`). Expect a PNG of width 1024.
  - Result: page 1 of `image-only.pdf` rendered as a 1024x768 PNG (39,636 bytes).
- [ ] After merge: prod `/health` returns `0.17.3`. Watch `fly logs -a agent-fs-taras` live during the deploy. The log shows no image job start (OpenAI does not support images).

#### Manual Verification:
- [ ] Taras agrees with the chosen image token budget and the constant of 3 PDF page images.

**Implementation Note**: After this phase, pause for manual confirmation. Then commit `[phase 5] image and PDF-page embedding`, run `bun install --frozen-lockfile` and `bun run scripts/sync-versions.ts --check`, run `./scripts/release.sh 0.17.3`, and open the PR.

---

## Phase 6: Show image and page matches in the CLI, MCP and live

### Overview

Deliverable: the CLI prints markers and page numbers. MCP results carry `kind`, `page` and marker snippets (from Phase 5). The live search modal shows a kind chip, a thumbnail for image hits and a page chip. A click on a PDF hit opens the PDF at that page. Release 0.17.4.

### Changes Required:

#### 1. CLI
**File**: `packages/cli/src/formatters.ts:187-200`
**Changes**: `formatSearch` appends `[page N]` to the header line when `page` is set. Image hits print their marker snippet as today. Add a formatter test.

#### 2. Live types and helper
**Files**: `live/src/api/types.ts:210-232`, `live/src/lib/search-hit.ts` (new), `live/src/lib/__tests__/search-hit.test.ts` (new)
**Changes**:
- Add `kind?` and `page?` to `SearchResultItem`. `live/src/api/types.ts` has one `SearchResultItem`, and both hooks use it.
- A pure helper returns the chip label (`Image`, `PDF p.3`, or none) and whether the hit gets a thumbnail. Test it with `bun test`.

#### 3. Search modal
**File**: `live/src/components/search/SearchModal.tsx`
**Changes**:
- The modal maps results into a local `ResultItem` (`:21`, mappers at `:76`, `:90`, `:105`). Add `kind` and `page` to `ResultItem` and to both vector-result mappers (hybrid and semantic).
- `ResultRow` shows the chip.
- For `kind = 'image'` on an image file, it shows a 40 px thumbnail from `useSignedUrl(path, "inline")` with `loading="lazy"`. A PDF page hit shows the chip only.
- Keep the marker snippet hidden in the UI, since the chip carries it.

#### 4. Page deep link
**Files**: `live/src/contexts/browser.tsx:64-71`, `live/src/components/viewers/FileViewer.tsx`, `live/src/components/viewers/PdfViewer.tsx`
**Changes**:
- `selectFile(path, { page })` adds `?page=N` to the file route.
- `FileViewer` reads it and passes `page` to `PdfViewer`.
- `PdfViewer` appends `#page=N` to the iframe URL.

#### 5. Skill
**File**: `skills/agent-fs/SKILL.md`
**Changes**: Show a sample CLI output with an image hit and a PDF page hit.

### Success Criteria:

#### Automated Verification:
- [x] Typecheck passes: `bun run typecheck`
- [x] Unit tests pass, including the live helper: `bun run test`
  - Result: 1540 pass, 61 skip, 0 fail. The live helper has 4 tests, the CLI formatter test covers `search` and `vec-search`.
- [x] Live build passes: `cd live && pnpm build`
- [x] Build passes: `bun run build`
- [x] E2E local mode passes: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only`
  - Result: 187/187 passed, 20 skipped.
- [x] Lockfile and versions are clean before release: `bun install --frozen-lockfile && bun run scripts/sync-versions.ts --check`
- [ ] Versions in sync after release: `bun run scripts/sync-versions.ts --check`

#### Automated QA:
- [x] Browser check with `agent-browser` (load `agent-browser skills get core` first). Follow the MinIO recipe in the memory note `live-ui-browser-e2e-needs-minio`, with `AGENT_FS_HOME=/tmp/eg2-plan/p6-home`, `models` symlinked to `/tmp/eg2-plan/tjs-cache`, and `EMBEDDING_PROVIDER=local EMBEDDING_MODEL=embeddinggemma-2`.
  - Result: MinIO daemon with EmbeddingGemma 2. The PNG hit shows a 40 px lazy thumbnail and an "Image" chip. PDF hits show "PDF p.N" chips and no thumbnail. Marker snippets are hidden. A click on the `image-only.pdf` p.1 hit gives `?page=1` and an iframe src ending in `#page=1`. A text.pdf p.2 hit opens page 2. A hit on the PDF that is already open moves it to the new page. Enter works too. Chips fit at 390x844. Screenshots: `/tmp/eg2-plan/p6-*.png`.
  - Write a PNG, `text.pdf` and `image-only.pdf`.
  - Search for each one. Screenshot the modal to `/tmp/eg2-plan/p6-search.png`.
  - Confirm the thumbnail and the chips.
  - Click the PDF page hit and confirm that the iframe URL ends with `#page=1`.
- [x] Upload the screenshots with `agent-fs write qa/agent-fs/2026-10-XX-eg2-display/<name>.png --file <png>` and add signed URLs to the PR body. If agent-fs is not configured, list the local paths in the PR instead.
  - Result: uploaded to `qa/agent-fs/2026-10-17-eg2-display/`. Signed URLs (7 days) are in the PR body.

#### Manual Verification:
- [ ] Taras judges the chip and thumbnail look in the live modal.

**Implementation choices (2026-10-17)**: `[page N]` goes after the score and before `by <author>`, so the author stays last. A PDF text hit also gets the `PDF p.N` chip and the deep link, because the helper keys on `page`. The thumbnail takes the place of the file icon. The chip reuses the score chip classes. Both review axes accepted these.

**Implementation Note**: After this phase, pause for manual confirmation. Then commit `[phase 6] show image and page matches`, run `bun install --frozen-lockfile` and `bun run scripts/sync-versions.ts --check`, run `./scripts/release.sh 0.17.4`, and open the PR. After the release, run Manual E2E §3 with 0.17.4 on the swarm.

---

## Phase 7: EmbeddingGemma 2 as the default for fresh indexes

### Overview

Deliverable: with `EMBEDDING_PROVIDER=local` (or unset) and an empty `EMBEDDING_MODEL`, a fresh index uses EmbeddingGemma 2 when `@huggingface/transformers` is installed. An index that nomic built stays on nomic. The daemon boot log says which model it picked and why. The doctor (`agent-fs config validate`) prints the configured model and whether transformers 4.3.1 loads locally. Release 0.18.0.

### Changes Required:

#### 1. Resolver
**File**: `packages/core/src/search/embeddings/index.ts`
**Changes**: A pure function `resolveLocalModel({ configured, storedFormat, hasChunks, transformersAvailable })`:
- A non-empty `configured` value wins.
- `hasChunks && (storedFormat == null || storedFormat.startsWith("local:"))`: `nomic-embed-text-v1.5`. Indexes from 0.16.4 and older have chunks but no stored format.
- `storedFormat` starting with `embeddinggemma:`: `embeddinggemma-2`.
- Otherwise: `embeddinggemma-2` if `transformersAvailable`, else `nomic-embed-text-v1.5`.
- It returns the model and a one-line reason.

#### 2. Boot wiring
**Files**: `packages/server/src/index.ts:59-65`, `packages/core/src/search/embeddings/index.ts`
**Changes**:
- Before it creates the provider, the server reads `meta.embedding_format` and `EXISTS(SELECT 1 FROM content_chunks)`.
- `transformersAvailable` comes from `loadTransformers()` in `embeddinggemma.ts` (the import plus the 4.3.1 version check). `Bun.resolveSync` is not enough.
- It passes these to `createEmbeddingProviderFromEnv` and logs the model and the reason.

#### 3. Doctor
**File**: `packages/cli/src/commands/config-cmd.ts` (`config validate` at `:58`, embeddings block `:141-170`, local branch `:164-169`)
**Changes**:
- `agent-fs config validate` runs on the client and may point at a remote daemon.
- So it prints only the configured model and whether transformers 4.3.1 loads locally (`loadTransformers()`).
- The resolved model and the reason come from the daemon boot log, not from the doctor.

#### 4. Tests
**File**: `packages/core/src/search/__tests__/embedding-factory.test.ts`
**Changes**:
- A table test for every resolver branch. It includes chunks with no stored format (an index from 0.16.4 or older), which gives nomic.
- A test that an explicit `EMBEDDING_MODEL=nomic-embed-text-v1.5` on a fresh index gives nomic.

#### 5. Docs
**Files**: `DEPLOYMENT.md`, `skills/agent-fs/SKILL.md`, `README.md` (only if it names the default model)
**Changes**:
- DEPLOYMENT.md "Upgrading to 0.18.0":
  - New default for fresh indexes. Existing nomic indexes do not change.
  - Fresh Docker volumes download 339 MB plus 195 MB on first use.
  - Plan for 2 GB RAM, or set `EMBEDDING_MODEL=nomic-embed-text-v1.5`.

### Success Criteria:

#### Automated Verification:
- [x] Typecheck passes: `bun run typecheck`
- [x] Unit tests pass: `bun run test`
  - Result: 1570 pass, 61 skip, 0 fail.
- [x] Build passes: `bun run build`
- [x] E2E local mode passes (E2E still forces `openai` with empty keys, so no download): `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only`
  - Result: 187/187 passed, 20 skipped.
- [x] Full E2E passes: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"`
  - Result: 208/209 passed. The one failure is the known `share-create returns a public link on the API host`.
- [x] Lockfile and versions are clean before release: `bun install --frozen-lockfile && bun run scripts/sync-versions.ts --check`
  - Result: lockfile clean, all targets at 0.17.5 before the release.
- [ ] Versions in sync after release: `bun run scripts/sync-versions.ts --check`

#### Automated QA:
- [x] Fresh index: start a daemon with `AGENT_FS_HOME=/tmp/eg2-plan/p7-fresh`, `models` symlinked to `/tmp/eg2-plan/tjs-cache`, and `EMBEDDING_PROVIDER=local`. The boot log names `embeddinggemma-2` with reason "fresh index".
  - Result: `[agent-fs] local embedding model: embeddinggemma-2 (fresh index)`. One file `indexed`, format `embeddinggemma:v2`.
- [x] Sticky index: copy a nomic-built home (`local:v3`, with chunks) to `/tmp/eg2-plan/p7-sticky` and start a daemon on it. The boot log names `nomic-embed-text-v1.5` with reason "index built by nomic", and no re-embed starts.
  - Result: `nomic-embed-text-v1.5 (index built by nomic)`. No `embedding migration` line, no model load at boot, statuses and `local:v3` unchanged.
- [x] Sticky index without a stored format (as 0.16.4 and older left it):
  - Result: `nomic-embed-text-v1.5 (index built by nomic)`, then one nomic re-embed (3 files), format `local:v3`. Only the nomic gguf is read (see the decision below).
  - Copy the nomic home and delete the `embedding_format` row from `meta` in the copy.
  - Start a daemon on it. The boot log names `nomic-embed-text-v1.5`, and no re-embed starts.
  - Decision (2026-10-17): a missing format means vectors from 0.16.4 or older. Those are not unit length (format keys came with unit vectors in 0.16.5), so the existing migration re-embeds them once with nomic and stores `local:v3`. That is correct. The pass condition is: the boot log names nomic, one nomic re-embed runs, `embedding_format` ends `local:v3`, and no EmbeddingGemma file is read.
- [ ] After merge: prod `/health` returns `0.18.0`. `fly logs --no-tail` returns only a short buffer, so watch `fly logs -a agent-fs-taras` live during the deploy. No `embedding migration` line appears within 10 min of the deploy.

#### Manual Verification:
- [ ] Before this PR merges: 0.17.4 runs on the swarm (Manual E2E §3, first run), and the Appendix multimodal column is filled.
- [ ] Taras confirms the upgrade note reads clearly for self-hosters.

**Review changes (2026-10-17)**: the resolver probes transformers only on the branches that need it (not for a configured model or a sticky nomic index). A stored EmbeddingGemma 2 index whose transformers cannot load keeps its model and format, and the boot line carries the cause plus the install hint (checked with a preload that blocks the import). Chunks from another provider give the reason "index built by another provider". `.env.example`, README and the docs say local runs nomic on llama.cpp or EmbeddingGemma 2 on transformers.js.

**Follow-up fix (2026-10-17)**: the model and API key in config.json belong to the provider in config.json. When `EMBEDDING_PROVIDER` names another provider, the config loader drops them (an onboarded OpenAI config with `EMBEDDING_PROVIDER=local` no longer turns semantic search off). `config set embedding.provider` clears them on a change, and `setConfig`/`setConfigValue` no longer write env values to config.json.

### Phase 7 additions (2026-10-17, from the local test)

Taras's local test (90 files from ~/Downloads, memo `/tmp/eg2-plan/local-findings.md`) found four problems. Taras chose to fix them in #105, before the default flip.

1. **EmbeddingGemma 2 off the main thread.** onnxruntime-node runs `session.run` and session creation synchronously. Every text chunk (about 1.7 s) and every image held the event loop. GC and vision reloads stalled it for 5 to 10.8 s (9 watchdog stalls, 28 SLOW requests, PDF writes up to 43 s). Run the text and vision models and PDF page rendering in a Bun Worker. The `EmbeddingProvider` interface does not change. Queries go ahead of document work. A dead worker rejects its pending calls, and the next call starts a new worker. The main thread creates and runs no onnxruntime session.
2. **Hybrid image scoring.** FTS never indexes images, so RRF gave an image only the vector term (at most 0.5). Every file in both lists ranked above the best image. An `image` entry that FTS did not hit now scores on the vector list alone (its term counts twice). Text-only drives do not change.
3. **Fixed candidate pool.** Both lists asked for `limit * 3` files, so the hybrid order changed with `--limit`. Use `Math.max(limit, 30)` for both lists. Limits up to 30 then give the same order, and the default limit 10 keeps today's pool.
4. **`kind` on keyword-only hits.** FTS-only hybrid entries get `kind: "text"`.

Not in scope: batching text chunks (after the worker, measure first), the shared 2-slot semaphore that starves the image job, PDF text extraction in the PUT path.

#### Success Criteria (additions):

##### Automated Verification:
- [ ] `bun run typecheck`, `bun run test`, `bun run build` pass
- [ ] `AGENT_FS_TEST_EMBEDDINGGEMMA_HOME=/tmp/eg2-plan/p2-home bun test packages/core/src/__manual_tests__/embeddinggemma.test.ts` passes through the worker
- [ ] E2E `--local-only` and full (MinIO) pass, except the known `share-create` failure
- [ ] Unit tests: an image at vector rank 1 ranks first over text files in both lists, a text-only drive keeps its scores, `--limit 3` gives the first 3 of `--limit 30`, FTS-only hits carry `kind: "text"`

##### QA (dist build, the same 90 files, `AGENT_FS_EMBEDDING_MIGRATION_CPU_SHARE=1`):
- [ ] No watchdog stall. `/health` polled every 200 ms answers within 1 s for the whole prefill (before: 9 stalls of 5 to 10.8 s)
- [ ] PDF writes finish in a few seconds (before: up to 43 s)
- [ ] Hybrid: "GitHub octocat logo", "presentation slide about AI event" and "Ramp logo" put the target image in the top 2 (before: ranks 8, 19 and 4)
- [ ] Boot line still `embeddinggemma-2 (fresh index)`, and peak RSS is no worse than 3.3 GB
- [ ] Docker smoke (the image, a fresh volume, `EMBEDDING_PROVIDER=local`): `Model ready`, one `.md`, one PNG and one PDF write, a `kind: image` hit and a PDF page hit. The worker loads onnxruntime, sharp and `@napi-rs/canvas` on Linux

**Implementation Note**: After this phase, pause for manual confirmation. Then commit `[phase 7] EmbeddingGemma 2 default for fresh indexes`, run `bun install --frozen-lockfile` and `bun run scripts/sync-versions.ts --check`, run `./scripts/release.sh 0.18.0`, and open the PR.

---

## Manual E2E

- Run sections 1 and 2 after Phase 7 is released.
- Run section 3 twice: with 0.17.4 after Phase 6 is released (before Phase 7 merges), then with 0.18.0.
- Replace `<swarm key>` and `<prod key>` with real values from the `my-swarm` skill and from Taras.

### 1. Local, full feature (this Mac)

```bash
cd /Users/taras/worktrees/agent-fs/2026-10-16-embeddinggemma
git fetch origin && git switch --detach origin/main && bun install --frozen-lockfile
mkdir -p /tmp/eg2-plan/fixtures
(cd packages/core && bun -e 'const {createCanvas}=await import("@napi-rs/canvas");const c=createCanvas(512,512);const g=c.getContext("2d");g.fillStyle="#fff";g.fillRect(0,0,512,512);g.fillStyle="#d00";g.beginPath();g.arc(256,256,180,0,7);g.fill();await Bun.write("/tmp/eg2-plan/fixtures/red-circle.png",await c.encode("png"))')
export AGENT_FS_HOME=/tmp/eg2-plan/e2e-home
export AGENT_FS_STORAGE_PROVIDER=local AGENT_FS_LOCAL_ROOT=$AGENT_FS_HOME/storage SERVER_PORT=7533 AGENT_FS_API_URL=http://127.0.0.1:7533
mkdir -p $AGENT_FS_HOME && ln -sfn /tmp/eg2-plan/tjs-cache $AGENT_FS_HOME/models
EMBEDDING_PROVIDER=local bun run packages/cli/src/index.ts daemon start
# poll /health until ready (a hook blocks curl in Claude's Bash; a human can use curl)
bun -e 'for (let i = 0; i < 60; i++) { try { if ((await fetch("http://127.0.0.1:7533/health")).ok) process.exit(0) } catch {} await Bun.sleep(1000) } console.error("daemon not ready"); process.exit(1)'
bun run packages/cli/src/index.ts auth register eg2@local.test
bun run packages/cli/src/index.ts config validate     # expect: configured local model, transformers 4.3.1 loads
grep embeddinggemma-2 $AGENT_FS_HOME/agent-fs.log      # expect: resolved model embeddinggemma-2, reason "fresh index"
FIX=/Users/taras/worktrees/agent-fs/2026-10-16-embeddinggemma/packages/core/src/search/__tests__/fixtures
bun run packages/cli/src/index.ts write notes/aurora.md --content "We watched the northern lights over Tromso."
bun run packages/cli/src/index.ts write pics/circle.png --file /tmp/eg2-plan/fixtures/red-circle.png
bun run packages/cli/src/index.ts write docs/deck.pdf --file $FIX/image-only.pdf
bun run packages/cli/src/index.ts write docs/paper.pdf --file $FIX/text.pdf
# poll vec-search until a path appears (max 5 min per call)
wait_for() { for i in $(seq 1 60); do bun run packages/cli/src/index.ts --json vec-search "$1" | grep -q "$2" && return 0; sleep 5; done; echo "timeout: $1"; return 1; }
wait_for "a red circle" pics/circle.png && wait_for "SOLAR KITE" docs/deck.pdf
bun run packages/cli/src/index.ts search "aurora borealis trip"                    # notes/aurora.md first
bun run packages/cli/src/index.ts vec-search "a red circle"                        # pics/circle.png, [image]
bun run packages/cli/src/index.ts vec-search "basalt lighthouse maintenance log"   # docs/paper.pdf [page 2]
bun run packages/cli/src/index.ts --json vec-search "SOLAR KITE"                   # docs/deck.pdf, kind image, page 1
bun run packages/cli/src/index.ts daemon stop && rm -rf /tmp/eg2-plan/e2e-home
unset AGENT_FS_HOME AGENT_FS_STORAGE_PROVIDER AGENT_FS_LOCAL_ROOT SERVER_PORT AGENT_FS_API_URL
```

### 2. Prod (OpenAI) after each merge

`fly logs --no-tail` returns only a short buffer. Watch the live log during each deploy instead. "No re-embed" means no `embedding migration` line within 10 min of the deploy.

```bash
fly status -a agent-fs-taras
fly logs -a agent-fs-taras | grep --line-buffered -E "embedding migration|error"   # live, stop it 10 min after the deploy
AGENT_FS_API_URL=https://agent-fs-taras.fly.dev AGENT_FS_API_KEY=<prod key> agent-fs search "<known prod topic>"
```

Fetch `https://agent-fs-taras.fly.dev/health` with `ctx_execute` and check `version`.

### 3. Swarm deploy (0.17.4, then 0.18.0)

- Ask Taras before the backup, the `.env` edit and the deploy. Follow the Phase 3 §2 conventions and pre-deploy checks.
- First run: `V=0.17.4`, after Phase 6 is released and before Phase 7 merges. Fill the Appendix multimodal column from this run.
- Second run: `V=0.18.0`, after Phase 7 is released.

```bash
ssh swarm-taras 'free -m; docker stats --no-stream --format "{{.Name}} {{.MemUsage}} {{.CPUPerc}}"'
ssh swarm-taras 'df -h / && cd /opt/my-swarm && docker compose stop agent-fs && mkdir -p /root/backups && docker run --rm -v my-swarm_agent_fs_data:/data:ro -v /root/backups:/b busybox tar czf /b/agent-fs-data-$(date +%F-%H%M).tgz --exclude ./models -C /data . ; docker compose start agent-fs'
# in ~/Documents/my-swarm/.env: AGENT_FS_VERSION=$V (keep AGENT_FS_EMBEDDING_MODEL=embeddinggemma-2), edited with sed, mirrored in .env.example
(cd ~/Documents/my-swarm && scripts/deploy.sh swarm-taras)
ssh swarm-taras 'cd /opt/my-swarm && docker compose logs -t agent-fs' | grep -E "Model ready|embedding migration|image"
ssh swarm-taras 'docker exec -i -w /app/packages/cli/dist my-swarm-agent-fs-1 bun run -' < /tmp/eg2-plan/scripts/index-invariants.js   # only zeros
export AGENT_FS_API_URL=https://fs.taras.cc AGENT_FS_API_KEY=<swarm key>
FIX=/Users/taras/worktrees/agent-fs/2026-10-16-embeddinggemma/packages/core/src/search/__tests__/fixtures
agent-fs write qa/eg2/circle.png --file /tmp/eg2-plan/fixtures/red-circle.png
agent-fs write qa/eg2/deck.pdf --file $FIX/image-only.pdf
# poll vec-search until a path appears (max 5 min per call)
wait_for() { for i in $(seq 1 60); do agent-fs --json vec-search "$1" | grep -q "$2" && return 0; sleep 5; done; echo "timeout: $1"; return 1; }
wait_for "a red circle" qa/eg2/circle.png && wait_for "SOLAR KITE" qa/eg2/deck.pdf
agent-fs vec-search "a red circle"          # qa/eg2/circle.png first, [image]
agent-fs vec-search "SOLAR KITE"            # qa/eg2/deck.pdf, [PDF page 1]
ssh swarm-taras 'docker stats --no-stream --format "{{.Name}} {{.MemUsage}} {{.CPUPerc}}"'
agent-fs rm qa/eg2/circle.png && agent-fs rm qa/eg2/deck.pdf
```

Open `https://ui-fs.taras.cc`, search "a red circle", and confirm the thumbnail. Click the deck hit and confirm it opens at page 1.

## Appendix

- **Follow-up plans**:
  - Configurable vector width (needed for Cohere, Voyage, Nova).
  - `gemini-embedding-2` cloud provider (6 images and 6 PDF pages per request, separate vector space).
  - Chunker swap: move from `chonkie@0.3.0` (the last release, June 2025) to `@chonkiejs/core` (no transformers dependency, 1 char = 1 token). Size chunks in characters (about 3600 for today's 900 gpt2 tokens). This drops transformers 3.8.1, ORT 1.21 and a sharp copy from every install, makes Linux global installs work with EmbeddingGemma 2, and lets the Linux guard go. `@chonkiejs/token` still needs transformers ^3.5.1, so do not use it. New writes get new chunk boundaries.
- **Derail notes**:
  - `formatSearch` drops the `hint` field (`packages/cli/src/formatters.ts:187-200`). `formatFts` prints it.
  - `mv` onto an existing text target does not delete the old target chunks before the re-path, so duplicate chunk sets can appear (`ops/mv.ts:72-89`, found by reading, not tested).
  - Images and PDFs saved without an extension get `application/octet-stream` and are never indexed. Magic-byte sniffing would fix it.
  - `live/src/components/search/SearchResults.tsx` is dead code.
  - The live UI shows the hybrid RRF score (about 0.03) as "3%".
  - The Docker image carries `onnxruntime-node` binaries for every platform (about 200 MB, one version after the Phase 2 override). Pruning `darwin` and `win32` in the runtime stage would shrink it.
  - npm and bun global installs still nest chonkie's transformers 3.8.1. So an opt-in global install on Linux loads two ORT versions. Phase 2 QA states whether that works.
  - Garbled PDF text (fonts without a Unicode map) still gets embedded.
  - The image token budget is one code constant. A later change needs a way to re-queue all image units (for example a revision in `meta`). Not built until a change is needed.
  - `onnxruntime` uses all cores per inference. On the shared swarm box, an `intraOpNumThreads` limit may help the API and lead stay responsive.
  - The swarm compose fallback `AGENT_FS_VERSION:-0.16.7` drifts from `.env`.
  - The `Dockerfile` `HEALTHCHECK` runs `curl`, but the `oven/bun:1.4.1-slim` runtime image has no `curl` (checked on the 0.17.0 image). Docker always marks the container unhealthy. Fly uses its own checks.
  - chonkie loads its `Xenova/gpt2` tokenizer into the transformers default cache inside `node_modules`. In Docker that cache is not on the volume, so each new container downloads it again. Offline, chonkie fails and `chunkContent` silently falls back to paragraph chunks.
  - Under the explicit `EMBEDDING_PROVIDER=local` path, a cloud model name that onboarding left in `config.json` (`text-embedding-3-small`) now gives "Unknown local embedding model" and no provider. Before 0.17.1, nomic loaded.
- **Dual-runtime spike** (filled in Phase 2 §0): chonkie `RecursiveChunker`, then EmbeddingGemma 2 q8 text-only, in one bun process.
  - Setup (2026-10-17): scratch projects in `/tmp/eg2-plan/dual-runtime/{arm64,amd64,darwin}` with `chonkie@0.3.0` and `@huggingface/transformers@4.3.1`, no overrides. Installed: transformers 4.3.1 + onnxruntime-node 1.30.0 at the top, transformers 3.8.1 + onnxruntime-node 1.21.0 nested under chonkie. chonkie 0.3.0 is the latest release and requires `@huggingface/transformers ^3.5.1`.
  - `linux/arm64`: FAIL in both orders. Chonkie first: `libonnxruntime.so.1: version 'VERS_1.30.0' not found (required by .../onnxruntime-node/bin/napi-v6/linux/arm64/onnxruntime_binding.node)`. Model first: the model embeds (768 dims, norm 1.0), then chonkie fails with `version 'VERS_1.21.0' not found`. The second binding binds to the first library (same SONAME).
  - `linux/amd64` (QEMU): FAIL, the same error as arm64 with chonkie first. This is not an emulation effect.
  - `darwin/arm64` (native, extra check): PASS in both orders. The only side effect is an `objc` duplicate-class warning from the two sharp/libvips copies.
  - Consequence: the Docker image and the workspace are safe only because the root `overrides` gives one transformers. A Linux global install (`bun add -g`) keeps chonkie's nested 3.8.1, so EmbeddingGemma 2 cannot run there.
- **Swarm measurements** (filled in Phase 3 and in the 0.17.4 run of Manual E2E §3, before Phase 7 merges):

  | Metric | nomic 0.16.7 | EmbeddingGemma 2, 0.17.1 | EmbeddingGemma 2 multimodal, 0.17.4 |
  | --- | --- | --- | --- |
  | agent-fs RSS idle | 259 MiB (during an embed burst). 101 MiB on 0.17.0, 2026-10-17 (47 files, 29 indexed, 178 chunks, `local:v3`, invariants all 0) | | |
  | agent-fs RSS peak (re-embed or image job) | | | |
  | Model download + first load | n/a | | |
  | Re-embed duration (34 files, 170 chunks) | n/a | | |
  | Query latency median (10 queries) | not measured: the swarm agent-fs key is an agent-scoped swarm secret, and reading it needs Taras. Queries are in `/tmp/eg2-plan/p3-baseline.md` | | |
  | First query after boot | | | |

- **Image token budget** (filled in Phase 5):

  | Budget | R@1 | R@5 | MRR | I R@5 | P R@5 | ms per image (Mac) |
  | --- | --- | --- | --- | --- | --- | --- |
  | 280 | 0.75 | 1.00 | 0.85 | 1.00 | 1.00 | 3814 (plan run: 3847) |
  | 140 | 0.75 | 1.00 | 0.86 | 1.00 | 1.00 | 1628 |
  | 70 | 0.72 | 0.97 | 0.83 | 0.88 | 1.00 | 783 |

  Decision (2026-10-17): budget 140. It keeps I R@5 and P R@5 at 1.00 and R@1 equal to 280, at 2.3x less time per image. 70 fails the rule (I R@5 0.88, R@1 -0.03). All rows are config E3t with q8, from one eval.ts run. Rank moves at 140: I4 3 to 1, H11 1 to 2.

- **References**:
  - Spike: `/Users/taras/Documents/code/agent-fs/thoughts/taras/research/2026-10-16-embeddinggemma-2-spike.md`
  - Planning reports: `/tmp/eg2-plan/reports/` (not durable, copied here where it matters)
  - Model card: https://huggingface.co/onnx-community/embeddinggemma-2-ONNX
  - transformers.js darwin x64 gap: https://github.com/huggingface/transformers.js/issues/1634
  - `RELEASING.md`, `DEPLOYMENT.md`, memory notes `live-ui-browser-e2e-needs-minio`, `prod-access-agent-fs-taras`

## Review Errata

_Reviewed: 2026-10-17 by Claude (4 sub-agent reviewers: codebase claims, design, commands/ops, library APIs)_

### Applied

- [x] A1 [C] Transformers and `@napi-rs/canvas` move to the root `package.json`, because the Docker image cannot resolve a core-only dependency.
- [x] A2 [C] Phase 2 adds a dual-runtime spike and a root `overrides` pin, so chonkie and the provider share one ORT.
- [x] A3 [C] `loadTransformers()` requires version 4.3.1. Phase 2 QA tests a Linux global install, and `npm i -g` is not supported.
- [x] A4 [C] A boot gate warms the provider up before the migration, so a failed load never changes the stored format.
- [x] B1 [I] An explicit `EMBEDDING_PROVIDER` takes `config.apiKey` first, so a key in `config.json` still works.
- [x] B2 [m] The Phase 1 grep matches only `embed(` and `embedBatch(`.
- [x] B3 [m] Phase 2 §3 says that an unknown `EMBEDDING_MODEL` gives a `null` provider plus one stderr line.
- [x] C1 [I] Each instance loads its own `AutoConfig`, and every `from_pretrained` call gets `cache_dir`.
- [x] C2 [I] `e2e.ts` parses the new flags with `rawArgs.indexOf` and updates the usage line.
- [x] C3 [I] The Phase 2 Docker smokes have exact commands that resolve from the CLI bundle dir.
- [x] C4 [m] The warning for `EMBEDDING_MODEL` with OpenAI or Gemini is removed, because onboarding writes model names for them.
- [x] C5 [m] The CLI build marks 14 packages external, not 15.
- [x] D1 [I] Deploys use `scripts/deploy.sh swarm-taras`. No server IP placeholder remains.
- [x] D2 [I] The swarm backup stops agent-fs and skips `models`. Phase 3 has a restore command.
- [x] D3 [I] Phase 3 follows the my-swarm conventions, and the approval prompt names the `fs-ui` version change.
- [x] D4 [I] The Phase 3 rollback covers model, version and data, in a safe order.
- [x] D5 [I] Log greps run without `--since` and check for `embedding migration done`.
- [x] D6 [m] The swarm sqlite check expects the output to contain `embeddinggemma:v2` and `n: 0`.
- [x] D7 [I] A read-only index invariant script runs in Phases 3, 4 and 5 and in both swarm checks.
- [x] E1 [C] An empty chunk list skips the provider and marks the file `indexed`.
- [x] E2 [C] `indexBytesForSearch` becomes async, and an extraction error never fails a write. New fixtures cover encrypted and truncated PDFs.
- [x] E3 [C] `extractPdfText` opens a copy of the bytes and destroys the document in `finally`.
- [x] E4 [I] Extraction yields between pages and stops at `MAX_EMBED_CHARS`. A 1000-page QA checks the event loop.
- [x] E5 [I] The FTS refresh runs for PDFs only, inside the version-guarded transaction.
- [x] E6 [I] Phase 4 lists every results touch point, and Phases 4 and 5 state the FTS override rule.
- [x] E7 [I] The Phase 4 migration QA runs with a provider.
- [x] E8 [m] The `cupsfilter` fixture command writes to stdout.
- [x] E9 [m] `cat.ts` and `share.ts` keep `decodeIndexableText`.
- [x] E10 [m] The line references for `runPendingEmbeddings`, `decodeIndexableText` and `MIME_MAP` are correct.
- [x] F1 [C] Deletes are kind-scoped. Only `rm` deletes both kinds, and `reindex` keeps image chunks.
- [x] F2 [I] Text writes reset stale image chunks, and `mv` carries the image status with an explicit update.
- [x] F3 [I] The image job starts after the text migration and never runs at the same time.
- [x] F4 [I] The image job paces each part and commits once per file.
- [x] F5 [I] The vision instance is recreated after 50 images, and a poison file cannot loop after a crash.
- [x] F6 [I] A provider init error leaves image files `pending`. `reindex` re-queues `failed` image rows.
- [x] F7 [I] `pdfPageImages` resolves once at boot and controls the write branch and the boot query.
- [x] F8 [I] A constant `PDF_PAGE_IMAGES = 3` replaces the page-image env var. Its old default of 10 was unmeasured and had no re-queue rule.
- [x] F9 [m] A format change clears all image chunks and statuses. The boot query re-queues the supported files.
- [x] F10 [I] `renderPdfPages` opens the PDF once, wraps each buffer, and skips a page that fails to render.
- [x] F11 [I] Phase 5 tests cover text and image chunks on one PDF, and `reindex` on an image.
- [x] F12 [m] The single-flight flag resets in `finally`.
- [x] F13 [I] The Phase 5 docs make no RAM claim before a Linux measurement.
- [x] G1 [m] Phase 6 names the local `ResultItem` and its mappers in `SearchModal.tsx`.
- [x] G2 [m] Phase 6 notes the single `SearchResultItem` in `live/src/api/types.ts`.
- [x] H1 [I] The resolver keeps nomic for an index with chunks and no stored format.
- [x] H2 [I] The doctor is `agent-fs config validate`. The resolved model comes from the daemon boot log.
- [x] H3 [I] `transformersAvailable` uses `loadTransformers()`.
- [x] H4 [I] Prod log checks watch `fly logs` live, not `--no-tail`.
- [x] I1 [I] Each phase runs the frozen install and the version check before `release.sh`.
- [x] I2 [m] Each phase starts with `git fetch origin && git switch -c <branch> origin/main`.
- [x] J1 [C] Manual E2E §1 sets the local storage env, polls `/health`, and registers a user.
- [x] J2 [C] Manual E2E uses `config validate` and reads the resolved model from the daemon log.
- [x] J3 [C] Manual E2E §3 deploys in a subshell and uses absolute fixture paths.
- [x] J4 [m] Manual E2E polls `vec-search` instead of sleeping, uses literal fixture phrases, and unsets its env.
- [x] J5 [I] Manual E2E §3 runs first with 0.17.4 and fills the multimodal column before Phase 7 merges.
- [x] L1 [m] Phase 4 §8 fixes the fixture phrases that the Phase 5 tests and the Manual E2E use.
- [x] M1 [m] (orchestrator check) The boot gate warms the provider up only when the format differs, so prod makes no extra OpenAI call per deploy.
- [x] M2 [m] (orchestrator check) The `SearchModal.tsx` line references match `main` (`:21`, `:76`, `:90`, `:105`).
