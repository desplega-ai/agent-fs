---
date: 2026-10-19T14:10:17Z
topic: "Fuzzy file-name search op `find`"
status: done
---

# Fuzzy file-name search op `find`

## Goal

`agent-fs find "zephyr deck"` finds `/research/decks/Zephyr Pitch Deck.pdf`. A new core op `find` reads file paths from the SQLite `files` table (no S3 listing), matches every query word against the path (case and accent insensitive, any order, fzf-style subsequence fallback), and returns the top matches ranked. The live/ Files tab uses `find` instead of the case-sensitive `**/*<query>*` glob. CLI and MCP get it from the op registry.

Root cause of the bug: the Files tab sends `**/*<query>*` to `glob`, which compiles to a case-sensitive regex, and lists every S3 object in the drive (10,843 on the prod drive) per search.

## Decisions

- Scope exception: one-shot covers core (registry-driven, so CLI/MCP/OpenAPI are a few lines) and live/. Taras chose "One-shot it now" after the option preview listed this full scope (asked).
- New op `find`, not a flag on `glob`: glob keeps strict glob semantics for agents (asked).
- Source of truth is the `files` table (`is_deleted = 0`), the same table `search` and `recent` use. Objects written straight to S3 without a DB row are not found (assumed).
- Hand-written scorer, no new dependency: about 80 lines, unit tested (assumed).
- Query words split on any run of non-letters/non-digits (covers whitespace and `/ _ - .`). Every word must match the path (assumed).
- Per word: contiguous hit beats subsequence hit. A hit in the file name scores double a hit in a folder name. Word-start and consecutive-char bonuses (asked).
- Subsequence fallback stays inside one path segment and must start at a word start (assumed).
- Skipped-letter (subsequence) matches show only when no file has every word as typed. Without this tier, "report" also listed `retry-poller.ts` and inflated `total` (Spec review measured 68 of 153 such hits on real paths) (assumed, review).
- Sort: score desc, then shorter path, then newer `modifiedAt`, then path (asked).
- Default limit 50, max 500. Result carries `total` so the UI can say "showing N of M" (assumed).
- Optional `path` prefix filter, same as `glob --path`. Words match only the part below the prefix, so `find deck --path /decks` does not hit every file through the folder name (assumed).
- Cheap prefilter: each word must be a subsequence of the folded path before full scoring. No per-request segment memo: it saved only about 2 ms. Bench: 9 to 23 ms over 11k synthetic paths (measured).
- Folding strips nonspacing marks only (`\p{Mn}`) and maps Greek final ς to σ (assumed, review).
- live/ falls back to the old case-sensitive `**/*q*` glob on a server that answers "Unknown operation: find", remembered per endpoint, same pattern as `live/src/lib/reveal.ts` (assumed, review).
- Not added to the e2e hostile-path matrix: `find` reads only the `files` table scoped by drive id and never builds a storage key (assumed).
- live/ cannot import core (separate pnpm app), so the 429 fallback over loaded folders becomes a simple case/accent-insensitive "every word is in the name" filter instead of a copy of the scorer (assumed).
- Version bump via `bun run scripts/sync-versions.ts 0.18.5`, not `release.sh`, because `release.sh` pushes (assumed, same as the presence one-shot).

## Todo

- [x] Core: `packages/core/src/ops/find.ts` (scorer + op), types, registry entry, RBAC `viewer`
- [x] Core tests: scorer unit tests, op tests (case, accents, word order, subsequence, folder vs name, prefix, deleted files, limit), registry count, path-normalization coverage
- [x] CLI: `find <query> [--path] [--limit]` command, read-only op list, formatter
- [x] live/: `use-find-search` hook replaces `use-glob-search` in SearchBar + FileSearchPanel; local fallback filter becomes case/accent insensitive; `FindResult` type; tests
- [x] Docs: `skills/agent-fs/SKILL.md`, `docs/mcp-setup.md`, `docs/api-reference.md`
- [x] E2E: `find` in `scripts/e2e.ts` (main flow + MCP tools/call + backend tier)
- [x] Version bump 0.18.5 via `sync-versions.ts`
- [x] Code review, commit

## Verification

- `bun run typecheck`
- `bun test packages/core/src/ops/__tests__/find.test.ts packages/core/src/ops/__tests__/registry.test.ts packages/core/src/ops/__tests__/path-normalization.test.ts`
- `bun run test`
- `cd live && pnpm exec tsc -b && bun test src/lib/__tests__/local-file-filter.test.ts src/lib/__tests__/file-search.test.ts`
- `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only`
- `bun run scripts/sync-versions.ts --check`

## Results

- `bun run typecheck`: pass.
- `bun run test`: 1767 pass, 61 skip, 0 fail.
- `cd live && pnpm exec tsc -b`: pass. Live unit tests (local-file-filter, file-search): 10 pass.
- `scripts/e2e.ts --local-only`: 191/191 pass (20 skipped), including the 3 new `find` tests.
- `sync-versions.ts --check`: every target at 0.18.5.
- Manual QA: isolated local-FS daemon plus `vite` and `agent-browser`. Files tab "zephyr deck" lists `Zephyr Pitch Deck.md`. "report" lists 3 files ranked. "zzqxj" shows the empty state. CLI `find` checks for case, accents, word order, subsequence, `--limit`, and `--path` all pass. Old `glob '**/*zephyr*'` returns no matches.
- After review fixes: `bun run test` 1774 pass, 61 skip, 0 fail. Live unit tests 20 pass (new `find-search.test.ts`). E2E local-only 191/191 again.

## Review

Two Opus reviewers (Standards, Spec) on the staged diff.

Fixed:
- Important (Spec): live Files tab broke on a server older than 0.18.5. Now falls back to glob per endpoint.
- Minor (Spec): subsequence junk. Now a fallback tier.
- Minor (Standards): Greek final sigma, `\p{M}` too broad, dead `aligned` code, segment memo and exported internals, optional `total` in the live store.

Noted, not fixed (Minor):
- Letters with no Unicode decomposition do not fold: "lodz" misses `Łódź`, "orsted" misses `Ørsted`, "strasse" misses `Straße`. Spanish and Catalan accents work.
- Word starts and subsequence bonuses read UTF-16 code units, so a letter after an astral character (e.g. `𝒜`) counts as a word start. Rare in file names.
- No automated test drives the Retry button or the panel's 429 fallback wiring. The fallback matcher and `fetchFind` are unit tested.
- The "Showing the first N" panel copy was checked by reading the code only. Manual QA had fewer than 50 matches.
