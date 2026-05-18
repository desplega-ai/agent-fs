# Mounting agent-fs on Sprite

Sprite sandboxes are Linux containers (Ubuntu 25.10 base as of 2026-05-18). They can mount FUSE but require four one-time prerequisites because the base image is minimal.

> See [`README.md`](./README.md) for the general overview and architecture.

## Prerequisites

Run these four commands inside the sprite before mounting:

```bash
sudo apt-get update -qq && sudo apt-get install -y fuse3
sudo chmod 666 /dev/fuse
sudo ln -sf /proc/mounts /etc/mtab
echo user_allow_other | sudo tee -a /etc/fuse.conf
```

Each step is necessary:

| Step | Why |
|---|---|
| `apt-get install fuse3` | `fusermount3` + libfuse3 are not in the sprite base image. |
| `chmod 666 /dev/fuse` | Default perms on the sprite are `c-w--wx-wT`, unreadable for the non-root `sprite` user. |
| `ln -sf /proc/mounts /etc/mtab` | `/etc/mtab` is absent; `fusermount3` errors out trying to update the mount table. |
| `user_allow_other` | The helper passes `allow_other` so other UIDs (supervisors) can read the mount. |

### One-liner idempotent script

```bash
#!/usr/bin/env bash
# Apply all four agent-fs mount prereqs. Safe to re-run.
set -euo pipefail

sudo apt-get update -qq
sudo apt-get install -y fuse3
sudo chmod 666 /dev/fuse
[ -e /etc/mtab ] || sudo ln -sf /proc/mounts /etc/mtab
grep -q '^user_allow_other' /etc/fuse.conf 2>/dev/null \
  || echo user_allow_other | sudo tee -a /etc/fuse.conf
echo "agent-fs mount prereqs applied."
```

Save as `prereqs.sh`, then `chmod +x prereqs.sh && ./prereqs.sh`.

> Sprite envs do not persist these changes across fresh sprite creations. Re-run the script every time you spin up a new sprite.

## Install + mount

```bash
# 1. Install the CLI (pulls the right FUSE sub-package via optionalDependencies).
# Sprite ships Bun pre-installed; use it. `npm install -g` against the stock
# Node aborts on a transitive dep's postinstall syntax.
bun install -g @desplega.ai/agent-fs

# 2. Configure auth (writes ~/.agent-fs/config.json).
mkdir -p ~/.agent-fs
cat > ~/.agent-fs/config.json <<EOF
{
  "apiUrl": "https://agent-fs-taras.fly.dev",
  "apiKey": "<YOUR_API_KEY>"
}
EOF

# 3. Verify auth.
agent-fs auth whoami

# 4. Make a mount point and mount in remote mode.
mkdir -p ~/mnt
agent-fs mount ~/mnt --remote
```

## Verify

```bash
ls ~/mnt
ls ~/mnt/current
echo "hello from sprite $(date)" > ~/mnt/current/sprite-test.txt
cat ~/mnt/current/sprite-test.txt
rm ~/mnt/current/sprite-test.txt
```

## Unmount

```bash
fusermount3 -u ~/mnt
```

## Known issues

- **Writes return `EACCES` if you used a sprite-local daemon without an S3 backend.** Use `--remote` against a hosted instance instead — the FUSE plumbing itself works fine.
- **`fusermount3: failed to access mountpoint`** — your mount path doesn't exist (`mkdir -p ~/mnt` first).
- See [`fuse-troubleshooting.md`](../fuse-troubleshooting.md) for the full error catalogue.

## See also

- [`README.md`](./README.md) — overview and shared prerequisites
- [`fuse-mount.md`](../fuse-mount.md) — mount semantics
- [`fuse-troubleshooting.md`](../fuse-troubleshooting.md) — full error catalogue
