---
date: 2026-05-15
author: Claude (bg research)
topic: "Prior art for filesystem conflict surfacing"
tags: [research, agent-fs, conflicts, prior-art]
parent_brainstorm: thoughts/taras/brainstorms/2026-05-15-agent-fs-as-linux-filesystem.md
status: complete
---

# Prior Art for Filesystem Conflict Surfacing

## Summary

Across mature sync tools, the dominant pattern is **on-disk conflict artifacts with structured filenames** (Syncthing, Dropbox, OneDrive, Google Drive, rclone, iCloud) — programmatic event APIs are the exception, not the rule, and where they exist (Syncthing audit log, Dropbox API metadata) they look like NDJSON of small structured records. None of the POSIX/NFS-family filesystems surface conflicts at all; apps see `ESTALE` / `EIO` and that's it. Git is the de-facto standard for *human-readable* conflict content (`<<<<<<<` markers) and also exposes machine-readable conflict status via `git status --porcelain`. For agent-fs's `<mount>/.agent-fs/conflicts`, I recommend a **single append-only NDJSON file with strict fields** (`ts`, `path`, `drive`, `base_version`, `head_version`, `attempted_by`, `outcome`, optional `side_version`), rotated by size with last-N kept on disk, plus a `latest.json` snapshot for cheap reads. NDJSON beats per-file-per-conflict because (a) agents can `tail -n100` it without `readdir`, (b) `jq -c .` one-liners work cleanly, (c) it matches the existing audit-log idiom in Syncthing, and (d) it co-exists with future event broadcast (SSE/WebSocket from the daemon) sharing the same record shape.

## Prior Art per Tool

### 1. Syncthing — `.stversions/` + sync-conflict filenames + audit log

**On-disk surface (the common case):**
- Sync-conflict files: `<filename>.sync-conflict-<YYYYMMDD>-<HHMMSS>-<short-device-id>.<ext>`. The "loser" (older mtime, or higher first-63-bits of device ID on tie) is renamed; both versions then propagate as ordinary files. This means conflicts are visible to *every* peer, not just the device that detected them ([Syncthing docs — Understanding Synchronization](https://docs.syncthing.net/users/syncing.html), [Forum: conflict resolution](https://forum.syncthing.net/t/how-does-conflict-resolution-work/15113)).
- Replaced/deleted versions land under `.stversions/` inside the shared folder. Strategies: Trash Can, Simple (keep N), Staggered (geometric retention up to a maxAge), External (call a custom script). Default maxAge is configurable; `0 = forever` ([Syncthing docs — File Versioning](https://docs.syncthing.net/users/versioning.html)).

**Programmatic surface:**
- The REST `/rest/events` endpoint does **not** emit a dedicated "conflict detected" event; the community has filed this as a long-running feature request ([Forum: conflict notification via REST API](https://forum.syncthing.net/t/conflict-notification-via-rest-api/9255), [Forum: detect conflicts via API?](https://forum.syncthing.net/t/is-it-possible-to-detect-conflicts-via-api/21273)). The current workaround is to consume the `--audit` log — a JSON-per-line file containing events like `LocalChangeDetected`:
  ```json
  {"id":7,"globalID":59,"time":"2016-09-26T22:07:10.71-04:00","type":"LocalChangeDetected","data":{"action":"deleted","folder":"vitwy-zjxqt","folderID":"vitwy-zjxqt","label":"TestSync","path":"test file.rtf","type":"file"}}
  ```
  ([Syncthing docs — LocalChangeDetected](https://docs.syncthing.net/events/localchangedetected.html), [Syncthing event API manpage](https://www.mankier.com/7/syncthing-event-api)).

**Takeaway for agent-fs:** the rename-with-timestamp pattern is the most replicated convention in the industry, *but* it pollutes the file tree and forces consumers to do filename-pattern matching. The audit log shape — small JSON record per event, append-only — is the cleanest programmatic surface and what every Syncthing automation reaches for.

### 2. Dropbox — "conflicted copy" naming, no first-class API event

**On-disk:** Filename pattern is `"<basename> (<Account/Device>'s conflicted copy YYYY-MM-DD)<.ext>"`, e.g. `report (Taras's conflicted copy 2026-05-15).md`. The date is YYYY-MM-DD; some flows include account name, others device name ([Dropbox Help — conflicted copy](https://help.dropbox.com/organize/conflicted-copy), [Karam Kabbara — removing conflicted copies](https://www.karam.io/blog/removing-conflicted-copies-on-dropbox/)).

**Programmatic:** No dedicated "conflict created" event. Two indirect signals:
1. `filesUpload(mode=update, autorename=true)` returns the *renamed* filename in the response — that's how the API tells you a conflict happened ([Dropbox Community — API conflicted copy](https://www.dropboxforum.com/discussions/101000014/dropbox-api-conflicted-copy/324605)).
2. The Events v2 / team activity audit feed surfaces uploads but doesn't tag conflicts distinctly ([Dropbox — Events v2 migration guide](https://www.dropbox.com/developers/reference/events-migration-guide)).

Detection in practice is shell scripts grepping for `conflicted copy` in filenames, with false-positive caveats noted by users.

**Takeaway:** Dropbox proves that "encode the conflict in the filename" works at scale for billions of files but is *user-hostile for programs*. The lack of an event API is a known wart; we shouldn't repeat it.

### 3. rclone bisync — `--conflict-resolve` + `.conflict` suffix on disk

**Flags:**
- `--conflict-resolve {none,path1,path2,newer,older,larger,smaller}` (default `none`) — auto-pick a winner.
- `--conflict-loser {num,pathname,delete}` — what to do with the loser.
- `--conflict-suffix <string>` (default `conflict`) — suffix appended; supports a single string or comma-separated path1,path2 pair. Supports date templates like `{DateOnly}-conflict` → `myfile.txt.2006-01-02-conflict1` and `{MacFriendlyTime}` → `2006-01-02 0304PM` ([rclone docs — bisync](https://rclone.org/bisync/), [rclone docs — rclone_bisync](https://rclone.org/commands/rclone_bisync/)).
- `--suffix-keep-extension` flips `file.jpg.conflict1` → `file.conflict1.jpg`.

**On-disk:** Conflicts default to `file.ext.conflict1` (or `..conflict1` with double-dot via older flag). `--backup-dir1` / `--backup-dir2` can park previous versions in a side directory.

**Takeaway:** rclone's design is good evidence that "conflict surface" needs to be *configurable along several axes* (auto-resolve policy, suffix, location). For agent-fs v1, policy is fixed (fail loudly), but the contract should leave room for later flags like `--conflict-resolve=newer` mapping to "promote head and demote local to side-version."

### 4. NFSv3 / NFSv4 — no conflict surface at all

NFS clients don't expose conflicts; they expose *errors*:
- `ESTALE` (stale file handle): server no longer recognizes the inode the client cached. Linux maps to "Stale file handle"; AIX has known cache-purge bugs ([IBM IV30949](https://www.ibm.com/support/pages/apar/IV30949), [cr0x.net — stale file handle on NFS](https://cr0x.net/en/stale-file-handle-nfs-fix/)).
- `EIO` (I/O error): generic catch-all for "couldn't talk to server, can't complete this op."
- Close-to-open consistency (NFSv3) and OPEN/CLOSE share-state (NFSv4) ([RFC 7530](https://datatracker.ietf.org/doc/html/rfc7530)) prevent the simplest concurrent-write losses, but if two clients independently open-write-close, last-close-wins silently. Applications get no signal.

**Takeaway:** the POSIX surface is too thin to encode "we detected your write conflicted with another agent." The information has to live *outside* the syscall return — which is exactly the niche our `.agent-fs/conflicts` file fills.

### 5. Git — text markers + porcelain status

**In-tree (human):** `<<<<<<<` / `=======` / `>>>>>>>` markers (plus `|||||||` in `diff3` style) with branch/ref labels at each marker. The convention is so widely understood that linters and editors recognize it natively ([git-merge docs](https://git-scm.com/docs/git-merge), [Atlassian — merge conflicts](https://www.atlassian.com/git/tutorials/using-branches/merge-conflicts)).

**Programmatic:** `git status --porcelain=v2` emits unmerged entries with a stable, parseable shape: `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` — the three SHAs are stages 1 (base), 2 (ours), 3 (theirs). Scripts use this rather than `git ls-files --unmerged`, which is documented as "for human inspection" ([git-status docs](https://git-scm.com/docs/git-status), [git-ls-files docs](https://git-scm.com/docs/git-ls-files/2.30.1)).

**Takeaway:** two-tier surface (markers for humans, porcelain for programs) over the *same* underlying state is the gold standard. We can mirror that: text status in `<mount>/.agent-fs/status` for humans, NDJSON in `<mount>/.agent-fs/conflicts` for agents.

### 6. Google Drive Desktop & OneDrive — filename suffixes

**OneDrive:** `<basename>-<ComputerName><.ext>` whenever the sync client can't merge two updates. Forced because two same-name files can't coexist in a folder ([Microsoft Q&A — OneDrive renamed my files](https://learn.microsoft.com/en-us/answers/questions/3829153/onedrive-renamed-my-files-and-i-cant-change-them-b), [SharePoint Diary — source/dest same](https://www.sharepointdiary.com/2021/04/fix-onedrive-error-source-and-destination-file-names-are-same.html)).

**Google Drive for Desktop:** Less consistent. Reports vary: `[Conflict]` token in the name, `(1)/(2)` numeric suffix, or device-name suffix, depending on flow and product era ([Google Support — fix Drive for Desktop](https://support.google.com/drive/answer/2565956), [Addictive Tips — find conflicting files in Drive](https://www.addictivetips.com/windows-tips/how-to-find-conflicting-files-in-google-drive/)). No documented programmatic event.

**Takeaway:** Google Drive is a cautionary tale — *inconsistent* naming makes automated detection unreliable. If we ever do encode anything in filenames (e.g. promote-to-side-version), we need a single, documented, never-changed pattern.

### 7. JuiceFS / s3fs / goofys — strong consistency or nothing

- **JuiceFS:** strong consistency via Redis/metadata service; `flock`/`fcntl` work cluster-wide. No "conflict" concept because writes are serialized on the metadata server ([JuiceFS docs — vs s3fs](https://juicefs.com/docs/community/comparison/juicefs_vs_s3fs/)).
- **s3fs / goofys:** rely on S3 read-after-write consistency; no coordination layer; concurrent writes silently last-write-wins. No conflict surface ([Medium — comparative analysis](https://medium.com/@maksym.lutskyi/a-comparative-analysis-of-mountpoint-for-s3-s3fs-and-goofys-9a097a25)).

**Takeaway:** for a system in our shape (S3-backed, no central lock manager, optimistic concurrency via `If-Match`), there is no off-the-shelf precedent. We're inventing this — but we can borrow shape from Syncthing's audit log.

### 8. iCloud Drive — interactive UX, opaque API

When two devices edit and the cloud must pick, iCloud Drive either auto-resolves silently (if content is byte-identical) or pops a *conflict dialog* on the Mac asking the user to pick a version. If retained, the loser gets a numeric suffix (`Document 2`, `Document 3`). The dialog is GUI-only; there's no public API event ([Apple TN2336](https://developer.apple.com/library/archive/technotes/tn2336/_index.html), [Apple Support — document conflicts](https://support.apple.com/en-ca/guide/mac-help/mh40780/mac)).

**Takeaway:** Interactive resolution is irrelevant for agents — they have no UI. But the "if-bytes-identical-do-nothing" rule is the same content-hash dedup we already chose for version-on-close.

### 9. Notion / collaborative editors — CRDT, no conflicts to surface

Notion uses sequence CRDTs (server-mediated) so by construction there are no conflicts; concurrent edits commute. Version vectors track causality ([Real-Time Collaborative Editing 2025](https://www.happy2convert.com/blog/real-time-collaborative-editing-2025), [Iankduncan — CRDT dictionary](https://www.iankduncan.com/engineering/2025-11-27-crdt-dictionary/)). The API exposes versions/blocks, not "conflicts."

**Takeaway:** Not applicable directly — file bytes don't merge like rich-text ops. But "include a version-vector / parent-version-id on every write" is good hygiene we already plan to do (`If-Match: <head-version-id>`).

## Recommended Format for `<mount>/.agent-fs/conflicts*`

### Option A (recommended): single NDJSON file `<mount>/.agent-fs/conflicts.ndjson` + snapshot

**Why:**
- One-file means `cat`, `tail`, `jq -c .` all work without `readdir`.
- Append-only — cheap, atomic with O_APPEND on POSIX, well-understood crash semantics ([NDJSON best practices](https://ndjson.com/best-practices/)).
- Matches Syncthing's `--audit` shape, the most established prior art.
- Co-exists with a future SSE event stream — server emits the same record shape, FUSE writes it to disk, both consumers see the same schema.

**Record shape (one line per conflict):**
```json
{
  "schema": "agent-fs.conflict/v1",
  "ts": "2026-05-15T14:22:03.481Z",
  "id": "cnf_01HXYZ...",
  "drive": "main",
  "path": "/notes/plan.md",
  "outcome": "rejected",
  "base_version": "ver_01HX...",
  "head_version": "ver_01HY...",
  "attempted_by": {"api_key_id": "ak_...", "agent": "claude-code", "run_id": "..."},
  "head_author":  {"api_key_id": "ak_...", "agent": "codex"},
  "side_version": null,
  "bytes_attempted": 12483,
  "content_hash_attempted": "sha256:..."
}
```

Field rules:
- `ts` RFC3339 UTC, millisecond precision.
- `id` ULID/UUID — stable handle for future "ack this conflict" ops.
- `outcome` ∈ `rejected` (v1 default, EIO returned) | `side_versioned` (future feature flag) | `auto_resolved` (future).
- `base_version` = what we recorded at `open()`. `head_version` = what the server actually had at PUT time.
- `attempted_by` / `head_author` separated so audits can trace agent-vs-agent.
- `side_version` populated only when promote-to-side-version feature is on.
- Stable additive schema — never remove or repurpose a field; add new keys, consumers ignore unknowns.

**Concrete layout under `.agent-fs/`:**
- `<mount>/.agent-fs/conflicts.ndjson` — append-only stream.
- `<mount>/.agent-fs/conflicts.latest.json` — single JSON object with last-N (default 10) entries, rewritten on every append for cheap snapshot reads.
- `<mount>/.agent-fs/status` — last error, single line, plain text.

**Retention:** size-rotated, **last ~10 MB kept on disk** (≈ 50k entries at 200 B/line). Rotate to `conflicts.ndjson.1`, `…2`, … up to 3 files (~30 MB ceiling), then truncate-oldest. Time-based retention (last 24h, last 7d) is *not* primary because conflict frequency is unpredictable. Expose `agent-fs daemon conflicts --since=24h --drive=main` for time-windowed queries.

**Agent one-liners:**
```bash
# Most recent conflict on my path
jq -c 'select(.path=="/notes/plan.md")' .agent-fs/conflicts.ndjson | tail -1

# How many conflicts involving me in the last hour?
jq -c --arg me "ak_self" --arg since "$(date -u -d '1 hour ago' +%FT%TZ)" \
  'select(.attempted_by.api_key_id==$me and .ts > $since)' \
  .agent-fs/conflicts.ndjson | wc -l

# Did my last write get rejected?
tail -n 50 .agent-fs/conflicts.ndjson \
  | jq -c 'select(.attempted_by.api_key_id=="ak_self" and .outcome=="rejected") | .path'

# Cheap "anything wrong recently?"
cat .agent-fs/conflicts.latest.json | jq '.entries | length'
```

### Option B: one-file-per-conflict directory `<mount>/.agent-fs/conflicts/<id>.json`

**Pros:** atomic-per-conflict, trivially deletable (`rm <id>.json` to ack), filesystem-native indexing if we ever want per-path subdirs.

**Cons:** every read becomes a `readdir` round-trip (the very thing we cache aggressively); `find | xargs cat | jq -s` is awkward; `tail -f` for live consumption needs `inotifywait` on the directory; collisions on `<id>` if not ULID-strict; cleanup needs a GC loop.

**When this wins:** if "ack/dismiss a conflict" becomes a first-class op early — then per-file is more ergonomic than rewriting an NDJSON line. Reasonable later evolution.

### Option C: plain text log `<mount>/.agent-fs/conflicts.log`

Like Syncthing's pre-audit log: one human-readable line per conflict (`2026-05-15T14:22:03Z REJECT /notes/plan.md base=ver_X head=ver_Y by=claude-code(ak_...)`). Easiest to read with eyes. Hostile to programs — every consumer has to write a parser.

**When this wins:** if agents are not the primary consumer (humans tailing it). For our agent-first audience: no.

### Final recommendation

Ship Option A in v1:
- `<mount>/.agent-fs/conflicts.ndjson` (append-only, size-rotated).
- `<mount>/.agent-fs/conflicts.latest.json` (last-10 snapshot, cheap read).
- `<mount>/.agent-fs/status` (last error, single line, plain text — see brainstorm).
- Schema versioned via a `schema: "agent-fs.conflict/v1"` key on every record so future migrations are safe.
- Server-side: same records also flow on a future SSE channel. No re-design needed.

Reserve a v1.1 evolution to *also* drop `<id>.json` files into `<mount>/.agent-fs/conflicts/` once we have a real "ack/dismiss" op — Option B then becomes a write-through view on top of the NDJSON, not the source of truth.

## Sources

- [Syncthing — Understanding Synchronization](https://docs.syncthing.net/users/syncing.html)
- [Syncthing — File Versioning](https://docs.syncthing.net/users/versioning.html)
- [Syncthing — LocalChangeDetected event](https://docs.syncthing.net/events/localchangedetected.html)
- [Syncthing — Event API](https://docs.syncthing.net/dev/events.html)
- [Syncthing Forum — conflict notification via REST API](https://forum.syncthing.net/t/conflict-notification-via-rest-api/9255)
- [Syncthing Forum — detect conflicts via API?](https://forum.syncthing.net/t/is-it-possible-to-detect-conflicts-via-api/21273)
- [Syncthing Forum — how does conflict resolution work?](https://forum.syncthing.net/t/how-does-conflict-resolution-work/15113)
- [Dropbox Help — What's a conflicted copy?](https://help.dropbox.com/organize/conflicted-copy)
- [Dropbox Help — Case conflict](https://help.dropbox.com/organize/case-conflict)
- [Dropbox Developers — Events v2 migration guide](https://www.dropbox.com/developers/reference/events-migration-guide)
- [Dropbox Community — API conflicted copy thread](https://www.dropboxforum.com/discussions/101000014/dropbox-api-conflicted-copy/324605)
- [Karam Kabbara — Removing conflicted copies on Dropbox](https://www.karam.io/blog/removing-conflicted-copies-on-dropbox/)
- [rclone docs — bisync](https://rclone.org/bisync/)
- [rclone docs — rclone_bisync command](https://rclone.org/commands/rclone_bisync/)
- [rclone GitHub — bisync auto-resolve conflicts issue](https://github.com/rclone/rclone/issues/7471)
- [RFC 7530 — NFS Version 4 Protocol](https://datatracker.ietf.org/doc/html/rfc7530)
- [RFC 5661 — NFSv4.1](https://www.rfc-editor.org/rfc/rfc5661.html)
- [IBM IV30949 — NFSv4 ESTALE cache bug](https://www.ibm.com/support/pages/apar/IV30949)
- [cr0x.net — Stale file handle on NFS](https://cr0x.net/en/stale-file-handle-nfs-fix/)
- [Linux Kernel — NFSv4 client identifier](https://docs.kernel.org/filesystems/nfs/client-identifier.html)
- [git-merge documentation](https://git-scm.com/docs/git-merge)
- [git-status documentation](https://git-scm.com/docs/git-status)
- [git-ls-files documentation](https://git-scm.com/docs/git-ls-files/2.30.1)
- [Atlassian — How to resolve a merge conflict](https://www.atlassian.com/git/tutorials/using-branches/merge-conflicts)
- [Pro Git — Advanced Merging](https://git-scm.com/book/en/v2/Git-Tools-Advanced-Merging)
- [Google Support — Fix problems in Drive for desktop](https://support.google.com/drive/answer/2565956)
- [AddictiveTips — How to find conflicting files in Google Drive](https://www.addictivetips.com/windows-tips/how-to-find-conflicting-files-in-google-drive/)
- [Microsoft Q&A — OneDrive renamed my files](https://learn.microsoft.com/en-us/answers/questions/3829153/onedrive-renamed-my-files-and-i-cant-change-them-b)
- [SharePoint Diary — Source/dest names are the same](https://www.sharepointdiary.com/2021/04/fix-onedrive-error-source-and-destination-file-names-are-same.html)
- [JuiceFS docs — vs S3FS comparison](https://juicefs.com/docs/community/comparison/juicefs_vs_s3fs/)
- [Medium — Comparative analysis of Mountpoint for S3, S3FS, Goofys](https://medium.com/@maksym.lutskyi/a-comparative-analysis-of-mountpoint-for-s3-s3fs-and-goofys-9a097a25)
- [Apple TN2336 — Handling version conflicts in iCloud](https://developer.apple.com/library/archive/technotes/tn2336/_index.html)
- [Apple Support — Document versions conflict in iCloud Drive](https://support.apple.com/en-ca/guide/mac-help/mh40780/mac)
- [Real-Time Collaborative Document Editing 2025](https://www.happy2convert.com/blog/real-time-collaborative-editing-2025)
- [Iankduncan — CRDT dictionary](https://www.iankduncan.com/engineering/2025-11-27-crdt-dictionary/)
- [NDJSON.com — JSONL for log processing](https://ndjson.com/use-cases/log-processing/)
- [NDJSON.com — Production best practices](https://ndjson.com/best-practices/)
- [AWS CloudWatch — NDJSON endpoint](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_HTTP_Endpoints_NDJSON.html)
