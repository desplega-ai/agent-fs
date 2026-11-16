---
date: 2026-11-16
researcher: Codex
git_commit: 4c630a31f610119554ee79fee927f21ca2f13991
branch: feat/live-document-updates
repository: agent-fs
topic: Slow page loading on the swarm drive
tags: [research, performance, live, sidebar, ls]
status: complete
autonomy: critical
last_updated: 2026-11-16
---

# UI page loading on the swarm drive

## Research question

Taras reports roughly 60 seconds to load any page. Does sidebar listing work cause this delay on the large swarm drive?

## Summary

The sidebar generates unnecessary requests, and the backend makes each listing more expensive than necessary. Both problems are confirmed.

These measurements did not reproduce the reported 60 seconds. A document rendered while sidebar listings remained active. Sidebar completion does not directly gate document display.

## Live measurements

I used the deployed UI and Taras's configured API credential in a temporary incognito browser. The backend reported version 0.18.29.

The target was the swarm organization and its default drive.

- CLI root listing returned 127 entries in 0.982 seconds, including process startup. It contained three files and 124 directories.
- Navigation from another organization to the swarm root completed its root listing at 3.778 seconds. This sample includes requests during scope switching.
- The GitHub star prompt made nine separate listings, including its own root listing. Its traversal ended at 4.448 seconds.
- Opening a document subsequently rendered its text at 1.910 seconds. Its `reveal` request completed at 0.838 seconds.
- Reloading that document with 20 deliberately restored folders started 20 sidebar listings between 0.835 and 0.840 seconds.
- The document rendered at 1.105 seconds. The last of those 20 listings completed at 1.735 seconds.
- The star prompt continued its separate traversal until 2.881 seconds.
- The browser reported no main-thread tasks longer than 50 milliseconds during the measured intervals.

These samples have different cache and connection states. They are not an optimization benchmark or a controlled comparison.

For the reload, fetch instrumentation started at 0.387 seconds. Initial requests before that point are absent from the fetch trace.

The trace records time until response headers, rather than complete response consumption. The document marker records its first observed DOM content.

Evidence: [request timings](./2026-11-16-live-page-load-performance.json). The trace excludes credentials, response bodies, and signed URL query strings. Published paths and identifiers use example labels.

## Confirmed source findings

### Restored folders create a burst of requests

[FileTree.tsx:62](https://github.com/desplega-ai/agent-fs/blob/4c630a31f610119554ee79fee927f21ca2f13991/live/src/components/file-tree/FileTree.tsx#L62) creates one query per reachable expanded folder.

The tree virtualizes DOM rows, but it does not restrict requests to rows inside the viewport. It discovers deeper expanded folders after parent listings arrive.

[tree-expansion.ts:4](https://github.com/desplega-ai/agent-fs/blob/4c630a31f610119554ee79fee927f21ca2f13991/live/src/stores/tree-expansion.ts#L4) permits 1,000 persisted expanded paths.

The live reload confirmed 20 simultaneous listing requests. I did not simulate 1,000 requests against production.

### Root listings load metadata for the entire drive

[ls.ts:20](https://github.com/desplega-ai/agent-fs/blob/4c630a31f610119554ee79fee927f21ca2f13991/packages/core/src/ops/ls.ts#L20) retrieves metadata for every live descendant with `path LIKE prefix + '%'`.

The root query therefore materializes every live file row. The response only needs metadata for immediate files returned by S3.

Local query-plan checks showed that SQLite uses the drive portion of `idx_files_drive_path`, without a path range for this query.

The synchronous query blocks the server request thread. Network waits can overlap, but synchronous database work cannot.

The delegated synthetic check used 300,000 files and stub storage. Twenty small-folder listings delayed a zero-delay timer by 392 milliseconds.

That result demonstrates contention. It does not establish production database size or explain a 60-second wait by itself.

### The GitHub star prompt performs an independent traversal

[StarNudge.tsx:28](https://github.com/desplega-ai/agent-fs/blob/4c630a31f610119554ee79fee927f21ca2f13991/live/src/components/StarNudge.tsx#L28) uses a separate query and bypasses the sidebar listing cache.

[star-nudge.ts:7](https://github.com/desplega-ai/agent-fs/blob/4c630a31f610119554ee79fee927f21ca2f13991/live/src/lib/star-nudge.ts#L7) traverses directories serially until it finds five files.

The swarm root has only three immediate files. The trace confirmed further traversal through unrelated directories on page load.

This is unnecessary initial-load work. It was not a minute-long operation in these samples.

### Revealing a file repeats ancestor listings

[reveal.ts:33](https://github.com/desplega-ai/agent-fs/blob/4c630a31f610119554ee79fee927f21ca2f13991/packages/core/src/ops/reveal.ts#L33) runs stat and every ancestor listing, including the root.

[FileTree.tsx:82](https://github.com/desplega-ai/agent-fs/blob/4c630a31f610119554ee79fee927f21ca2f13991/live/src/components/file-tree/FileTree.tsx#L82) requests reveal after its root listing is available.

The backend repeats listing work that the browser may already have. The reload captured reveal alongside 20 restored listings.

### Storage latency remains a possible contributor

[client.ts:145](https://github.com/desplega-ai/agent-fs/blob/4c630a31f610119554ee79fee927f21ca2f13991/packages/core/src/s3/client.ts#L145) drains S3 continuation pages sequentially before returning a listing.

The client configures a 30-second socket timeout and up to three attempts. Storage stalls could extend delays into tens of seconds.

No trace from this investigation proves that storage retries caused Taras's delay.

### UUID labels create failed background requests

[uuid-resolver.ts:52](https://github.com/desplega-ai/agent-fs/blob/4c630a31f610119554ee79fee927f21ca2f13991/live/src/lib/uuid-resolver.ts#L52) requests the `read` operation for `meta.json` and `.name`.

The reload captured 16 HTTP 400 responses from these requests. The registered content operation is `cat`.

This is additional request noise and a separate correctness issue. Its measured latency does not explain the reported delay.

## Recommended fix order

1. Fetch database metadata only for the immediate files returned by storage. Preserve support for objects without database metadata.
2. Remove recursive listing from the star prompt. Derive eligibility from existing data or a bounded server query.
3. Limit background restoration of expanded folders. Prioritize the selected file and visible folders.
4. Avoid repeating fresh ancestor listings during reveal where correctness permits.
5. Correct UUID label requests and verify their error handling.

Do not add a general cache or increase timeouts before these unnecessary operations are addressed.

## Remaining uncertainty

Taras's browser may contain far more restored folders than the test browser. Its saved state was not available here.

A trace during an actual minute-long load must separate API waiting, storage waiting, retries, and browser work.

Production database size, S3 page counts, and server load were not measured. Local source and deployed code may differ.

## Implementation follow-through

The investigation above preceded implementation. The following checks apply to the resulting performance changes:

1. Update `skills/agent-fs/SKILL.md` when behavior changes.
2. Add regression coverage. Add corresponding `scripts/e2e.ts` coverage for any new operation.
3. Run `bun run typecheck`, relevant storage tests, and the default Docker-backed E2E command from `AGENTS.md`.
4. Repeat the browser measurement with realistic restored expansion and a real backend.
5. Follow [RELEASING.md](https://github.com/desplega-ai/agent-fs/blob/4c630a31f610119554ee79fee927f21ca2f13991/RELEASING.md). Use the release script for an approved release, without manual version edits.

## Cleanup

I removed temporary browser credentials and test state, then closed both test tabs. I created no build outputs or temporary files.

Filesystem availability changed from 11 GiB to 10 GiB during the session. No measurable disk space was reclaimed.

## Implementation update

The implementation addresses the measured request fan-out and the metadata scan.

- `ls` retrieves metadata for immediate files with indexed queries in batches of 500 paths.
- Unknown-folder validation permits eight concurrent storage requests.
- The sidebar loads restored folders on viewport or focus demand. Root and child requests share four slots.
- A file link uses `reveal` immediately and reuses fresh ancestor listings. It no longer mounts a temporary root folder view.
- The star prompt uses a capped summary from the existing drive response. It issues no file requests.
- UUID labels use `cat`. Their caches include endpoint, credential, and resolved user identity.
- UUID metadata reads permit 1,000 lines. Truncated metadata uses `.name` or remains retryable without a permanent miss.

Review regressions cover management routes, cancellation during selection, active folder views, stale listings, and older servers.

Two browser controls failed before the file-page fix. They detected the extra root listing and the temporary recent-activity request.

A manual browser check used the real server routes, SQLite, and local storage with 1,001 files and 1,000 saved expansions.
The selected document rendered, and the sidebar revealed its row.
Scrolling loaded nearby folders. Selecting another file and reloading preserved working navigation.
This local check does not measure production latency.

The separate remaining-findings report records tree, recent-activity, local-storage, and storage-request decisions.

## Final integration verification

- `bun run typecheck`: passed.
- `bun run test`: 2,674 passed, 64 skipped, and no failures.
- `cd live && bun test --isolate src/`: 622 passed.
- `cd live && pnpm build`: passed.
- `cd live && pnpm test:e2e --workers=4`: 166 passed.
- `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only`: 235 passed, 20 skipped.
- `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"`: 258 passed, 12 skipped.

The MinIO run used the cached Coollabs build of `RELEASE.2025-10-15T17-29-55Z` because registry pulls were unavailable.
Its image digest was `sha256:69b55a1c1c5dc285ce04db96689f5b2102317fc77a50680a1874ca6efd1c87f9`.
FUSE and optional model runs were skipped. These changes were not deployed to production.

An older migration fixture omitted existing `is_deleted` and `created_at` columns. Updating that fixture allowed the complete repository suite to pass.
Browser fixtures now provide the drive summary. Editor tests use the native document-navigation shortcuts on macOS.

The complete disposition of secondary findings appears in [the remaining findings report](./2026-11-16-remaining-performance-findings.md).
