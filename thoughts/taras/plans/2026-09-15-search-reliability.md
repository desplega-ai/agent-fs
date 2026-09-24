# Search Reliability Implementation Plan

## Overview

Make filename and content search reliable for the reported `ai-tinkerers` document.
Fix the proven failures and preserve existing CLI query syntax.

- **Status:** Implemented in [PR #43](https://github.com/desplega-ai/agent-fs/pull/43). Postdeployment acceptance remains pending.
- **Source:** `d5022bbdfdbb75471eab7515b75e20f056c53837`, version `0.13.5`.
- **Research:** [Live evidence and local reproductions](../research/2026-09-15-search-reliability.md).
- **Delivery:** Four phases, followed by review and the existing release process.

## Current State Analysis

| Failure | Evidence | Source |
| --- | --- | --- |
| Filename search sees only the first S3 page | Root glob returns 1,000 objects and misses the target | `packages/core/src/s3/client.ts:134-153` |
| Full-text treats ordinary text as query syntax | `ai-tinkerers` causes `no such column: tinkerers` | `live/src/hooks/use-fts-search.ts:9-10` |
| UI reports failures as empty results | HTTP 400 becomes `No results` | `live/src/components/search/SearchModal.tsx:63-96` |
| Selected files conceal empty filename results | The selected file remains visible without a match | `live/src/components/file-tree/FileTreeNode.tsx:72-78` |
| Semantic limits precede drive scope | Local fixture returns zero despite an eligible file | `packages/core/src/ops/vec-search.ts:44-75` |
| Repeated chunks consume the file limit | Limit two returns one file despite another eligible file | `packages/core/src/ops/vec-search.ts:52-76` |

Hybrid currently returns the target fourth, and Semantic returns it ninth with the default limit of ten.
The target's Full-text index exists.
A production reindex is unnecessary for this incident.

## Desired End State

- Files finds a filename fragment anywhere in the active drive, including objects beyond page one.
- UI Full-text treats input as literal search terms.
- `ai-tinkerers`, `ai tinkerers`, and embedded quotes cannot become unintended FTS syntax.
- Raw CLI and MCP `fts` retain documented advanced query syntax.
- Every mode distinguishes loading, successful results, successful empty results, errors, and provider hints.
- The selected file never masquerades as a search match.
- The UI identifies the active drive and makes its drive-wide scope explicit.
- Semantic and Hybrid select candidates within the active drive before applying limits.
- Semantic candidate limits count distinct eligible files.

## Scope Boundaries

Spelling correction, embedding-provider changes, historical path repair, and index repair remain separate work.
This plan does not promise that `ai thinkerers` finds `ai-tinkerers`.
Files retains its current case-sensitive glob behavior.
Full-text retains exact-token semantics, with literal input serialization in the UI.

## Implementation Approach

Fix S3 listing at the shared storage boundary.
Serialize UI input before it reaches raw FTS.
Represent request errors explicitly in the existing search components and store.
Use one shared helper for the two existing vector candidate implementations.
Keep existing storage, SQLite tables, and public operation names.

## Quick Verification Reference

Run from the repository root:

```sh
bun run typecheck
bun run test
bun run build
pnpm --dir live build
bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only
bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"
bun run scripts/sync-versions.ts --check
```

The default E2E mode requires Docker and MinIO.
The local-only mode cannot prove S3 pagination.
Both modes belong in final verification.
Use pnpm for any changes under `live/`.

## Phase 1: Complete S3 Listings

### Overview

`AgentS3Client.listObjects` returns every page of objects and directory prefixes.
The reported filename becomes discoverable from the drive root.

### Changes Required

1. Update `packages/core/src/s3/client.ts` to follow continuation tokens until S3 reports completion.
   Preserve bucket, prefix, and delimiter on every request.
   Aggregate `Contents` and `CommonPrefixes` across pages.
   Deduplicate directory prefixes while preserving their order.
2. Add pagination tests in `packages/core/src/s3/__tests__/client.test.ts`.
   Cover objects, delimiter-only pages, empty final pages, and a failure on a later page.
   A later failure must reject the request rather than return a misleading partial success.
   Reject a truncated response without a usable continuation token.
3. Extend `scripts/e2e.ts` with a MinIO fixture containing more than 1,000 objects.
   Place a target beyond the first page and test root glob through the CLI.
   Reuse the fixture to check that `tree` returns objects from later pages.
   Test later-page directory prefixes through `ls` with mocked S3 responses.
4. Keep the fixture within the E2E harness's disposable MinIO instance.
   Let the existing container cleanup remove the fixture.
   Use direct fixture setup to avoid generating unnecessary embeddings for every padding object.

### Verification

```sh
bun test packages/core/src/s3/__tests__/client.test.ts
bun test packages/core/src/storage/__tests__/
bun run typecheck
bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"
```

### Success Criteria

#### Automated Verification

- [x] The listed commands pass.
- [x] A mock verifies the second request receives the first response's continuation token.
- [x] A later-page failure cannot produce a successful truncated listing.

#### Automated QA

- [x] MinIO returns the target after at least 1,000 preceding objects.
- [x] Root glob and recursive tree return the target beyond page one.
- [x] Mocked `ls` listings retain directory prefixes from later pages.

#### Manual Verification

- [ ] No human-only check is required. Taras reviews the evidence before the next phase unless autopilot is selected.

## Phase 2: Literal Queries and Honest Search States

### Overview

The UI accepts ordinary Full-text input and displays the actual request outcome.
The file tree distinguishes a selected file from a matching result.

### Changes Required

1. Add a small literal FTS serializer under `live/src/lib/` and call it from `use-fts-search.ts`.
   Split whitespace, replace each embedded `"` with `""`, quote each term, and join terms with `AND`.
   FTS5 requires doubled quotes rather than backslash escaping.
   Preserve the original input in the textbox and query cache key.
   Retain raw syntax in the core `fts` operation, CLI, and MCP.
   Apply the same quote-doubling rule to Hybrid without changing its `OR` semantics.
2. Extend `SearchModal.tsx` to consume the active query's error, success state, and backend hint.
   Show a useful error and Retry action after a failed request.
   Show an empty state only after a successful response contains no matches.
   Preserve the provider-unavailable and keyword-only hints in API types and presentation.
3. Extend `live/src/stores/file-search.ts`, `SearchBar.tsx`, and `FileTree.tsx` with an explicit error state.
   Clear prior results when the active drive changes.
   Keep selected-file visibility only with a distinct label when that file does not match.
   Show the real match count and explicit drive-wide scope.
4. Add literal-query and store-state tests under `live/src/lib/`, which the root test command already includes.
   Add backend cases in a new credential-free `packages/core/src/ops/__tests__/search-regressions.test.ts`.
   Use in-memory databases and deterministic embeddings for these regressions.
   The existing `search.test.ts` requires MinIO and can skip, so it cannot hold the only regression coverage.
   Validate rendering through agent-browser against the local UI with controlled API responses.
   Add quoted raw FTS cases to CLI and MCP E2E coverage without removing advanced-expression cases.

The literal serializer converts `ai-tinkerers` to `"ai-tinkerers"`.
It converts `ai tinkerers` to `"ai" AND "tinkerers"`.
It treats operators entered in the UI as ordinary text.
Advanced expressions remain available through the raw operation.

### Verification

```sh
bun test live/src/lib/
bun test packages/core/src/search/__tests__/fts.test.ts packages/core/src/ops/__tests__/search-regressions.test.ts
bun run typecheck
pnpm --dir live build
bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only
pnpm --dir live exec vite --host 127.0.0.1 --port 5178
```

Start the Vite command as a background process for browser QA.
Use a disposable local backend and credential for mutation fixtures.
Mock failures only against the local UI, then repeat successful searches against the configured live backend after deployment.

### Success Criteria

#### Automated Verification

- [x] Literal serialization covers hyphens, quotes, colons, parentheses, Unicode, operators, empty input, and whitespace.
- [x] Full-text raw expressions still pass existing CLI and MCP tests.
- [x] File-search state tests distinguish errors from successful empty results.
- [x] The listed type checks, tests, and build pass.

#### Automated QA

- [x] Full-text `ai-tinkerers` finds the fixture and sends a quoted pattern.
- [x] A backend failure and a network failure display errors rather than zero matches.
- [x] A successful empty response displays a normal empty state.
- [x] Missing embeddings show the backend hint. Hybrid identifies keyword-only results.
- [x] A selected nonmatching file carries a distinct label and does not increase the match count.
- [x] Request changes and drive changes clear stale results and preserve the correct scope.
- [x] Result activation and Escape receive a smoke check. Expand this coverage only if the implementation changes their behavior.

#### Manual Verification

- [ ] Taras reviews the empty state, error state, and selected-file label in the browser evidence before the next phase.

## Phase 3: Scope Semantic Candidates Before Limits

### Overview

Vector search and Hybrid share one candidate helper that returns distinct files from the active drive.
Foreign-drive chunks and repeated chunks cannot consume the requested file limit.

### Changes Required

1. Add a helper under `packages/core/src/search/` for the two current candidate queries.
   Use the verified `chunk_id IN (SELECT id FROM content_chunks WHERE drive_id = ? ...)` constraint inside KNN.
   Join eligible chunks to live `files` by drive and path inside that subquery.
   Exclude deleted or missing files before selecting candidates.
   Keep the current embedding provider, distance metric, result scores, and Hybrid fusion weights.
2. Return distinct files through successive scoped KNN rounds.
   Request at most `min(remaining file count, 4096)` chunks in each round.
   Exclude previously selected file paths from the next round's eligible chunks.
   Use `file_path NOT IN (SELECT value FROM json_each(?))` with one JSON parameter for the selected paths.
   Stop when enough files exist or the scoped query returns no candidates.
   Preserve nearest-first order and the best chunk for each file.
3. Replace the candidate loops in `ops/vec-search.ts` and `ops/search.ts` with this helper.
   Preserve public result shapes and explicit provider hints.
   Do not introduce a schema migration or an arbitrary overfetch multiplier.
4. Add deterministic embeddings and multiple-drive fixtures to the new credential-free `ops/__tests__/search-regressions.test.ts`.
   Cover foreign-drive winners, repeated chunks, deleted files, and limits larger than the eligible file count.
   Add a large fixture and assert that every nonempty round adds at least one file.
   Assert that query rounds do not exceed the requested file limit.
   Record latency as observational evidence rather than a performance pass criterion.

The installed sqlite-vec version rejects K values above 4096.
Its tested `IN` constraint works, while the equivalent join query failed.
A proof script under `/tmp/agent-fs-search-2026-09-15/repro-vector-distinct-loop.ts` demonstrates the round-based approach.
Each nonempty round selects at least one new file, so the loop finishes within the requested file count.

### Verification

```sh
bun test packages/core/src/ops/__tests__/search-regressions.test.ts
bun run typecheck
bun run test
bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only
```

### Success Criteria

#### Automated Verification

- [x] Limit one returns an eligible file even when foreign-drive chunks rank closer.
- [x] Limit two returns two eligible files when many nearest chunks belong to one file.
- [x] Results exclude foreign-drive, deleted, and missing files.
- [x] No KNN request exceeds the installed extension's K limit.
- [x] Hybrid and Semantic retain their score formats and nearest-first candidate ordering.
- [x] Distinct-distance fixtures verify ordering. Equal-distance boundary ties do not require a stable file order.

#### Automated QA

- [x] Deterministic core tests prove scoped, distinct-file results for both operation implementations.
- [x] Existing CLI and MCP E2E checks preserve response contracts without claiming deterministic semantic coverage.
- [x] A drive with fewer eligible files terminates without repeated empty requests.
- [x] The large fixture records latency and asserts at most one round per requested file.

#### Manual Verification

- [ ] No human-only correctness check is required. Taras reviews the performance evidence before release preparation.

## Phase 4: Integration Evidence and Release Preparation

### Overview

A reviewable branch contains the tested fixes, updated usage guidance, and the required release preparation.

### Changes Required

1. Repeat the complete incident matrix through CLI, MCP, and agent-browser.
   Preserve sanitized screenshots and request evidence under `thoughts/taras/qa/evidence/`.
   Include Files root search, Full-text punctuation, all content modes, drive scope, and error states.
2. Update `skills/agent-fs/SKILL.md` with filename patterns, raw FTS quoting, scoped vectors, and provider hints.
   Keep examples accurate about spelling correction and semantic ranking.
   Update the relevant search documentation when its behavior changes.
   Document literal UI input in UI guidance rather than the CLI and MCP skill.
3. Run both E2E modes and the complete checks below.
   The MinIO test must actually traverse a continuation token.
   Resolve failures before release preparation.
4. Prepare the next available patch through [RELEASING.md](../../../RELEASING.md).
   Use `./scripts/release.sh <next-patch>` on the implementation branch.
   Complete review before merge and deployment.
   Follow [DEPLOYMENT.md](../../../DEPLOYMENT.md) for the backend and Live deployment targets.

### Verification

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
pnpm --dir live build
bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only
bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"
bun run scripts/sync-versions.ts --check
git diff --check
```

### Success Criteria

#### Automated Verification

- [x] All listed checks pass with zero unexplained skips in the new regression cases.
- [x] The skill update, E2E coverage, and patch release step are complete.
- [x] The release follows `RELEASING.md` and passes version synchronization checks.

#### Automated QA

- [x] The incident matrix passes against the local backend and UI.
- [ ] After approved deployment, the read-only live matrix confirms the original file is discoverable.
- [x] The QA report separates successful checks, limitations, and remaining relevance questions.

#### Manual Verification

- [ ] Taras reviews the final changes and evidence before merge and deployment.

## Manual E2E

These commands inspect the configured live backend without changing saved CLI configuration.
Run the read-only commands now for baseline comparison and after deployment for final acceptance.

```sh
cd /Users/taras/Documents/code/agent-fs

afs_search_check() {
  AGENT_FS_API_URL='https://agent-fs-taras.fly.dev' agent-fs \
    --org '648a5f3c-35c8-4f11-8673-b89de52cd6bd' \
    --drive '2faf73ba-4eee-4472-8b3b-359c4ed6bfbb' \
    --json "$@"
}

afs_search_check stat 'thoughts/16990304-76e4-4017-b991-f3e37b34cf73/research/2026-09-15-ai-tinkerers-demo-proposal.md'
afs_search_check glob '**/*ai-tinkerers*'
afs_search_check glob '**/*ai-tinkerers*' --path '/thoughts/16990304-76e4-4017-b991-f3e37b34cf73/research'
afs_search_check fts '"ai-tinkerers"'
afs_search_check fts 'ai tinkerers'
afs_search_check search 'ai-tinkerers' --limit 10
afs_search_check vec-search 'ai-tinkerers' --limit 10
```

The raw unquoted CLI command `fts 'ai-tinkerers'` remains query syntax.
It is not the UI acceptance test.
The UI must send the quoted literal form automatically.

Start local UI QA:

```sh
pnpm --dir live exec vite --host 127.0.0.1 --port 5178
agent-browser skills get core
agent-browser --session agent-fs-search-check open 'http://127.0.0.1:5178'
agent-browser --session agent-fs-search-check snapshot -i
```

Connect the local UI through its credential form without printing the credential.
Select the test backend, organization, and drive before each matrix run.

1. Start at drive root with no selected file.
2. Enter `ai-tinkerers` in Files and verify the target appears.
3. Open the target, change the query to a nonmatch, and verify the tree identifies the current file separately.
4. Open content search and test `ai-tinkerers` in Full-text, Hybrid, and Semantic.
5. Test `ai tinkerers`, embedded quotes, and a known absent token.
6. Exercise local controlled failures and verify that the UI does not report zero matches.
7. Change the selected drive, repeat the query, and verify that no prior-drive results remain.
8. Activate a result and close the modal with Escape.

After approved deployment, repeat these steps at the live drive root:

```sh
agent-browser --session agent-fs-search-check open 'https://live.agent-fs.dev/file/~/648a5f3c-35c8-4f11-8673-b89de52cd6bd/2faf73ba-4eee-4472-8b3b-359c4ed6bfbb/'
agent-browser --session agent-fs-search-check snapshot -i
agent-browser --session agent-fs-search-check screenshot /tmp/agent-fs-search-after.png
agent-browser --session agent-fs-search-check close
```

## Delivery notes

- Release preparation: `273f283`, version `0.13.6`, pushed through `scripts/release.sh`.
- Standards review: clear after batch metadata and blank-query fixes.
- Spec review: clear after selected-path normalization.
- Taras selected autonomous execution, so intermediate human review checkpoints did not pause implementation.
- Final human review and postdeployment acceptance remain pending.
