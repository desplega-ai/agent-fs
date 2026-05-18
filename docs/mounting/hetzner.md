# Mounting agent-fs on Hetzner Cloud VMs

Hetzner Cloud VMs (Ubuntu/Debian) are the cleanest target for `agent-fs mount`: root access, `/dev/fuse` available out of the box, no sandbox restrictions. The full happy path is four commands.

> See [`README.md`](./README.md) for the general overview and architecture.

## Prerequisites

A Hetzner Cloud Ubuntu 24.04 or Debian 12 server. The `fuse3` package is missing from the base image but `/dev/fuse` is already accessible.

```bash
# Provision (host side, with hcloud CLI)
hcloud server create \
  --name agent-fs-host \
  --image ubuntu-24.04 \
  --type cx22 \
  --ssh-key <your-key>

ssh root@$(hcloud server ip agent-fs-host)
```

## Install + mount

Inside the VM:

```bash
# 1. Install fuse3.
apt-get update -qq && apt-get install -y fuse3 curl

# 2. Install Bun + agent-fs.
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun install -g @desplega.ai/agent-fs

# 3. Configure auth.
mkdir -p ~/.agent-fs
cat > ~/.agent-fs/config.json <<EOF
{
  "apiUrl": "https://agent-fs-taras.fly.dev",
  "apiKey": "<YOUR_API_KEY>"
}
EOF

# Or via env (preferred for systemd units):
# export AGENT_FS_API_URL=https://agent-fs-taras.fly.dev
# export AGENT_FS_API_KEY=...

# 4. Verify auth + mount.
agent-fs auth whoami
mkdir -p /mnt/agent-fs
agent-fs mount /mnt/agent-fs --remote
```

## Verify

```bash
ls /mnt/agent-fs
ls /mnt/agent-fs/current
echo "hello from hetzner $(date)" > /mnt/agent-fs/current/hetzner-test.txt
cat /mnt/agent-fs/current/hetzner-test.txt
rm /mnt/agent-fs/current/hetzner-test.txt
```

## Unmount

```bash
fusermount3 -u /mnt/agent-fs
```

## Auto-mount on boot (systemd)

To mount agent-fs automatically at boot, drop a systemd unit:

```ini
# /etc/systemd/system/agent-fs-mount.service
[Unit]
Description=agent-fs FUSE mount (remote)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=AGENT_FS_API_URL=https://agent-fs-taras.fly.dev
Environment=AGENT_FS_API_KEY=<YOUR_API_KEY>
Environment=PATH=/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStartPre=/bin/mkdir -p /mnt/agent-fs
ExecStart=/root/.bun/bin/agent-fs mount /mnt/agent-fs --remote
ExecStop=/usr/bin/fusermount3 -u /mnt/agent-fs
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

Activate:

```bash
systemctl daemon-reload
systemctl enable --now agent-fs-mount.service
systemctl status agent-fs-mount.service
```

**Security note**: putting `AGENT_FS_API_KEY` directly in the unit file is convenient but readable by anyone with root. Prefer `EnvironmentFile=/etc/agent-fs.env` with `chmod 600 /etc/agent-fs.env`, or use systemd credentials (`LoadCredential=`) on systemd 250+.

## Known issues

- **`user_allow_other` is not required** on stock Hetzner Ubuntu/Debian images because root is the mounting user. If you mount as a non-root user and need other UIDs to read the mount, add `user_allow_other` to `/etc/fuse.conf`.
- **Firewall**: outbound HTTPS (443) must be open to reach the remote agent-fs API. Hetzner's default firewall allows this; check your custom rules if mount stalls.
- See [`fuse-troubleshooting.md`](../fuse-troubleshooting.md) for the full error catalogue.

## See also

- [`README.md`](./README.md) — overview and shared prerequisites
- [`fuse-mount.md`](../fuse-mount.md) — mount semantics
- [`fuse-troubleshooting.md`](../fuse-troubleshooting.md) — full error catalogue
