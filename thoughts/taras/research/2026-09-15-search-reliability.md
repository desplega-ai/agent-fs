---
date: 2026-09-15
researcher: Codex
git_commit: d5022bbdfdbb75471eab7515b75e20f056c53837
branch: main
repository: agent-fs
topic: File and content search reliability
tags: [research, search, live, s3, fts, sqlite-vec]
status: complete
autonomy: critical
last_updated: 2026-09-15
last_updated_by: Codex
---

# Research: File and Content Search Reliability

## Research Question

Why does searching for `ai-tinkerers` miss an existing file in the configured backend and live UI?
Test the failure and plan a fix.

## Summary

Two live defects explain the reported filename and Full-text failures.
S3 listing ignores continuation tokens, so filename search sees only the first 1,000 objects.
Full-text passes a hyphenated query to SQLite as query syntax.
SQLite rejects it, but the UI displays a successful empty result.

The selected file can conceal the filename defect.
The tree keeps that file visible even when the search response contains no matches.
Seeing the document in the filtered tree did not prove successful search.

Hybrid and Semantic returned the target in the tested drive.
Hybrid ranked it fourth, and Semantic ranked it ninth with the default limit of ten.
The report that every mode returns zero was not reproducible in this session.

Separate local tests exposed semantic omissions when other drives or repeated chunks consume the candidate limit.
These tests establish backend defects, but they do not establish the cause of this document's semantic ranking.

## Environment and Scope

- Source commit: `d5022bbdfdbb75471eab7515b75e20f056c53837` on `main`.
- Source and live backend version: `0.13.5`.
- Installed CLI version: `0.13.4`.
- Backend: [Taras's agent-fs instance](https://agent-fs-taras.fly.dev).
- UI: [Reported file](https://live.agent-fs.dev/file/~/648a5f3c-35c8-4f11-8673-b89de52cd6bd/2faf73ba-4eee-4472-8b3b-359c4ed6bfbb/thoughts/16990304-76e4-4017-b991-f3e37b34cf73/research/2026-09-15-ai-tinkerers-demo-proposal.md).
- Organization: `648a5f3c-35c8-4f11-8673-b89de52cd6bd`, named `swarm`.
- Drive: `2faf73ba-4eee-4472-8b3b-359c4ed6bfbb`, named `default`.

The saved CLI configuration points to this backend, but its default organization and drive differ.
Every reported CLI search supplied the target organization and drive explicitly.
The browser used an isolated session and the existing credential.
The session and temporary authentication profile were removed after testing.
No production files, indexes, configuration, or deployments changed.

## Live Test Results

The target exists, contains 16,021 bytes, and returns 140 complete lines.
Its metadata reports `text/markdown`, version `1`, and `embeddingStatus: indexed`.
Quoted Full-text also returns the file, so its missing index is not the cause of this incident.

| Test | Result | Target present |
| --- | --- | --- |
| Open the supplied URL | Document renders | Yes |
| CLI root glob `**/*` | Exactly 1,000 objects | No |
| CLI root glob `**/*ai-tinkerers*` | Zero matches | No |
| CLI same glob within the research folder | Two matches | Yes |
| UI Files, drive root, `ai-tinkerers` | `No matches` | No |
| UI Files while target remains selected | Selected file remains visible | Visibility does not prove a match |
| CLI and UI Full-text, `ai-tinkerers` | `no such column: tinkerers` | Request fails |
| UI presentation of that failed request | `No results` | Misleading empty state |
| Full-text, `ai tinkerers` | Nine results | Fourth |
| Full-text, quoted phrase `"ai tinkerers"` | Eight results | Fourth |
| UI Hybrid, `ai-tinkerers` | Ten results | Fourth |
| UI Semantic, `ai-tinkerers` | Ten results | Ninth |
| CLI Semantic, same query, limit five | Five results | Outside returned range |
| Full-text, `ai thinkerers` | Zero results | No |
| UI Hybrid and Semantic, `ai thinkerers` | Ten results each | No |

The spelling `thinkerers` differs from `tinkerers`.
Files matches a case-sensitive glob, and Full-text matches indexed tokens.
Neither mode implements spelling correction.
The semantic results for the misspelling were unrelated to the target.

### Browser evidence

- [Filename search misses the target at drive root](../qa/evidence/2026-09-15-search/06-files-root-empty.png).
- [Full-text displays an empty state for an error](../qa/evidence/2026-09-15-search/04-fulltext-empty.png).
- [Spaced Full-text returns the target](../qa/evidence/2026-09-15-search/05-fulltext-spaced-results.png).
- [Sanitized browser requests](../qa/evidence/2026-09-15-search/browser-requests.json).
- [CLI commands and results](../qa/evidence/2026-09-15-search/results.md).

The browser recorded an HTTP `400` response for Full-text `ai-tinkerers`.
The response carried `INTERNAL_ERROR` and `no such column: tinkerers`.
The recording contains operation arguments and sanitized results, without request headers or credentials.

## Detailed Findings

### 1. S3 pagination truncates filename search

`AgentS3Client.listObjects` issues one `ListObjectsV2Command` and returns that response.
It ignores `IsTruncated` and `NextContinuationToken`.
See `packages/core/src/s3/client.ts:134-153`.

`glob` asks this method for all objects below the requested prefix, then applies the glob expression.
See `packages/core/src/ops/glob.ts:49-55` and `:75-88`.
The UI always requests `**/*<input>*` across the active drive.
See `live/src/hooks/use-glob-search.ts:5-12`.

The live root listing stopped under `/misc` after 1,000 objects.
The target lives under `/thoughts`, beyond that returned page.
Restricting the CLI prefix to the research folder returned both matching files.
Both leading-slash variants of the prefix succeeded.

The local reproduction supplied a second S3 page containing the target.
The implementation requested only the first page and returned zero matches.
`LocalStorageAdapter` already drains its own cursor at `packages/core/src/storage/local-adapter.ts:175-205`.
The S3 defect also affects other callers, including `ls` and `tree`.

### 2. UI text enters the raw FTS grammar

`useFtsSearch` forwards the text unchanged at `live/src/hooks/use-fts-search.ts:9-10`.
The operation forwards it to `ftsQuery` at `packages/core/src/ops/fts.ts:24-28`.
SQLite evaluates it through `content MATCH ?` at `packages/core/src/search/fts.ts:83-92`.

An isolated database rejects `ai-tinkerers` with the same live error.
The quoted input `"ai-tinkerers"` returns the indexed target.
The existing E2E fixture deliberately avoids hyphens at `scripts/e2e.ts:1269-1275`.
It therefore misses the ordinary UI input that triggers this failure.

Raw FTS supports advanced expressions for CLI and MCP callers.
The smallest compatible change serializes literal user input at the UI boundary.
It does not silently redefine the raw operation's grammar.

Hybrid already quotes whitespace-separated terms and joins them with `OR`.
See `packages/core/src/ops/search.ts:179-206`.
That code does not escape embedded double quotes and catches query errors as empty keyword results.
Literal serialization needs an embedded-quote regression case too.

### 3. UI states conceal search failures

`SearchModal` derives results and loading state but ignores query errors and backend hints.
See `live/src/components/search/SearchModal.tsx:63-96`.
Its empty-state branch presents those errors as zero matches.

`SearchBar` also converts absent glob data to an empty array.
See `live/src/components/search/SearchBar.tsx:52-63`.
The file-search store has no error state at `live/src/stores/file-search.ts:19-25`.

The tree preserves the selected file regardless of search matches.
See `live/src/components/file-tree/FileTreeNode.tsx:72-78`.
It also suppresses the no-match state while a file remains selected.
See `live/src/components/file-tree/FileTree.tsx:236-240`.
These rules explain why an already open document can make a failed search look successful.

All search modes operate across the selected drive.
Opening a folder does not add a search prefix in the UI.
The scope should be explicit in the search presentation.

### 4. Semantic candidates are limited before scope and file deduplication

Vector search requests the nearest chunks across all drives, then filters by the active drive.
See `packages/core/src/ops/vec-search.ts:44-75`.
Hybrid repeats this order at `packages/core/src/ops/search.ts:133-153`.
Output remains scoped, but foreign-drive candidates can remove valid results.

The local test created two nearer foreign-drive chunks and one eligible chunk.
Both operations returned zero files at limit one.
Increasing the limit exposed the eligible file.

A separate fixture placed four nearest chunks in one file and a fifth chunk in another file.
Vector search with limit two returned only the first file.
Its fixed `limit * 2` fetch cannot guarantee two distinct files.

The installed sqlite-vec `0.1.9` accepts scope through an eligible-ID subquery before the KNN limit.
The equivalent join shape failed in the local experiment.
The fix plan uses the verified query shape and requires distinct-file coverage.
The extension caps K at 4,096 and rejected a request for 5,000 candidates.
A tested loop excludes selected file paths through one `json_each(?)` parameter and requests the remaining number of files.
This avoids an arbitrary overfetch multiplier and respects the extension limit.

## Verification Performed

- `bun run test`: 526 passed, 57 skipped, zero failed.
- `bun run typecheck`: passed.
- `cd live && pnpm build`: passed.
- Focused Full-text and operation tests: 39 passed.
- Root agent repeated the pagination, raw Full-text, and semantic scope reproductions successfully.
- [Sanitized local outputs](../qa/evidence/2026-09-15-search/outputs.txt).

Existing passing tests do not cover the reproduced failures.
The investigation did not execute the Docker/MinIO E2E suite.
That suite is required during implementation to verify actual S3 continuation behavior.

Temporary reproduction scripts live under `/tmp/agent-fs-search-2026-09-15/`.
Run them before implementation with:

```sh
bun /tmp/agent-fs-search-2026-09-15/repro-glob-pagination.ts
bun /tmp/agent-fs-search-2026-09-15/repro-fts.ts
bun /tmp/agent-fs-search-2026-09-15/repro-vector-scope.ts
bun /tmp/agent-fs-search-2026-09-15/repro-vector-sql-scope.ts
bun /tmp/agent-fs-search-2026-09-15/repro-vector-duplicates.ts
bun /tmp/agent-fs-search-2026-09-15/repro-vector-distinct-loop.ts
bun /tmp/agent-fs-search-2026-09-15/repro-vector-k-limit.ts
```

## Separate Findings and Limits

- Reindex skips missing Full-text rows when the file's embedding status is already indexed.
  A local fixture reproduced this, but the reported target has a working Full-text entry.
- Semantic scores and spelling tolerance need a relevance evaluation with labeled queries.
  This investigation did not evaluate or change embedding providers.
- Some result paths differ only by a leading slash.
  Resolving historical duplicate identities needs separate analysis before any data repair.
- Repeated Escape interactions left the browser modal overlay present.
  Source analysis did not establish its cause, so the plan includes a smoke check without prescribing a speculative fix.
- Search cache keys omit endpoint identity.
  This session did not reproduce a cache collision between backends.

## Required Delivery Steps

Implementation must update `skills/agent-fs/SKILL.md` for changed search behavior.
It must add CLI and MCP regression coverage in `scripts/e2e.ts`.
It must prepare a patch release through [RELEASING.md](../../../RELEASING.md).
The [implementation plan](../plans/2026-09-15-search-reliability.md) defines these steps and concrete verification commands.
