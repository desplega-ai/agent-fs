# Remaining backend performance findings

This slice preserves operation results, tenant boundaries, legacy files, and deletion rules. It uses local fixtures only.

| Finding | Disposition |
| --- | --- |
| Recent activity scans and sorts version history. | Added `(drive_id, created_at DESC)`. SQLite uses the index for drive and time filters without a temporary sort. |
| Drive summaries examine tombstones and directory markers before `LIMIT 5`. | Added a partial covering index for live files without trailing slashes. A fixture with 100,000 excluded rows still uses that index. |
| Tree scans all metadata before applying depth. | Tree now filters storage results first. It reads exact metadata paths in batches of 400. |
| Tree repeatedly searches sibling arrays. | The assigned base already uses directory maps. The existing 20,000-sibling tests pass. |
| Local listings scan the complete storage root and legacy descendants. | Replaced both scans with one scoped walk. It stops at object limits and uses one visible descendant to prove each prefix. |
| Tree lists S3 descendants beyond the requested depth. | Retained S3 traversal. Exact pruning needs marker checks per boundary folder and can amplify requests on wide trees. |
| Signed reads can repeat HEAD across stat and URL requests. | Retained the existence check. Each signed-url operation uses one HEAD. Removing it would mint URLs for missing objects with stale metadata. |
| S3 connections may contend during request bursts. | Retained connection settings. No measurement proves pool saturation. A local inspection confirms connection reuse and the SDK limit of 50 sockets per agent. |

An optional `maxDepth` hint lets local storage prune directories exactly. Tree still filters results when another adapter ignores the hint.
S3 keeps its existing pagination and marker behavior. No timeout, pool, cache, release metadata, or production setting changed.

Local listing retains object priority when `maxKeys` truncates objects and prefixes. It keeps partial prefixes, custom delimiters, lexical ordering, and stored legacy names.
It ignores symlinks, empty folders, sidecars, resumable staging, and SDK-shaped temporary files without valid sidecars.
A folder with no visible file can still require a complete scan to prove that it is empty.

Both indexes apply to existing databases through additive migrations. Their first creation scans existing rows once and adds index maintenance to later writes.

Verification passed:

- `bun install --frozen-lockfile`
- `bun run typecheck`
- The focused regression command below: 335 tests passed across 33 files.
- `git diff --check`

```bash
bun test packages/core/src/storage/__tests__/ \
  packages/core/src/ops/__tests__/tree-depth.test.ts \
  packages/core/src/ops/__tests__/tree-siblings.test.ts \
  packages/core/src/ops/__tests__/recent-index.test.ts \
  packages/core/src/ops/__tests__/signed-url.test.ts \
  packages/core/src/ops/__tests__/ls-stale-folders.test.ts \
  packages/core/src/s3/__tests__/client.test.ts \
  packages/core/src/db/__tests__/ \
  packages/server/src/__tests__/drive-file-summary.test.ts
```

The local delimiter fixture reads two directories while excluding 40 deeper branches and another tenant.
The capped fixture reads one directory and one sidecar. The depth-one fixture reads one directory despite 80 nested branches.
The migration test reopens an existing database, applies migrations twice, and checks unchanged rows.
The recent fixture preserves results across 40,003 versions, including equal timestamps and another drive.

The parent owns these integration steps:

1. Update `skills/agent-fs/SKILL.md` for changed command behavior.
2. Run both combined E2E modes against isolated backends:

   ```bash
   bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only
   bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"
   ```

3. Apply the version change through `./scripts/release.sh 0.18.31` under [RELEASING.md](../../../RELEASING.md).

This slice did not run E2E, push, release, deploy, or contact production.
