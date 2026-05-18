---
date: 2026-05-15T00:00:00Z
author: Taras
topic: "agent-fs as a mountable Linux filesystem"
tags: [brainstorm, agent-fs, fuse, filesystem, mount, linux, macos]
status: in-progress
exploration_type: idea
last_updated: 2026-05-15
last_updated_by: Taras
---

# agent-fs as a mountable Linux filesystem — Brainstorm

## Context

Today agent-fs exposes files via:
- CLI (`agent-fs` binary)
- MCP server (for agents)
- HTTP API (via the daemon/server)
- A web UI (`live/`)

The current value prop is "shared file system for agents" — but the access primitives are all *agent-native* (MCP tools, CLI commands, HTTP). Humans and unix tools still see it as a remote API, not a directory.

**The idea**: expose agent-fs as a real mount point (e.g. `/Volumes/agent-fs` on macOS, `~/mnt/agent-fs` on Linux) so that:

- `ls`, `cat`, `grep`, `vim`, `rsync`, `git`, etc. just work
- Scripts can `cp report.md /Volumes/agent-fs/shared/` and it lands in the remote drive
- Agents writing via MCP and humans writing via the filesystem see the same files in real time
- Existing UNIX-shaped tooling (cron, build pipelines, editors) bridges into the agent world without a custom integration

The natural implementation surface is **FUSE** (macOS via macFUSE, Linux via libfuse) — but there are alternatives (NFS, WebDAV, 9P, SMB) worth weighing.

Open questions at the outset:
- Is this a *core product surface* or a *power-user companion*?
- What's the consistency model — is it a cache, a passthrough, or eventually-consistent?
- How does it map agent-fs concepts (drives, members, versions, comments, semantic search) onto POSIX (path, mode, mtime)?
- What does the metadata that has no POSIX equivalent (comments, semantic search, versions) get exposed as — xattrs, dotfiles, sidecar paths?

## Exploration

### Q: Who is the primary user of the mounted-filesystem surface?

**Agents running shell commands.** Claude/Codex-style agents that already invoke Bash. Mounting lets them use `cat`/`grep`/`sed`/`rg` against agent-fs content without learning MCP.

**Insights:**
- Reframes the project: the mount isn't a "remote drive for humans," it's a *native shell adapter for agents*. The competitor isn't Dropbox — it's the MCP tool surface itself.
- Strong implication: agents already produce shell commands with abandon, so latency, idempotency, and partial-read semantics matter a lot (an agent will happily run `cat huge.bin` or `find /mount -name '*.md'` and chew through the API).
- Suggests the mount must be *cheap to use accidentally*. Operations an agent might try blindly (`ls -la`, `stat`, recursive grep) need to not blow up cost, rate limits, or the local cache.
- Pushes away from "perfect POSIX" toward "POSIX shaped enough that the common shell verbs work." Things like fcntl locks, hardlinks, sparse files probably aren't required.
- The MCP surface doesn't go away — it's the *high-leverage* path (semantic search, comments, versions). The mount is for the *long tail* of shell ergonomics.

### Q: What consistency model should the mount have under concurrent writers?

**Open-to-close consistency (NFSv3-style).** A reader sees a snapshot on `open()`; a writer's changes become visible *after* `close()`. Mid-stream changes aren't observed.

**Insights:**
- Big architectural simplifier: it legitimizes a per-open download-to-temp / upload-on-close strategy. Each open() pulls the current object version into a local working file; close() pushes it back as a new version.
- Matches S3 semantics very well — S3 is object-PUT-as-an-atomic-unit, not byte-range writable in place. Open-to-close *is* the natural seam.
- Aligns with how agents actually use files: open a file, read or write it, close it. Long-lived `tail -f`-style workloads aren't a goal.
- Implies a version is produced on every close that mutated the file. That's a feature given agent-fs already has versioning — but it could spam history. May need a "no-op suppression" (don't write a new version if content hash unchanged).
- Concurrent writers: last-close-wins by default; agent-fs versioning preserves the loser's work. A future conflict-detection layer could surface this via xattrs / sidecar comments.
- Directory listings probably want a short TTL (say 5–30s) — `ls` shouldn't pay a round-trip per `stat` if an agent runs it 10× in a row.
- Locking (`fcntl`, `flock`) won't be honored across the network; we should document this rather than fake it.

### Q: Which mount technology should we target first?

**FUSE (macFUSE / libfuse).** Most flexible, best fit for sandboxed dev containers where agents run; libfuse on Linux is first-class.

**Insights:**
- Anchors the impl in userspace. We can build it in TypeScript (via `node-fuse-bindings`/`@gcas/fuse`) or, more robustly, a small native helper. Given Bun-only runtime, the binding choice matters — may need a thin Rust/Go helper if Bun's N-API support is weak for FUSE callbacks.
- macFUSE friction is real and worth budgeting for:
  - Kernel extension requires user approval in System Settings → Privacy & Security.
  - On Apple Silicon, ships as a System Extension; still needs a reboot the first time.
  - For non-interactive dev containers / CI, this is a non-starter — so on macOS host, FUSE is fine; *inside* a Linux container, plain libfuse works.
  - There's a "macfuse"-free alternative emerging (`fuse-t` — NFS-shim) worth keeping on the radar as a fallback.
- Linux: libfuse is well-supported and works in most non-rootless containers (`--cap-add SYS_ADMIN --device /dev/fuse`). Rootless Docker / many CI runners *won't* allow it — a real constraint given the primary user is agents in sandboxes.
- Implication: ship a fallback that doesn't require FUSE for environments that can't load it. Candidates: an LD_PRELOAD shim, a `agent-fs shell` virtualized chroot, or just falling back to the existing CLI/MCP.
- The mount lifecycle should be managed by the existing daemon (`agent-fs daemon`) — start/stop, single mount per drive, healthcheck/auto-remount.
- Concretely: `agent-fs mount <drive> [<path>]` and `agent-fs umount <path>` — and on macOS, integrate with `diskutil` so it shows up cleanly in Finder.

### Q: How should non-POSIX metadata (versions, comments, search, members) surface inside the mount?

**Extended attributes (xattrs) + keep the CLI as the rich-detail surface.** Mount stays POSIX-clean; agents that want richer operations fall back to `agent-fs ...`.

**Insights:**
- Sensible separation of concerns: the *mount* answers "what does this file look like as a POSIX file?", and the *CLI/MCP* answers "what does agent-fs know about this file?" One surface per question.
- xattrs we'd likely expose initially (cheap, useful):
  - `user.agent-fs.version` — current version id
  - `user.agent-fs.versions` — comma-list or count of historical versions
  - `user.agent-fs.comments` — count or last-comment id
  - `user.agent-fs.drive`, `user.agent-fs.path` — drive + canonical agent-fs path
  - `user.agent-fs.content-hash`, `user.agent-fs.indexed-at` — useful for change-detection
  - Maybe `user.agent-fs.uri` — a canonical `agent-fs://drive/path` URI agents can paste into `agent-fs cat <uri>` etc.
- Cross-platform xattr gotchas:
  - macOS uses the `user.*` namespace via FUSE but Finder is opinionated about `com.apple.*` keys; we'd live under `user.agent-fs.*`.
  - Linux requires `user_xattr` mount option on some FSs but FUSE handles it natively.
  - Some agent shell environments may not have `xattr` / `getfattr` installed — we should bundle a `agent-fs xattr <path>` shim that reads them via the API so agents have a guaranteed-portable command.
- Write side: do we let agents *set* xattrs to mutate metadata (e.g. add a comment), or is xattrs read-only and writes go through CLI/MCP? Probably read-only on day one — writing comments via `setfattr` is cute but the comment payload is structured (author, body, anchor) and doesn't fit a flat string well.
- Semantic search doesn't really fit xattrs. Two reasonable paths: (a) push it out of the mount entirely and expose via `agent-fs search ...`; (b) later, add a magic read-only directory `/<mount>/.agent-fs/search/<query>/` that returns symlinks to matching files. Defer (b).
- Net: this answer makes the mount surface small and well-defined — POSIX bytes + a few well-known xattrs. Everything else lives in the existing CLI/MCP. Good for shipping a v1.

### Q: How are multiple drives laid out under the mount?

**All drives at the root + a `current` symlink to the default drive.** API key is scoped to an org, so the mount surfaces every drive the key can see. A `current` symlink lets path-naive scripts pretend there's a single drive.

**Insights:**
- Root layout: `<mount>/<drive-slug>/<path>` plus `<mount>/current -> <default-drive>/`. The "default" comes from the same place the CLI gets it (env var / config / "last used").
- Drive listing at `<mount>/` becomes a live readdir against the API — small, cheap, but must be cached briefly so `ls` is fast.
- Drive *creation* via `mkdir <mount>/new-drive` is tempting but probably a footgun (typo → accidental drive). Make it explicit: `mkdir` returns EROFS at the drive level, and creation goes through `agent-fs drive create`. Document this.
- Membership: drives the user doesn't have access to simply aren't visible. No special handling needed; consistent with how `ls` already works for permissions.
- The `current` symlink is dynamic — it should re-resolve every time it's read (FUSE `readlink`). If the user switches default drive via CLI, the next dereference reflects it without re-mounting.
- Path stability: drive *slugs* (not display names) are the on-mount path component. Renaming a drive must not break paths in scripts — slug stays, display-name is a separate field.
- This also positions the mount as a single artifact per host: there's no reason to mount more than one path; everything an org can see is already there.
- Multi-org workflow (rare for agents, more common for humans): handled by mounting different paths with different `AGENT_FS_API_KEY`s. Documented, not magical.

### Q: What should happen when the daemon is unreachable?

**Fail fast — errors propagate.** Reads/writes return EIO immediately. Agents see a clean error and can decide what to do.

**Insights:**
- Excellent fit for agent ergonomics: agents are trained to interpret tool errors and retry/reroute, but they're terrible at noticing hangs. A non-zero exit code + stderr is exactly the signal they need.
- Implementation simplifier: no on-disk write journal, no replay logic, no conflict reconciliation, no offline mode to maintain. v1 architecture stays small.
- Risk to mitigate: a transient blip (sub-second TCP reset) shouldn't trash an `rsync` invocation. So while *user-visible* semantics are fail-fast, internally we should allow a short bounded retry — say ≤3 attempts within ≤1s — for idempotent operations (GET/HEAD). Anything beyond that, error out.
- Writes should *not* be auto-retried, because the close-time PUT may have partially succeeded. Better to surface EIO and let the agent re-open and re-write.
- Errors need to be *informative* via stderr / FUSE error logging — agents will see `Input/output error` and not know why. We can't put a message in the syscall, but we can:
  - Write last-error to a virtual file `<mount>/.agent-fs/status` agents can `cat` after a failure.
  - Log richly to `~/.agent-fs/mount.log`.
  - Emit a `notify-send`-style hint on auth expiry.
- Auth-expired is a special case worth surfacing distinctly (EACCES vs EIO) so agents can run `agent-fs auth refresh` and try again.
- Mount itself should stay alive across daemon restarts — only the requests fail, not the FUSE process. Otherwise agents lose their working directory mid-session.

### Q: How do we handle version churn from frequent agent writes?

**Version-on-close, deduped by content hash.** Every close-after-write is a candidate version, but skipped if the bytes are byte-identical to the current head.

**Insights:**
- Cheap, clean rule that handles the worst no-op patterns: `touch file`, `sed -i 's/x/x/'`, idempotent rewrites by agents that "save in case." None of those produce versions.
- Hash must be computed at close-time on the local working copy before upload. SHA-256 of the buffer is fine and fast.
- Optimization: if the hash matches current head, we can also *skip the PUT entirely* — saves bandwidth and S3 cost, not just version-table rows. The xattr `user.agent-fs.content-hash` lets us compare without a re-download.
- Embeddings/indexing should hang off "new version actually created," not "close happened." Saves OpenAI cost and keeps the search index stable.
- Edge: an agent appends, then deletes back to original — content matches head. We don't version it. That's the right behavior; the agent has nothing new to remember.
- Edge: rapid burst of distinct edits within milliseconds (e.g. an editor's atomic-rename save pattern: write → rename → write → rename). Each is technically a different hash, so we *would* version each. If this becomes painful, layer a coalescing window on top later; don't ship it in v1.
- Mtime/ctime semantics: even on no-op closes, we should *not* bump mtime — otherwise downstream tools (make, rsync) think the file changed. mtime should track actual head-version creation time.
- Versions still get an author identity. Mount writes attribute to the API key's identity (the agent). Good for audit later.
- The "draft until checkpoint" model is interesting but out of scope for v1; revisit if version noise becomes a complaint.

### Q: Where does the FUSE mount run for an agent in a sandbox?

**Inside the agent's sandbox** — each agent container mounts its own. Caveat from Taras: *multiple agents may share the same drive*, so the design must hold up when several mounts point at the same drive concurrently.

**Insights:**
- Per-sandbox mount means per-sandbox cache and per-sandbox failure domain. Good isolation, but also means there is no single authoritative cache — invalidation has to happen via the server's view of state.
- "Multiple agents sharing a drive" is the load-bearing constraint here. Implications:
  - Open-to-close consistency means an agent that does `open → read` won't see another agent's mid-flight writes, but *will* see them on the next open. That matches what we already chose; the multi-agent case validates it.
  - Last-close-wins on concurrent writes; agent-fs versioning preserves both. Tolerable for collaborative agents, but we should surface conflicts.
  - We should consider a *change notification* channel (server-pushed) so that other mounts learn about new versions without polling. WebSocket or SSE from the daemon is a small addition. Without it, mounts only see new content when their dir-listing TTL expires.
  - Local-cache invalidation key is `(drive, path, head-version-id)`. The notification only needs to carry that triple. If a mount has a cached entry with a stale head version, drop it.
- Sandbox FUSE prerequisites are a real adoption hurdle:
  - Docker: `--cap-add SYS_ADMIN --device /dev/fuse --security-opt apparmor:unconfined`. Documented patterns exist (Dropbox/headless, S3FS, rclone).
  - Rootless Docker / Kubernetes Pods / Apple Container / Firecracker microVMs: each has its own story; some require `fuse-overlayfs` or kernel modules. Worth a compat matrix in docs.
  - For environments that can't grant FUSE, we should keep the CLI/MCP path as a first-class fallback and document the matrix.
- Auth-per-sandbox is easy: env var `AGENT_FS_API_KEY` already exists. The mount uses it. If an agent is given a *scoped* key (single drive, read-only), the mount inherits that scoping for free.
- "Multiple agents sharing a drive" also makes the case for *attribution* in the version stream — versions tagged with the agent identity behind the API key (agent name, run id) so humans reviewing history can tell who did what.

### Q: What's the minimum useful v1?

**Read-write, Linux, no xattrs.** Full CRUD on file contents inside the agent's Linux sandbox. Metadata surface (xattrs, comments, search) lives behind the existing CLI/MCP for now.

**Insights:**
- Right-sized for the chosen primary user: agents in Linux containers running shell commands. They get `cat`/`grep`/`sed -i`/`rg`/`vim`/`mv`/`rm`/`mkdir` against agent-fs out of the box. That's the whole point.
- Defers two big-but-non-essential surfaces:
  - **xattr exposure** — useful but not on the critical path; agents fall back to `agent-fs info <path>` for richer metadata until it lands.
  - **macOS** — macFUSE is a real cost (kext approval, reboot, fuse-t fallback). Not blocking the agent value prop, and humans on macOS already have the web UI + CLI.
- v1 op set the FUSE layer needs to implement (Linux libfuse 3.x):
  - Read path: `getattr`, `readdir`, `open`, `read`, `release`, `readlink`
  - Write path: `create`, `write`, `flush`, `release` (close-time PUT), `truncate`, `unlink`, `rename`, `mkdir`, `rmdir`
  - Stat metadata: size from object, mtime = head-version created_at, mode = 0644 / 0755 for dirs
  - No-ops or stubs: `chmod`, `chown`, `utimens`, `fsync` (return 0), `flock`/`fcntl` (return ENOSYS)
- The "drives at root + `current` symlink" layout still holds. Drive creation via `mkdir` at the root returns EROFS in v1 — explicit `agent-fs drive create`.
- Local working-copy strategy: per-`open()`, download to a temp file under `~/.agent-fs/mount/<pid>/<fh>`; close-time hash-compare, then PUT if changed. Temp files cleaned on `release`.
- Caching:
  - readdir results: TTL ~10–30s per directory.
  - getattr results: short TTL (~5s) or invalidate on writes / SSE notifications.
  - File content: only the per-open working copy; no persistent file cache in v1. Keeps the mental model simple.
- Cross-mount invalidation:
  - Polling-only in v1 (via readdir/getattr TTL). Server-pushed notifications are a v1.1 nice-to-have once we know they're needed.
- Implementation language: a small Rust or Go FUSE helper called by the Bun daemon over an IPC socket is probably the most robust path, since Bun's native FUSE bindings are thin. The daemon handles auth/cache; the helper handles kernel callbacks.
- Distribution: ship the FUSE helper binary inside `@desplega.ai/agent-fs` for `linux-x64` / `linux-arm64`. `agent-fs mount <path>` looks it up and spawns it.
- Ship gate / definition of done for v1: agents in a standard Docker sandbox can run `bash -c 'echo hi > /mnt/agent-fs/current/scratch.md && cat /mnt/agent-fs/current/scratch.md && grep -r scratch /mnt/agent-fs/current'` and see the file land in the web UI / CLI.

### Q: Pre-mortem — what's the most likely way this flops?

**Concurrency / silent overwrites.** Multi-agent last-close-wins corrupts work; trust evaporates after the first incident; nobody opts back in.

**Insights:**
- This is the *anti-pattern* we have to design against — it disqualifies the "simple POSIX layer" if we don't handle it intentionally.
- Mitigations we should bake into v1 even though scope is minimal:
  - **Conditional PUT on close**: at open() we record `head-version-id`; at close() we PUT with an `If-Match: <head-version-id>` precondition. If head moved while we held the file, the PUT fails and we either (a) return EIO with a clear error, or (b) write a *side-version* (still gets a version row, marked `conflict: true`) and surface it via stderr / status file. Either way, no silent overwrite.
  - **Default mode = (a) fail loudly.** Side-versioning is a feature flag; flipping it on later is easy. Agents that can't handle conflicts will at least see the error and stop.
  - **Audit trail**: every version stores the agent identity that produced it and the parent version id. Reviewers can replay the divergence.
  - **Conflict visibility**: a virtual file like `<mount>/.agent-fs/conflicts` lists recent conflicts with paths and version ids; agents (and humans) can `cat` it after suspicious behavior.
- This also re-validates that we shouldn't fake POSIX locks: pretending `flock` works would just shift trust loss from "silent overwrite" to "fake lock didn't actually protect me." Better to be explicit: "this filesystem uses optimistic concurrency; conflicts surface as I/O errors."
- Long-term escape hatches if conflicts become common:
  - Per-file leases: an agent declares "I'm editing X" via xattr write; other mounts treat it as advisory. Cooperative, not enforced.
  - Server-side merge for line-oriented text: 3-way merge if a conflict is detected on plain-text files. Promotes side-versions to merged versions when safe.
  - Append-only "journal" mode for files where multiple agents only ever append (logs, transcripts).
- One more risk this surfaces: the SAME agent in two terminals (or the same agent retried) can step on itself. Conditional PUT protects against that too — same mechanism.
- This makes the v1 ship gate stricter: not just "writes round-trip," but "two concurrent writers produce 1 head + 1 visible conflict, never silent loss."











## Synthesis

### Key Decisions

- **Audience framing.** The mount is a *shell adapter for agents*, not a remote drive for humans. Latency, idempotency, and cheap accidental operations matter more than Finder polish. MCP/CLI remain the high-leverage surfaces; the mount is for the long tail of shell ergonomics.
- **Consistency model.** Open-to-close (NFSv3-style). `open()` snapshots; `close()` publishes. No mid-stream visibility, no fake locks. Matches S3 object-PUT semantics.
- **Mount tech.** FUSE via libfuse on Linux first. macFUSE/fuse-t deferred to a later phase. A small native FUSE helper invoked by the Bun daemon over IPC — Bun's native FUSE bindings are too thin to rely on.
- **Helper language: Rust `fuser` v0.17+.** Resolved by research ([thoughts/taras/research/2026-05-15-fuse-helper-language.md](../research/2026-05-15-fuse-helper-language.md)). v0.17 added `Config::n_threads` and (experimental) `AsyncFilesystem`; AWS `mountpoint-s3` is the closest production analog (S3-backed FUSE). go-fuse is the runner-up if dev ergonomics outweigh latency. Use sync `Filesystem` trait + a dedicated tokio runtime thread parked on the Unix socket to the Bun daemon — skip the experimental async trait in v1. Build static musl binary via `cross` Docker image.
- **Helper ↔ daemon IPC: length-prefixed msgpack (or bincode) over Unix socket.** JSON parse cost dominates per-op latency for hot paths like getattr/read; binary framing is the right call from day one.
- **Distribution: `optionalDependencies` per platform.** Resolved by research ([thoughts/taras/research/2026-05-15-fuse-binary-npm-distribution.md](../research/2026-05-15-fuse-binary-npm-distribution.md)). Ship `@desplega.ai/agent-fs-fuse-linux-x64` and `@desplega.ai/agent-fs-fuse-linux-arm64` as scoped sub-packages with `os`/`cpu`; main package lists them in `optionalDependencies` pinned to the exact main version. No `postinstall`. `AGENT_FS_FUSE_BIN` env override for local dev. Sub-packages published with `bunx npm publish --provenance` from a tag-gated GitHub Actions workflow (bun publish lacks `--provenance` per oven-sh/bun#15601). Embed SHA-256 of each binary into the main package post-TanStack worm. Add esbuild-style registry-fallback fetcher for `npm ci` / Windows / `--no-optional` edge cases — but not on day one.
- **Drive layout.** One mount per host, all org drives at the root: `<mount>/<drive-slug>/...`, plus `<mount>/current -> <default-drive>` symlink that re-resolves dynamically. Drive *creation* is not via `mkdir` (returns EROFS) — still through `agent-fs drive create`. Server has the seam already: `/auth/me` returns `defaultDriveId` (`packages/server/src/routes/auth.ts:39-59`).
- **Metadata surface.** Mount stays POSIX-only in v1. Versions, comments, search, members stay behind the existing CLI/MCP. xattrs come in v1.1 as a read-only metadata window (`user.agent-fs.version`, `.content-hash`, `.drive`, `.uri`, etc.).
- **Failure mode.** Fail fast — EIO on errors, EACCES on auth-expired. Internal bounded retries (≤3 within ≤1s) for idempotent GETs only. Writes never auto-retry. Last error written to a virtual `<mount>/.agent-fs/status` file and to `~/.agent-fs/mount.log`. FUSE process stays alive across daemon restarts.
- **Version churn.** Version-on-close, content-hash deduped. Identical-bytes closes skip both the version row *and* the PUT. Mtime only bumps on actual new versions, so `make`/`rsync` don't see false changes. Embeddings/indexing hang off "new version created," not "close happened."
- **Mount location.** Inside the agent's sandbox (per-agent), not host-shared. Acknowledges multiple agents may share a drive: invalidation is server-driven, not local.
- **Concurrency safety (load-bearing).** Conditional PUT on close: record `head_version_id` at `open()`, send `If-Match` at close. Mismatch ⇒ default behavior is **fail loudly with EIO** (a side-version branch is a feature flag for later). Conflict log surfaced via NDJSON at `<mount>/.agent-fs/conflicts.ndjson`. Versions are author-attributed so multi-agent history is auditable. **Never silently overwrite.** The codebase already has an app-layer `expectedVersion` check on the `write` op (`packages/core/src/ops/write.ts:29-41`) we can extend — see Implementation seams below.
- **Conflict surface contract.** Resolved by research ([thoughts/taras/research/2026-05-15-fuse-conflict-surface-prior-art.md](../research/2026-05-15-fuse-conflict-surface-prior-art.md)). Ship NDJSON at `<mount>/.agent-fs/conflicts.ndjson` (append-only, size-rotated to ~10 MB × 3 files), plus `<mount>/.agent-fs/conflicts.latest.json` for cheap snapshot reads, plus `<mount>/.agent-fs/status` (last error). Record schema: `{schema:"agent-fs.conflict/v1", ts, id, drive, path, outcome ∈ {rejected, side_versioned, auto_resolved}, base_version, head_version, attempted_by:{api_key_id, agent, run_id}, head_author:{...}, side_version|null, bytes_attempted, content_hash_attempted}`. Stable additive schema — `id` ULID per record for future ack/dismiss ops.
- **v1 scope.** Read-write, Linux only, no xattrs. Op set covers `getattr`/`readdir`/`open`/`read`/`release`/`readlink`/`create`/`write`/`flush`/`release`/`truncate`/`unlink`/`rename`/`mkdir`/`rmdir`. `chmod`/`chown`/`utimens`/`fsync` are no-ops; `flock`/`fcntl` return ENOSYS.
- **Naming: `agent-fs mount <path>` subcommand.** Single user-facing binary; the Rust helper sub-package binary is spawned internally. Matches the existing CLI shape.
- **Multi-org: defer.** One `AGENT_FS_API_KEY` per mount → org → drives at root. Multi-org workflows = multiple mounts with different keys. No path reservation for org slug in v1.
- **Conflict policy: fail loudly by default.** `If-Match` mismatch → HTTP 409 → mount returns EIO and writes a `conflicts.ndjson` record with `outcome: "rejected"`. Side-version branch (`outcome: "side_versioned"`) is a later feature flag, not in v1.
- **Conflict log retention: size-only.** ~10 MB × 3 rotations (~30 MB disk ceiling). Predictable footprint; immune to "quiet drive forever-keep" and "runaway loop forgets-everything" failure modes. Time-windowed queries via `agent-fs daemon conflicts --since=24h --drive=<slug>`.
- **EIO feedback channel.** Mount surfaces errors on three coherent surfaces with the same shape family as `conflicts.ndjson`:
  - `<mount>/.agent-fs/status` — single-line plain-text last-error, rewritten on each failure ("eio: conflict on /notes/plan.md (base=ver_X head=ver_Y)").
  - `<mount>/.agent-fs/errors.ndjson` — append-only structured log, same rotation policy as conflicts (~10 MB × 3). Record schema: `{schema:"agent-fs.error/v1", ts, id, drive, path, op, errno, http_status?, base_version?, head_version?, attempted_by, hint}`.
  - `~/.agent-fs/mount.log` — full debug stream (off the mounted FS so it survives crashes).
- **CSI sidecar adapter is v1.x.** Not in v1. Ships after v1 stabilizes, addressing the K8s restricted-PSS / GKE Autopilot audience via the GCS-FUSE / meta-fuse-csi-plugin pattern.

### Constraints Identified

- **Bun-only runtime in the daemon** — but FUSE callbacks run in the Rust helper, not in Bun. IPC over a Unix socket.
- **Sandbox FUSE prerequisites are harsher than initially scoped.** Resolved by research ([thoughts/taras/research/2026-05-15-fuse-sandbox-compat.md](../research/2026-05-15-fuse-sandbox-compat.md)). Concrete matrix:
  - **Works**: Docker rootful, Podman rootful, K8s privileged, Cloudflare Containers (native FUSE, shipped Nov 2025), Apple Container, E2B (native), Kata. These get a real FUSE mount.
  - **Conditional**: K8s baseline (caps must be granted), K8s restricted via CSI sidecar pattern (GCS-FUSE / meta-fuse-csi-plugin model — privileged init opens `/dev/fuse`, unprivileged sidecar runs the FUSE daemon, bind-shared into the workload).
  - **Broken**: **gVisor** (sentry FUSE is host-stub only since 2020; affects GKE Sandbox + Cloud Run gen1 + several agent platforms), **GitHub Codespaces** (remote env ignores `--device`), **Modal sandboxes** (FUSE internal-only), **Fly.io Machines** (`CONFIG_FUSE_FS` not in default kernel), **K8s restricted PSS** without a CSI sidecar.
  - **Implication:** the "FUSE-forbidden" set is a significant share of the agent-sandbox market. CLI/MCP must remain the universal fallback (already true), and we should plan a **CSI-sidecar adapter** as a v1.x deliverable for managed-K8s deployments. virtio-fs is a longer-term option where we control the hypervisor.
- **S3 semantics** — objects are atomic PUTs, not byte-range-writable. The open-to-close model is the only one that maps cleanly.
- **No real POSIX locks across the network** — `flock`/`fcntl` are advertised as unsupported (ENOSYS); we use optimistic concurrency (`If-Match`) instead. **Side-effect**: tools that lock (sqlite, git index, some builds) will misbehave inside the mount. v1 documents this; agents should `cp` files out to `/tmp` for those workflows.
- **Cost surfaces** — each `release`-after-mutation could trigger a PUT + version + embedding + index update. Hash-dedup cuts the worst of this; we must instrument it so a runaway agent loop is visible.
- **Cross-platform xattr semantics** — deferred to v1.1, but when we tackle them, Linux `user.agent-fs.*` is the safe namespace.
- **Path stability under rename** — drive *slugs* (not display names) form the mount path; renames must preserve slugs.
- **`passthrough_ll` requires kernel ≥6.9** — both fuser and go-fuse expose it, but the optimization only engages on recent kernels. Not a blocker; userspace read/write is the fallback.
- **macOS dev-host friction for Rust cross-compile** — `cross` Docker image needed for static musl Linux builds. CI runs on Linux. Devs without Docker should use the `AGENT_FS_FUSE_BIN` override pointing at a pre-built binary or run the daemon inside the existing MinIO docker setup.

### Implementation seams (from codebase trace)

From [thoughts/taras/research/2026-05-15-fuse-write-path-codebase.md](../research/2026-05-15-fuse-write-path-codebase.md). Concrete file:line refs the plan will need:

- **Reuse the op dispatcher.** The current write path is a single JSON op endpoint at `POST /orgs/:orgId/ops` (`packages/server/src/routes/ops.ts:9`) → `dispatchOp` (`packages/core/src/ops/index.ts:274`) → `write.ts:12` → `s3.putObject` (`packages/core/src/s3/client.ts:78`) → `createVersion` (`packages/core/src/ops/versioning.ts:39-115`) → `indexFile` (sync FTS5, `packages/core/src/search/fts.ts:8`) → `scheduleEmbedding` (async, `packages/core/src/search/pipeline.ts:149-176`). A new `PUT /orgs/:orgId/drives/:driveId/files/*/raw` route can call into the same `write` op internally and reuse RBAC + versioning + indexing for free.
- **Optimistic concurrency already exists, partially.** `WriteParams.expectedVersion` is honored only by `write` (`packages/core/src/ops/write.ts:29-41`) and maps to `EditConflictError` → HTTP 409 (`packages/core/src/errors.ts:59-73`, `packages/server/src/middleware/error.ts:13`). The mount can express `If-Match: <head_version_id>` as a header that's translated to `expectedVersion`. Gaps to close: (a) propagate `expectedVersion` to `edit`/`append`/`mv`/`cp`/`revert`/`rm`, (b) wrap the version insert in a transaction or add `UNIQUE(path, drive_id, version)` on `file_versions` to close the TOCTOU window, (c) consider real S3 `If-Match` plumbing in `AgentS3Client.putObject` as a deeper hardening step.
- **No `content_hash` column today.** Dedup-on-close needs a `file_versions.content_hash TEXT` column populated on insert and surfaced via a `stat`/`/raw` response header. New behavior; small schema migration.
- **No `parent_version_id` column.** Lineage is implicit (`version - 1`). If side-versions land (v1.x), recording the parent explicitly will matter.
- **No raw byte PUT, only 10 MB JSON.** `write` op caps content at 10 MB (`packages/core/src/ops/write.ts:21-26`); body is JSON-buffered. New `PUT /raw` should stream binary and lift the cap.
- **No version exposed on raw GET.** `/orgs/:orgId/drives/:driveId/files/*/raw` (`packages/server/src/routes/files.ts:12-50`) returns bytes without `ETag` or `x-agent-fs-version`. Smallest change: emit a `x-agent-fs-version` header so FUSE `open()` doesn't need a separate `stat` round-trip.
- **Default drive seam.** `/auth/me` (`packages/server/src/routes/auth.ts:39-59`) already returns `defaultDriveId` — exactly what the `<mount>/current` symlink needs. Drive listing composes `GET /orgs` + `GET /orgs/:id/drives` (`packages/server/src/routes/orgs.ts:22-46`); the listing returns all drives in the org without filtering by `driveMembers`, so the mount should either filter or rely on first-op-403.
- **No SSE/WebSocket.** Cross-mount invalidation is poll-only in v1. The `events` table (`packages/core/src/db/schema.ts:147-164`) is the natural spine for a future server push channel but has no producer for file writes today.
- **Author attribution is `users.id` only.** No separate "agent identity." If multi-agent attribution becomes a need (it will), it's a small schema + middleware change — push `agent` / `run_id` through the API key metadata and stamp it on `file_versions`.

### Open Questions

(Most were closed by background research. Remaining items below.)

- **Per-PID temp dir cleanup.** When a FUSE-using process dies hard, working copies under `~/.agent-fs/mount/<pid>/` leak. Periodic GC on daemon start + a `pid` liveness check on each request? Plan-time decision.
- **Embedding/index re-run latency.** Embedding is async fire-and-forget (`packages/core/src/search/pipeline.ts:42`, in-process semaphore size 2). Agents that write-then-search may race. Acceptable for v1; document.
- **CSI sidecar timeline.** Is this a v1.x deliverable or a v2? If a chunk of agent-fs's enterprise audience runs on K8s restricted PSS or GKE Autopilot, the sidecar may matter more than macOS host mounting.
- **Real S3 `If-Match`.** Going beyond app-layer `expectedVersion` to actual `IfMatch: <etag>` at the S3 client gives much stronger guarantees but requires `AgentS3Client.putObject` plumbing and only works on providers that honor it (AWS S3 yes; MinIO since 2024; Cloudflare R2 partial). Defer unless multi-writer races are observed.

### Held for Taras (judgment, not research)

- **Naming**: `agent-fs mount` subcommand vs `agent-fs-mount` separate binary. (Recommendation: subcommand — keeps install surface unified, and the binary itself is the per-platform sub-package, not the user-facing CLI.)
- **Multi-org auth from a single mount**: defer (lean) vs solve early. (Recommendation: defer; one mount per `AGENT_FS_API_KEY`.)
- **Exact EIO-to-agent feedback channel** beyond `<mount>/.agent-fs/status`: structured stderr on the mount process? Optional `fuser`-style logging? Worth nailing the contract before agents start parsing whatever we emit.
- **Confirmation of "fail loudly"** as the default conflict behavior (side-version branch as a later feature flag).
- **CSI sidecar adapter as v1.x scope** vs v2.
- **Default conflict-log retention**: size-only (~10 MB × 3 rotations) vs add a time cap (e.g. last 30 days).

### Core Requirements (lightweight PRD)

1. **`agent-fs mount <path>` subcommand** that brings up a FUSE filesystem at `<path>` showing all drives the current API key can see, plus a `current -> <default-drive>` symlink resolved dynamically from `/auth/me`.
2. **POSIX read-write semantics** over file *contents* with the op set listed above. Non-content ops (`chmod`, `chown`, `utimens`) are accepted no-ops; locking ops return ENOSYS.
3. **Open-to-close consistency** with per-open local working copies under `~/.agent-fs/mount/<pid>/<fh>`. Reads serve the snapshot taken at `open()`. Writes published at `close()`. Periodic GC + pid-liveness check sweeps leaked temp dirs.
4. **Rust `fuser` v0.17+ helper** distributed via `optionalDependencies` per-platform npm sub-packages (`@desplega.ai/agent-fs-fuse-linux-{x64,arm64}`); main package resolves the binary at runtime; `AGENT_FS_FUSE_BIN` overrides for dev. SHA-256 embedded in main package for verification.
5. **Length-prefixed msgpack IPC** between the helper and the Bun daemon over a Unix socket at `~/.agent-fs/agent-fs.sock` (or beside `agent-fs.pid`).
6. **Server changes:**
   - New `PUT /orgs/:orgId/drives/:driveId/files/*/raw` route — streamed binary body, calls into the existing `write` op internally to reuse RBAC, version creation, FTS5 indexing, embedding scheduling. Honors `If-Match: <version_id>` header (mapped to `WriteParams.expectedVersion`).
   - Add `x-agent-fs-version` response header on `GET /raw` so `open()` learns head version without a separate `stat` call.
   - Add `file_versions.content_hash TEXT` column (schema migration). Populate on insert. Surface via `x-agent-fs-content-hash` header.
   - Propagate `expectedVersion` through `edit`/`append`/`mv`/`cp`/`revert`/`rm` op handlers.
   - Wrap version insert in a transaction; add `UNIQUE(path, drive_id, version)` on `file_versions` to close the TOCTOU window in `getNextVersion`.
7. **Content-hash dedup** on close — skip PUT + version creation when bytes are byte-identical to the recorded head (compare SHA-256).
8. **Optimistic concurrency** via `If-Match: <head_version_id>` on close-time `PUT /raw`. Mismatch ⇒ HTTP 409 → mount returns EIO and writes a record to `conflicts.ndjson`. **No silent overwrites.**
9. **Fail-fast error model.** EIO/EACCES propagate; mount stays alive across daemon restarts; bounded retries (≤3 within ≤1s) only for idempotent GETs. Writes never auto-retry.
10. **Per-sandbox deployment.** Documented Docker/Linux container recipe (`--cap-add SYS_ADMIN --device /dev/fuse [--security-opt apparmor:unconfined]`). Compat matrix shipped in docs. CLI/MCP remain the universal fallback for FUSE-forbidden runtimes (gVisor, Codespaces, Modal, K8s restricted PSS without sidecar, Fly).
11. **Conflict surface.** NDJSON at `<mount>/.agent-fs/conflicts.ndjson` (size-rotated, ~10 MB × 3 files), `<mount>/.agent-fs/conflicts.latest.json` (last-10 snapshot), `<mount>/.agent-fs/status` (last error, plain text), and `<mount>/.agent-fs/errors.ndjson` (structured error log, same rotation). Records use `agent-fs.conflict/v1` / `agent-fs.error/v1` schemas. Plus `~/.agent-fs/mount.log` for full debug detail.
12. **Server-attributed versions.** Every version produced via the mount records the API key's `users.id`. (Multi-agent attribution beyond `users.id` is held for a separate feature.)
13. **E2E coverage in `scripts/e2e.ts`** — Docker container that mounts the test daemon's drive, runs the canonical scripts:
    - `echo > x; cat x; grep -r; mv; rm` round-trip.
    - Two concurrent writers → exactly one head version, one entry in `conflicts.ndjson`, one EIO.
    - Hash-dedup: `touch` and idempotent rewrite produce no new versions.
    - Daemon restart mid-mount: FUSE process survives, in-flight write fails cleanly.
14. **Release-checklist updates** — new ops/routes ⇒ update `skills/agent-fs/SKILL.md`, bump plugin + package version, extend E2E.

### Non-goals (v1)

- macOS host mount (macFUSE / fuse-t).
- xattr metadata exposure.
- Semantic search via a magic directory.
- Real POSIX file locking.
- Persistent file cache (only per-open working copies).
- Server-pushed invalidation (poll-only TTLs in v1).
- Append/merge conflict resolution; v1 is detect-and-error only.

## Next Steps

- **Done (2026-05-15):** Brainstorm + 5 parallel background research notes synthesized back into Key Decisions, Constraints, Open Questions, Implementation seams, and Core Requirements above. Research notes:
  - [Helper language → Rust `fuser`](../research/2026-05-15-fuse-helper-language.md)
  - [npm distribution → `optionalDependencies`](../research/2026-05-15-fuse-binary-npm-distribution.md)
  - [Sandbox FUSE compat matrix](../research/2026-05-15-fuse-sandbox-compat.md)
  - [Current write path in `packages/core`](../research/2026-05-15-fuse-write-path-codebase.md)
  - [Conflict-surface prior art → NDJSON](../research/2026-05-15-fuse-conflict-surface-prior-art.md)
- **Recommended next step:** `/desplega:create-plan` using this brainstorm + the 5 research notes as input. Phases the plan should cover:
  1. Server changes (schema migration: `content_hash`, `UNIQUE(path,drive_id,version)`; new `PUT /raw` route reusing the `write` op; `expectedVersion` propagation; response headers on `GET /raw`).
  2. Rust FUSE helper skeleton (fuser sync `Filesystem` trait, msgpack-over-Unix-socket client, op set, per-open temp dir).
  3. Bun daemon IPC server (msgpack listener, plumbing to existing `ApiClient`, drive-listing & default-drive resolution, conflict log writer).
  4. Distribution (sub-package layout, GitHub Actions release matrix, SHA-256 manifest, `bunx npm publish --provenance`).
  5. E2E (`scripts/e2e.ts` extensions: mount-in-Docker, concurrent-writer conflict, hash dedup, daemon-restart resilience).
  6. Docs (sandbox compat matrix, "how to run agent-fs FUSE in your container", troubleshooting EIO/EACCES).
- **Plan must end with a "Manual E2E" section** of concrete commands against a real MinIO + daemon per [CLAUDE.md project rules](../../../CLAUDE.md).

### Resolved (2026-05-15 follow-up Q&A)

All six previously held-for-judgment items resolved. Decisions promoted into Key Decisions above; this section preserves the trail.

- **Naming**: `agent-fs mount <path>` subcommand. ✅
- **Multi-org**: defer; one API key per mount. ✅
- **EIO feedback channel**: three-surface design (`.agent-fs/status` line + `.agent-fs/errors.ndjson` structured + `~/.agent-fs/mount.log` debug). ✅
- **Conflict policy**: fail loudly by default; side-version is a future feature flag. ✅
- **CSI sidecar adapter**: v1.x follow-up, after v1 ships. ✅
- **Conflict-log retention**: size-only, ~10 MB × 3 rotations. ✅

