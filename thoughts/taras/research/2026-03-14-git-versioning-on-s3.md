---
date: 2026-03-14
author: Claude (research)
topic: "Git-like Versioning on S3: Architecture Decision"
tags: [research, git, s3, versioning, agent-fs]
status: complete
---

# Git-like Versioning on S3: Architecture Decision

## Recommendation: Build git semantics on S3 versioning + SQLite (Path A)

NOT actual git. Build the same user-facing features using S3's native capabilities + a metadata layer.

## Why Path A wins

1. **No distributed sync problem.** S3 = single source of truth for content. SQLite = single source of truth for metadata.
2. **Semantic diffs for free.** The `edit(old_string, new_string)` operation captures intent git can never capture.
3. **Per-file versioning.** S3 versions each object independently. No multi-file "commits" needed for a filesystem product.
4. **Negligible cost for text.** 10KB file × 100 versions = 1MB. At $0.023/GB/mo, that's ~$0.000023/mo.
5. **No git complexity.** No pack files, GC, merge conflicts, branch refs, rebasing.
6. **Works with any S3-compatible store.** R2, MinIO, Tigris, B2 all support versioning.

## Architecture

```
Agent → REST API → S3 (content, versioning enabled)
                 → SQLite (metadata per version, FTS5, embeddings, RBAC)
```

## S3 Versioning: How it works

- Every PUT/POST/DELETE creates a new version with unique `VersionId`
- Each version = full object (not delta). 10 versions of 1MB file = 10MB storage.
- `ListObjectVersions` returns: VersionId, LastModified, ETag, Size, Owner, IsLatest
- User metadata (`x-amz-meta-*`): 2KB limit, set at upload, immutable after. Not returned in bulk listing.
- Deletes create "delete markers" (soft delete). All previous versions remain.
- Lifecycle policies auto-expire old versions (keep last N, expire after M days).

## Implementation Plan

### SQLite schema for version metadata

```sql
CREATE TABLE file_versions (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  s3_version_id TEXT NOT NULL,
  author TEXT NOT NULL,
  operation TEXT NOT NULL,       -- 'write' | 'edit' | 'append' | 'delete' | 'revert'
  message TEXT,
  diff_summary TEXT,             -- JSON: {old_string, new_string} for edits
  size INTEGER,
  etag TEXT,
  created_at TIMESTAMP NOT NULL,
  UNIQUE(path, s3_version_id)
);
```

### Operations

- **`log(path)`**: `ListObjectVersions` + SQLite query joined on version_id
- **`diff(path, v1, v2)`**: Two `GetObject` calls + `jsdiff.structuredPatch()`. For `edit` ops, return stored diff_summary directly.
- **`revert(path, version)`**: `CopyObject` from old version (creates new version). Record as `operation='revert'`.
- **`edit(path, old, new)`**: Fetch → verify old_string exists → replace → PutObject → record semantic diff in SQLite
- **`blame(path)`**: Walk version chain, compute line-level attribution. Cache aggressively. Consider v1.5.

### Key insight: edit() captures intent

```
v5  agent-writer  2m ago   edit: "draft figures" → "final figures"
v4  agent-writer  1h ago   edit: "TODO: add revenue" → "$2.3M revenue in Q1"
v3  taras         3h ago   write: initial version (4.2KB)
```

This is richer than anything git provides.

## Why NOT actual git (Path B)

### `git-remote-s3` (AWS Labs)
- Proof-of-concept in Rust. No pack files, no GC, no parallelism, no compression.
- Granular access control lost (bucket write = all branches writable).

### `isomorphic-git` with S3 backend
- Theoretically possible via BYOFS plugin. Nobody has built it.
- Performance terrible (hundreds of small file reads per git operation).

### Local git + S3 sync (hybrid)
- Bidirectional sync = distributed systems problem.
- Conflict resolution for agents is unsolved.
- Complexity doesn't pay off when S3 versioning + SQLite gives you the same UX.

## What Turso AgentFS does (for comparison)

- Everything in single SQLite file (content + metadata)
- Append-only `tool_calls` audit log (not git-like versioning)
- WAL snapshots for time-travel (whole DB, not per-file)
- Designed for single-agent isolation, not multi-agent collaboration
- No diff, no blame, no semantic diffs

## Deferred to v2

- **Branching** (agent-per-branch isolation) — compelling but massive complexity
- **Multi-file atomic commits** — not needed for filesystem product
- **Merge/conflict resolution** — use optimistic concurrency (ETags) instead
