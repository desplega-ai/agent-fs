# FUSE Sandbox Compatibility (agent-fs v1)

`agent-fs mount` exposes drives as a Linux FUSE filesystem. FUSE requires `/dev/fuse` and the `SYS_ADMIN` capability inside the container. Not every agent sandbox grants those, so this page documents what works, what doesn't, and the exact incantation per runtime.

> **Universal fallback**: the CLI / MCP / HTTP API paths are always available. If FUSE is blocked in your sandbox, fall back to `agent-fs write`, `agent-fs cat`, `agent-fs grep`, etc.

## TL;DR matrix

| Runtime | FUSE works? | Minimal incantation | Fallback |
|---|---|---|---|
| **Docker rootful** | Yes | `docker run --cap-add SYS_ADMIN --device /dev/fuse --security-opt apparmor=unconfined ...` | n/a |
| **Podman rootful** | Yes | Same as Docker rootful (`--cap-add SYS_ADMIN --device /dev/fuse`) | n/a |
| **Podman rootless** | Conditional | Run as UID-0 inside the userns; `--privileged` alone is insufficient ([podman#13449](https://github.com/containers/podman/issues/13449)) | CLI / MCP |
| **Kubernetes — privileged PSS** | Yes | `securityContext: { privileged: true }` or `capabilities.add: [SYS_ADMIN]` + `/dev/fuse` device | n/a |
| **Kubernetes — baseline PSS** | Conditional | Explicitly `capabilities.add: [SYS_ADMIN]` + device-plugin / hostPath for `/dev/fuse` | CLI / MCP |
| **Kubernetes — restricted PSS** | No (use CSI sidecar) | See [GCS FUSE CSI driver](https://github.com/GoogleCloudPlatform/gcs-fuse-csi-driver) pattern — privileged init opens `/dev/fuse`, hands FD to unprivileged sidecar | CLI / MCP via init container |
| **GKE Autopilot** | No (managed only) | Cluster-managed FUSE only via Google's CSI driver — users can't mount arbitrary FUSE FSes | CLI / MCP |
| **Cloudflare Containers** | Yes (since 2025-11) | Install FUSE binary in image, mount at startup; platform exposes `/dev/fuse` | n/a |
| **Apple Container (macOS)** | Yes | Each container is a full Linux VM — FUSE behaves like any in-guest Linux mount | n/a |
| **E2B sandboxes** | Yes | Firecracker with `CONFIG_FUSE_FS=y`. `e2b connect-bucket` auto-installs FUSE helpers | n/a |
| **Kata Containers** | Yes | virtio-fs default + in-guest FUSE works when `SYS_ADMIN` granted | n/a |
| **gVisor (runsc)** | **No** | Sentry has stub FUSE only ([#2752](https://github.com/google/gvisor/issues/2752), [#2753](https://github.com/google/gvisor/issues/2753)) — affects GKE Sandbox, Cloud Run gen1 | CLI / MCP |
| **GitHub Codespaces (hosted)** | **No** | Hosted env ignores `--device` in devcontainer config ([community#163129](https://github.com/orgs/community/discussions/163129)) | CLI / MCP |
| **Modal sandboxes** | **No** | Modal uses FUSE internally; user code has no `/dev/fuse` access | CLI / MCP |
| **Fly.io Machines (Firecracker)** | **No** | Default Fly kernel does not have `CONFIG_FUSE_FS=y` ([community#649](https://community.fly.io/t/include-fuse-module-in-the-kernel-of-the-vm/649)) | CLI / MCP |

> **Last checked**: 2026-05. Sandboxes change quickly — file an issue if you hit a fresh blocker.

---

## Per-runtime incantations

### Docker rootful (the canonical case)

```bash
docker run -d \
  --name agent-fs-runner \
  --cap-add SYS_ADMIN \
  --device /dev/fuse \
  --security-opt apparmor=unconfined \
  -v "$PWD":/work \
  -w /work \
  ubuntu:24.04 \
  tail -f /dev/null

# Inside the container:
docker exec -it agent-fs-runner bash
apt-get update && apt-get install -y fuse3
# install agent-fs (Linux x64): bun install -g @desplega.ai/agent-fs
agent-fs daemon start
agent-fs mount /mnt/agent-fs
```

**Gotchas**

- `--security-opt apparmor=unconfined` is required on Ubuntu hosts because the default AppArmor profile blocks `/dev/fuse` access for containerised processes. On Docker Desktop (Darwin) it's harmless.
- `--cap-add MKNOD` is sometimes also recommended; in practice `SYS_ADMIN` covers it.

### Podman rootful

Identical to Docker. Use `--security-opt label=disable` instead of AppArmor when SELinux is the host MAC system.

### Podman rootless

You must be root *inside the userns* for `SYS_ADMIN` to actually grant FUSE. `--privileged` is not enough ([podman#13449](https://github.com/containers/podman/issues/13449)). If you're using Podman rootless, prefer the CLI / MCP fallback.

### Kubernetes — privileged

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: agent-fs
spec:
  containers:
    - name: agent
      image: my-agent-image:latest
      securityContext:
        privileged: true   # OR capabilities: { add: [SYS_ADMIN] }
      volumeMounts:
        - name: fuse-device
          mountPath: /dev/fuse
  volumes:
    - name: fuse-device
      hostPath:
        path: /dev/fuse
        type: CharDevice
```

### Kubernetes — baseline PSS

```yaml
securityContext:
  capabilities:
    add: [SYS_ADMIN]
```

Plus a device plugin or hostPath for `/dev/fuse`. The pod will be admitted under the **baseline** Pod Security Standard but rejected under **restricted**.

### Kubernetes — restricted PSS

Direct FUSE mounts are not possible. The supported pattern is the [GCS FUSE CSI driver](https://github.com/GoogleCloudPlatform/gcs-fuse-csi-driver) / [meta-fuse-csi-plugin](https://github.com/pfnet-research/meta-fuse-csi-plugin) shape:

1. A privileged CSI node-driver opens `/dev/fuse` and hands the FD to an unprivileged sidecar.
2. The sidecar runs the FUSE daemon (our Rust helper, in a future v1.x adapter).
3. The workload pod mounts the FUSE FS as a volume — no caps needed.

**Status for agent-fs**: v1 does not ship a CSI adapter. Tracked as a v1.x deliverable in the plan appendix.

### Cloudflare Containers

Native FUSE support since [2025-11-21](https://developers.cloudflare.com/changelog/post/2025-11-21-fuse-support-in-containers/). Install the FUSE helper in your Dockerfile and mount at startup; the platform handles the device. See the [r2-fuse-mount example](https://developers.cloudflare.com/containers/examples/r2-fuse-mount/).

### Apple Container (macOS)

Each container is a full Linux VM (WWDC 2025 announcement). FUSE works in-guest like any Linux VM. macFUSE 5.1.0 / fuse-t are host-side concerns and do not affect in-guest behavior.

### E2B

First-class FUSE — Firecracker kernel ships `CONFIG_FUSE_FS=y`. Use `e2b.dev` directly, or install `agent-fs` and run `agent-fs mount` like any Linux host. The E2B `connect-bucket` API auto-installs `s3fs`/`gcsfuse`/R2 helpers; ours is direct.

### Kata Containers

virtio-fs is the default sharing mechanism since Kata 2.0; in-guest FUSE also works when `SYS_ADMIN` is granted. See [kata-containers virtio-fs guide](https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/how-to-use-virtio-fs-with-kata.md).

---

## Where FUSE is blocked

### gVisor (runsc)

Practical status: **broken for our use case.** The gVisor sentry has a stub FUSE client only — [#2752](https://github.com/google/gvisor/issues/2752) and [#2753](https://github.com/google/gvisor/issues/2753) have been open since 2020. The "Setting up FUSE" boot message is internal scaffolding, not user-mountable. Affects:

- GKE Sandbox (workloads with `runtimeClassName: gvisor`)
- Cloud Run gen1
- Several agent platforms that use gVisor for tenant isolation

Use the CLI / MCP path instead.

### GitHub Codespaces (hosted)

Codespaces ignores devcontainer `mounts` / `runArgs` for `--device` in the hosted environment. See [community#163129](https://github.com/orgs/community/discussions/163129). **Local** VS Code Dev Containers can pass `--device /dev/fuse` fine.

### Modal sandboxes

Modal uses FUSE internally for its lazy-loading image filesystem, but [user code has no privileges](https://modal.com/docs/guide/sandboxes) to interact with `/dev/fuse`. No public path to mount user FUSE FSes.

### Fly.io Machines

Default Fly kernel does not have `CONFIG_FUSE_FS=y`. LiteFS works because Fly ships LiteFS-specific kernel support. See [community#649](https://community.fly.io/t/include-fuse-module-in-the-kernel-of-the-vm/649). Practical conclusion: agent-fs FUSE won't run on Fly Machines without Fly-side changes.

---

## See also

- [`fuse-mount.md`](./fuse-mount.md) — how to use the mount once it's up
- [`fuse-troubleshooting.md`](./fuse-troubleshooting.md) — common errors + fixes
- Original research with sources: [`thoughts/taras/research/2026-05-15-fuse-sandbox-compat.md`](../thoughts/taras/research/2026-05-15-fuse-sandbox-compat.md)
