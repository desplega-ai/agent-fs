# agent-fs FUSE Troubleshooting

This page maps the most common errors you'll see when running `agent-fs mount` to their root cause and fix.

## `Input/output error` (`EIO`)

**Symptom**: A write returns `cat: foo.md: Input/output error` or `close: EIO`.

**Diagnosis order** (do these in sequence):

1. **Check daemon-link status**:
   ```bash
   cat /mnt/agent-fs/.agent-fs/status
   ```
   Look for `daemon: "down"` or `daemon: "auth_error"`. If the daemon is down, restart it:
   ```bash
   agent-fs daemon start
   ```
   The FUSE process stays alive across daemon restarts — you don't need to remount.

2. **Read the most recent error**:
   ```bash
   tail -1 /mnt/agent-fs/.agent-fs/errors.ndjson
   ```
   This is a JSON object with `{ ts, path, op, http_status, error }`. The `http_status` tells you whether it was a 4xx (auth / validation), a 409 (conflict), or a 5xx (server / S3).

3. **For conflicts**, look at `conflicts.ndjson`:
   ```bash
   tail -1 /mnt/agent-fs/.agent-fs/conflicts.ndjson
   ```
   `EIO` after a conflict is *expected* — exactly one of N concurrent writers gets it. The winner's bytes are on disk and a new version is recorded; the losers get `EIO`. Use `--expected-version` on the CLI for explicit OCC.

4. **For unexplained `EIO`**, check the mount log:
   ```bash
   tail -50 ~/.agent-fs/mount.log
   ```
   The helper logs one line per FUSE callback. Look for the `op=` line that immediately precedes your error and the HTTP status it returned.

## `fusermount: mount failed: Operation not permitted`

**Cause**: The container or sandbox lacks `SYS_ADMIN` and/or `/dev/fuse`.

**Fix**: Add the capability and device flag (Docker example):

```bash
docker run \
  --cap-add SYS_ADMIN \
  --device /dev/fuse \
  --security-opt apparmor=unconfined \
  ...
```

See [`fuse-compat.md`](./fuse-compat.md) for per-runtime incantations. If you're in a sandbox that blocks FUSE entirely (gVisor / GitHub Codespaces hosted / Fly Machines / Modal), fall back to the CLI / MCP / HTTP API path — they always work.

## `Transport endpoint is not connected`

**Cause**: The daemon stopped (or crashed) while the mount was up. The kernel still has the FUSE FS in its mount table but there's nobody on the other end of the socket.

**Fix**:

1. Restart the daemon:
   ```bash
   agent-fs daemon start
   ```
2. The mount usually auto-recovers on next operation. If not, unmount and remount:
   ```bash
   agent-fs umount /mnt/agent-fs
   agent-fs mount /mnt/agent-fs
   ```

If `agent-fs umount` itself fails with "transport endpoint is not connected", use the kernel-level escape hatch:

```bash
fusermount3 -u /mnt/agent-fs
# or, as last resort:
sudo umount -l /mnt/agent-fs   # lazy unmount
```

## `agent-fs-fuse: command not found`

**Cause**: The helper binary wasn't installed or isn't on `PATH`. The main npm package resolves it from `optionalDependencies` (per-platform sub-package); on non-Linux platforms it's intentionally absent.

**Fix** (in order of preference):

1. **Confirm you're on Linux**: `uname -s` should say `Linux`. macOS / Windows have no FUSE helper in v1.

2. **Reinstall the main package** so the right optional dependency is resolved. Prefer Bun's installer — `npm install -g` against stock Ubuntu/Debian Node 18.x aborts on a transitive dep's postinstall (`SyntaxError: Unexpected token 'with'`) before the binary lands:
   ```bash
   bun install -g @desplega.ai/agent-fs
   # Check the sub-package landed:
   ls "$(bun pm -g bin)/../install/global/node_modules/@desplega.ai/agent-fs-fuse-linux-"*/bin/agent-fs-fuse
   ```
   With npm (Node 20+ required): `ls $(npm root -g)/@desplega.ai/agent-fs-fuse-linux-*/bin/agent-fs-fuse`

3. **Use the `AGENT_FS_FUSE_BIN` env override** for local dev or unusual install layouts:
   ```bash
   export AGENT_FS_FUSE_BIN="$HOME/code/agent-fs/packages/fuse-helper/target/release/agent-fs-fuse"
   agent-fs mount /mnt/agent-fs
   ```

4. **Check the SHA-256 manifest** if the binary exists but the daemon refuses to spawn it: a tampered binary will fail the integrity check. Reinstall the sub-package or contact us if you suspect a supply-chain issue.

## Mount succeeds but `ls /mnt/agent-fs/` is empty

**Cause**: The API key the daemon is using has no drives accessible.

**Fix**:

```bash
agent-fs auth whoami        # confirm you're logged in
agent-fs drive list         # confirm you have at least one drive
```

If `drive list` is empty, you need to register/onboard:

```bash
agent-fs onboard -y
```

## `EROFS: Read-only file system` when creating a directory at the mount root

**Expected.** The mount root is read-only. Drives are managed via the CLI:

```bash
agent-fs drive create new-drive
ls /mnt/agent-fs/   # the new drive appears on next readdir
```

## `Function not implemented` from `flock` or `fcntl`

**Expected.** POSIX file locks are not implemented in v1 (`ENOSYS`). For optimistic concurrency, use `--expected-version` on the CLI:

```bash
agent-fs write config.json --content '{}' --expected-version 3
```

## Mount works, but `mv` across drives fails

**Expected.** `mv` across drives requires a server-side copy + delete (different S3 prefixes). In v1 the mount returns `EXDEV` for cross-drive renames, which is the standard POSIX signal for "you need to fall back to `cp` + `rm`". Most `mv` implementations (GNU coreutils, busybox) handle `EXDEV` automatically by switching to copy mode.

## Performance: large directory listings are slow

The mount caches `readdir` results for 30 seconds. A first-time `ls` on a directory with thousands of entries can take a few hundred ms while the helper fetches metadata. Subsequent `ls`es within the TTL are served from cache.

If you need a faster first listing, use `agent-fs ls --json` directly — the CLI uses the same underlying op but skips the FUSE layer.

## Reporting bugs

If you hit something not covered here, please include:

1. `agent-fs --version` (and the helper version: `agent-fs-fuse --version`)
2. Kernel + distro: `uname -a` and `cat /etc/os-release`
3. The container runtime + flags (the `docker run` line, the Pod spec, etc.)
4. `tail -200 ~/.agent-fs/mount.log` and `cat /mnt/agent-fs/.agent-fs/status`
5. The exact command that triggered the error and the full error text

Open an issue at <https://github.com/desplega-ai/agent-fs>.

## See also

- [`fuse-mount.md`](./fuse-mount.md) — how the mount works conceptually
- [`fuse-compat.md`](./fuse-compat.md) — sandbox compatibility per runtime
