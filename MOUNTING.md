# Mounting agent-fs as a Linux filesystem

`agent-fs mount /mnt/agent-fs` exposes your agent-fs drives as a Linux FUSE filesystem so agents can use plain shell verbs (`cat`, `grep`, `sed`, `rg`, `mv`, `rm`) against agent-fs content. v1 ships in 0.6.0 — Linux-only, read-write, open-to-close consistency, content-hash dedup on close.

## Quick start

```bash
# Linux: prereqs
sudo apt-get install -y fuse3
# (or equivalent for your distro)

# Build/install
npm install -g @desplega.ai/agent-fs    # picks up the right Linux binary via optionalDependencies

# Daemon + mount
agent-fs daemon start
agent-fs mount /mnt/agent-fs

# Use it
echo "hello" > /mnt/agent-fs/current/scratch.md
cat /mnt/agent-fs/current/scratch.md
grep -r hello /mnt/agent-fs/current
mv /mnt/agent-fs/current/scratch.md /mnt/agent-fs/current/notes.md
rm /mnt/agent-fs/current/notes.md

# Teardown
agent-fs umount /mnt/agent-fs
```

## What's in the mount

| Path | What it is |
|---|---|
| `/mnt/agent-fs/<drive-slug>/` | Each drive you have access to, one directory per slug |
| `/mnt/agent-fs/current` | Symlink to your default drive (re-resolved on every readlink) |
| `/mnt/agent-fs/.agent-fs/` | Sidecar files: `conflicts.ndjson`, `conflicts.latest.json`, `errors.ndjson`, `status` |

## What works

- ✅ Read + write through any shell tool (`cat`, `echo >`, `tee`, `sed -i`, `cp`, `mv`, `rm`)
- ✅ Directory listing (`ls`, `find`, `grep -r`)
- ✅ Content-hash dedup: re-writing identical bytes does NOT bump the version or charge S3
- ✅ Open-to-close consistency: the close-time PUT is the durability boundary
- ✅ Multi-drive (one directory per drive at the mount root)
- ✅ Default-drive symlink stays current if you `agent-fs drive switch`
- ✅ Clean unmount + per-pid working-dir cleanup on SIGTERM
- ✅ EROFS at the mount root (no `mkdir <drive>` — use `agent-fs drive create`)
- ✅ `flock` / `fcntl` returns `ENOSYS` so userspace tools fall back cleanly

## What doesn't work (known gaps)

| Scope | Status | Track |
|---|---|---|
| macOS host mount | ❌ Not supported in v1 | v2 — macFUSE / fuse-t |
| `xattr` metadata (`user.agent-fs.*`) | ❌ Not exposed | v1.1 |
| Real POSIX file locking | ❌ Returns `ENOSYS` | v1.1+ |
| Conflict auto-merge / side-versioning | ❌ Detect-and-error only | v1.x feature flag |
| Drive creation via `mkdir` at mount root | ❌ Returns `EROFS` (intentional) | — |
| Sandbox runtimes without `/dev/fuse` (gVisor, Codespaces, Modal, Fly Machines) | ❌ Fall back to CLI / MCP | v1.x CSI sidecar adapter |
| Parallel-writer conflict surfacing (e2e test 4) | ⚠️ Race window inconsistent; the loser may not always get EIO + sidecar record. At-least-one-persisted invariant holds. | TBD |
| Auth-expired mid-mount → EACCES (e2e test 8) | ⚠️ Daemon's API-key resolver caches at startup; on-disk config changes don't propagate | v1.1 (SIGHUP reload) |

## Where to look when things break

In priority order:

1. `<mount>/.agent-fs/status` — last error in a single line
2. `<mount>/.agent-fs/errors.ndjson` — append-only error log (with rotation)
3. `<mount>/.agent-fs/conflicts.ndjson` — append-only conflict log
4. `~/.agent-fs/mount.log` — helper-side FUSE callback trace
5. `~/.agent-fs/agent-fs.log` — daemon-side HTTP / IPC trace

## Sandbox compatibility

FUSE needs `--cap-add SYS_ADMIN --device /dev/fuse` to work inside a container. See [`docs/fuse-compat.md`](./docs/fuse-compat.md) for the full per-runtime matrix (Docker, Podman, K8s tiers, Cloudflare Containers, Apple Container, E2B, Kata) and which sandboxes block it (gVisor, GitHub Codespaces, Modal, Fly Machines).

## Architecture (one paragraph)

```
agent → /mnt/agent-fs/...  →  Rust FUSE helper  ←-Unix socket-→  Bun daemon  →  HTTP API  →  S3 / MinIO
                              (per-mount process)                 (one per host)
```

Each FUSE op the kernel sends to the helper turns into one msgpack frame on the Unix socket to the daemon, which dispatches via the same in-process op handlers the JSON / HTTP / MCP API uses. RBAC, versioning, FTS5 indexing, and embedding scheduling all flow through one path. No HTTP loopback inside the daemon. Open / read / write are local-only against a per-fh working copy; the close-time PUT is the only network round trip per file.

## Detailed docs

- [`docs/fuse-mount.md`](./docs/fuse-mount.md) — full quickstart, architecture, feedback surfaces
- [`docs/fuse-compat.md`](./docs/fuse-compat.md) — sandbox compatibility matrix
- [`docs/fuse-troubleshooting.md`](./docs/fuse-troubleshooting.md) — EIO / `Operation not permitted` / `Transport endpoint not connected` playbooks
- [`thoughts/taras/plans/2026-05-15-agent-fs-fuse-mount-v1.md`](./thoughts/taras/plans/2026-05-15-agent-fs-fuse-mount-v1.md) — v1 implementation plan
- [`thoughts/taras/brainstorms/2026-05-15-agent-fs-as-linux-filesystem.md`](./thoughts/taras/brainstorms/2026-05-15-agent-fs-as-linux-filesystem.md) — design rationale
