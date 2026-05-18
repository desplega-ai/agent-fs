# Mounting agent-fs

`agent-fs mount` exposes your drives as a Linux FUSE filesystem so agents and humans can use plain shell verbs (`cat`, `grep`, `mv`, `rm`) against agent-fs content. Two topologies are supported:

1. **Local daemon** — helper talks to a daemon on a Unix socket; the daemon owns the HTTP API + S3 client.
2. **Remote API (`--remote`)** — helper talks directly to a remote `agent-fs` HTTP API. No local daemon, no S3 credentials in the sandbox.

This page covers prerequisites, common errors, and links out to per-environment guides.

> Already familiar with FUSE? See [`fuse-mount.md`](../fuse-mount.md) for the mount semantics (open-to-close consistency, conflict handling, `.agent-fs/` feedback surfaces), [`fuse-compat.md`](../fuse-compat.md) for the sandbox compatibility matrix, and [`fuse-troubleshooting.md`](../fuse-troubleshooting.md) for the canonical error catalogue.

## Topologies

```
Topology A — local daemon + local S3
====================================

  +-----------------+         +------------+         +---------+
  | shell / agent   |  FUSE   | agent-fs-  |  Unix   | bun     |
  | cat foo / rm    +-------->+ fuse       +-------->+ daemon  |
  | mv a b ...      |  kernel | (Rust)     | socket  | HTTP    |
  +-----------------+         +------------+         +----+----+
                                                          |
                                                          v
                                                     +---------+
                                                     |   S3    |
                                                     +---------+

Topology B — remote agent-fs HTTP API (--remote)
================================================

  +-----------------+         +------------+         +-----------------+
  | shell / agent   |  FUSE   | agent-fs-  |  HTTPS  | remote agent-fs |
  | cat foo / rm    +-------->+ fuse       +-------->+ (fly / hetzner /|
  | mv a b ...      |  kernel | (Rust)     |  TLS    |  k8s / ...)     |
  +-----------------+         +------------+         +--------+--------+
                                                              |
                                                              v
                                                         +---------+
                                                         |   S3    |
                                                         +---------+
```

Topology B is what you want in sandboxes (Sprite, E2B, ephemeral CI runners) where running a local daemon + S3 client is impractical.

## Prerequisites (common to all environments)

| Requirement | Why | Check |
|---|---|---|
| Linux x86_64 or arm64 | FUSE is a Linux kernel feature; the helper ships as static musl binaries for these two arches. | `uname -sm` |
| `fuse3` package | Provides `fusermount3` + libfuse3 used by the helper. | `which fusermount3` |
| `/dev/fuse` readable | Kernel FUSE device must be accessible by the user mounting. | `ls -l /dev/fuse` |
| `/etc/mtab` exists (or is a symlink to `/proc/mounts`) | `fusermount3` updates the mount table. | `ls -l /etc/mtab` |
| `user_allow_other` in `/etc/fuse.conf` (only if `--allow-other`) | Lets the helper expose the mount to other UIDs. | `grep user_allow_other /etc/fuse.conf` |

See [`fuse-compat.md`](../fuse-compat.md) for the full sandbox matrix (gVisor / Codespaces / Fly Machines are blocked; Docker rootful / E2B / Hetzner VMs / Kata Containers / Apple Container / Cloudflare Containers all work).

## Mount command

```bash
agent-fs mount <mountpoint> [--remote] [--api-url <url>] [--api-key <key>] [--allow-other]
```

- Without `--remote`: requires `agent-fs daemon start` first; the helper talks to the local daemon on a Unix socket.
- With `--remote`: skips the local daemon entirely; the helper talks to the remote HTTP API.

## Auth (remote mode)

In remote mode the helper needs `AGENT_FS_API_URL` + `AGENT_FS_API_KEY`. Three sources, in precedence order:

1. **CLI flags** — `--api-url <url> --api-key <key>` (the key is forwarded as env to the helper, never on argv).
2. **Env vars** — `AGENT_FS_API_URL=...`, `AGENT_FS_API_KEY=...`.
3. **Config file** — `~/.agent-fs/config.json`:
   ```json
   {
     "apiUrl": "https://my-agent-fs.example.com",
     "apiKey": "afs_..."
   }
   ```

Verify creds before mounting:

```bash
agent-fs auth whoami
```

## Troubleshooting (top errors observed on fresh sandboxes)

These are the four most common errors hit during the 2026-05-18 sprite test. For the full catalogue (EIO, conflicts, transport-endpoint-disconnected, EROFS, etc.) see [`fuse-troubleshooting.md`](../fuse-troubleshooting.md).

### `mountpoint is not a directory`

The path you passed to `agent-fs mount` doesn't exist or is a file. Create the directory first:

```bash
mkdir -p ~/mnt
agent-fs mount ~/mnt --remote
```

### `fusermount3: command not found`

The `fuse3` package isn't installed.

```bash
# Debian / Ubuntu
sudo apt-get install -y fuse3

# Alpine
sudo apk add fuse3

# Fedora / RHEL
sudo dnf install -y fuse3
```

### `fuse: device not found` or `/dev/fuse: Permission denied`

The kernel FUSE device exists but isn't readable by the current user.

```bash
sudo chmod 666 /dev/fuse
```

Note: this is a band-aid for sandboxes. On a real host, prefer adding your user to the `fuse` group (or running the mount with the right capabilities).

### `option allow_other only allowed if 'user_allow_other' is set in /etc/fuse.conf`

The helper passes `allow_other` so other UIDs (root, agent supervisors) can read the mount. Enable it:

```bash
echo user_allow_other | sudo tee -a /etc/fuse.conf
```

### `fusermount3: failed to update /etc/mtab`

Some minimal images don't ship `/etc/mtab`. Symlink it to `/proc/mounts`:

```bash
sudo ln -sf /proc/mounts /etc/mtab
```

## Per-environment guides

| Environment | Doc | Status |
|---|---|---|
| Sprite (Linux sandboxes) | [`sprite.md`](./sprite.md) | Validated 2026-05-18 |
| E2B (Firecracker sandboxes) | [`e2b.md`](./e2b.md) | Untested — best-effort instructions |
| Hetzner Cloud VMs | [`hetzner.md`](./hetzner.md) | Validated approach (Ubuntu/Debian base) |

## See also

- [`fuse-mount.md`](../fuse-mount.md) — mount semantics, feedback surfaces, mount layout
- [`fuse-compat.md`](../fuse-compat.md) — sandbox compatibility per runtime
- [`fuse-troubleshooting.md`](../fuse-troubleshooting.md) — full error catalogue
- [`api-reference.md`](../api-reference.md) — CLI / MCP / HTTP surfaces
