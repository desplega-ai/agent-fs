# agent-fs FUSE Mount

`agent-fs mount` exposes your drives as a Linux FUSE filesystem so agents and humans can use plain shell verbs (`cat`, `grep`, `mv`, `rm`) against agent-fs content. It's a *shell adapter for agents*, not a replacement for the CLI / MCP / HTTP surfaces — they remain the universal path for sandboxes that block FUSE.

> **Platform**: Linux only in v1. macOS host mount is on the v2 roadmap. See [`fuse-compat.md`](./fuse-compat.md) for which container runtimes support FUSE.

## Quickstart

```bash
# 1. Install the CLI (Linux x64 or arm64 — the FUSE helper ships in an
#    optionalDependencies sub-package).
npm install -g @desplega.ai/agent-fs

# 2. Start a daemon (uses your local agent-fs config).
agent-fs daemon start

# 3. Make a mount point and mount.
mkdir -p /mnt/agent-fs
agent-fs mount /mnt/agent-fs

# 4. List drives — each drive shows up as a top-level directory; `current`
#    is a symlink to your default drive.
ls /mnt/agent-fs/
# personal/  team-docs/  current -> ./personal

# 5. Use plain shell verbs against the mount.
echo "hello from FUSE" > /mnt/agent-fs/current/scratch.md
cat /mnt/agent-fs/current/scratch.md
grep -r scratch /mnt/agent-fs/current/
mv /mnt/agent-fs/current/scratch.md /mnt/agent-fs/current/notes/scratch.md

# 6. Unmount when you're done.
agent-fs umount /mnt/agent-fs
```

If `agent-fs mount` complains it can't find the helper (`agent-fs-fuse: command not found`), see [`fuse-troubleshooting.md`](./fuse-troubleshooting.md).

## Architecture

```
+--------------------+           +----------------+
|     agent / shell  |           | other agents / |
| (cat, grep, mv, …) |           |  CLI / MCP     |
+----------+---------+           +-------+--------+
           |                             |
           v                             v
+--------------------+           +----------------+
|  FUSE kernel layer |           |   Bun daemon   |
|  /mnt/agent-fs     |           |  (HTTP server) |
+----------+---------+           +-------+--------+
           |                             ^
           | FUSE protocol               |
           v                             | HTTP /raw + /ops
+--------------------+    Unix socket    |
|  agent-fs-fuse     +-------------------+
|  (Rust helper)     |
+----------+---------+
           |
           v
+--------------------+
|       S3           |
|    (or MinIO)      |
+--------------------+
```

- **The mount is a FUSE filesystem implemented by `agent-fs-fuse`**, a small statically-linked Rust binary that the daemon spawns on `agent-fs mount`.
- **The helper talks to the daemon over a Unix socket** (`~/.agent-fs/agent-fs.sock`) using msgpack frames. All read/write requests on the mount turn into IPC calls to the daemon.
- **The daemon owns the HTTP API and the S3 client.** It runs PUT/GET against S3 (or MinIO) directly, with optimistic concurrency via the `expectedVersion` parameter on writes.
- **There is no separate cache.** Each FUSE `open()` fetches the head version from the daemon and buffers it; each `close()` after a content change pushes a new version to S3. We call this *open-to-close consistency*.

## Open-to-close consistency

The mount does **not** stream byte-by-byte to S3. Instead:

1. `open(path, O_WRONLY)` — the helper allocates a scratch buffer.
2. `write(...)` — bytes accumulate in the scratch buffer; nothing hits S3 yet.
3. `close(...)` — the helper:
   - Computes the SHA-256 of the buffer.
   - If the hash matches the current head version, **no new version is written** (idempotent dedup — `touch` and `echo > same-content` are free).
   - Otherwise, PUT `/raw` to the daemon with `If-Match: <expected-version>` for optimistic concurrency.
   - On 409, the helper records a conflict in `<mount>/.agent-fs/conflicts.ndjson` and returns `EIO` to the caller.

This means:

- A line-buffered `echo "x" > foo` produces **exactly one** version per `close()`.
- Two concurrent writers produce **exactly one** new version + **exactly one** `conflicts.ndjson` record + **exactly one** `EIO` to the loser. No silent overwrites.
- Programs that `fsync()` between writes still only get one version per `close()`. There's no per-byte commit.

## Feedback surfaces

agent-fs exposes operational signal at well-known paths so agents can self-diagnose. All paths are *virtual* — they live inside the mount but are served by the helper, not S3.

| Path | Contents |
|---|---|
| `<mount>/.agent-fs/conflicts.ndjson` | One JSON line per conflict: `{ ts, path, drive, op, head_version, your_version, outcome: "rejected" }` |
| `<mount>/.agent-fs/conflicts.latest.json` | The most recent conflict record (for quick reads, no `tail -1` needed) |
| `<mount>/.agent-fs/errors.ndjson` | One JSON line per error surfaced as `EIO`/`EACCES` to the caller: `{ ts, path, op, http_status, error }` |
| `<mount>/.agent-fs/status` | Current daemon-link status: `{ daemon: "ok" \| "down" \| "auth_error", last_seen, drive_count }` |
| `~/.agent-fs/mount.log` | One line per FUSE callback (debug-only; rotated at 10 MB). Set via `--log-level=debug`. |

**Recommended agent recipe**: after a write that returned non-zero, `cat <mount>/.agent-fs/status` first, then `tail -1 <mount>/.agent-fs/errors.ndjson` — the combination almost always explains the failure.

## Mount layout

```
/mnt/agent-fs/
  current -> ./personal         # symlink to your default drive
  personal/                     # drive root (read-write for files; read-only for the directory itself)
    docs/
      readme.md
    scratch.md
  team-docs/                    # other drives you have access to
    onboarding.md
  .agent-fs/                    # operational surfaces (read-only)
    conflicts.ndjson
    conflicts.latest.json
    errors.ndjson
    status
```

- The **drive root** is read-only: `mkdir /mnt/agent-fs/new-drive` returns `EROFS`. Create drives via `agent-fs drive create` (CLI) and they'll show up automatically on next `readdir`.
- The `current` symlink updates **dynamically** when you switch default drive (`agent-fs drive switch <name>`) — no remount needed.
- POSIX locks (`flock`) return `ENOSYS` in v1; agents that rely on them must use the `expectedVersion` parameter on the CLI / MCP / HTTP surfaces for optimistic concurrency.

## What you can and can't do

| Op | Works? | Notes |
|---|---|---|
| `cat`, `head`, `tail`, `less` | Yes | Buffered read; daemon serves the head version |
| `echo >`, `cat <<<`, `printf >>` | Yes | Open-to-close consistency; one version per `close()` |
| `grep -r`, `rg`, `find` | Yes | Reads only |
| `mv`, `rename` | Yes | One op per directory entry |
| `rm`, `unlink` | Yes | Soft-deletes; previous versions stay accessible via `agent-fs log` |
| `cp` (within mount) | Yes | Two ops: read + write |
| `mkdir`, `rmdir` (inside a drive) | Yes | Versions still tracked per file |
| `mkdir` at mount root | No (`EROFS`) | Use `agent-fs drive create` |
| `chmod`, `chown` | No (`ENOSYS` / no-op) | agent-fs has no POSIX permissions model |
| `flock`, `fcntl` locks | No (`ENOSYS`) | Use `--expected-version` for optimistic concurrency |
| Streaming large files (>50 MB) | Partial | The 50 MB Hono body limit caps a single PUT; streaming-into-S3 is v1.x |
| Extended attributes (`xattr`) | No | Read-only xattr window is v1.1 (`user.agent-fs.{version, content-hash, ...}`) |

## See also

- [`fuse-compat.md`](./fuse-compat.md) — sandbox compatibility matrix and runtime-specific incantations
- [`fuse-troubleshooting.md`](./fuse-troubleshooting.md) — `EIO`, `Transport endpoint is not connected`, helper-not-found, etc.
- [`api-reference.md`](./api-reference.md) — CLI / MCP / HTTP surfaces, including the `expectedVersion` parameter
- Implementation plan: [`thoughts/taras/plans/2026-05-15-agent-fs-fuse-mount-v1.md`](../thoughts/taras/plans/2026-05-15-agent-fs-fuse-mount-v1.md)
