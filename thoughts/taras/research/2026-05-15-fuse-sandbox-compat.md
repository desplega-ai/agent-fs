---
date: 2026-05-15
author: Claude (bg research)
topic: "FUSE compatibility across agent sandboxes (2026)"
tags: [research, agent-fs, fuse, sandboxes, docker, kubernetes]
parent_brainstorm: thoughts/taras/brainstorms/2026-05-15-agent-fs-as-linux-filesystem.md
status: complete
---

# FUSE compatibility across agent sandboxes (2026)

## Executive summary

FUSE works in most agent runtimes that hand you root inside a Linux container with `--cap-add SYS_ADMIN --device /dev/fuse` (Docker rootful, Podman rootful, K8s "privileged"/"baseline", Cloudflare Containers, Apple Container, Kata, rootful dev containers, Daytona w/ custom image). It does NOT work where the platform owns `/dev/fuse` and won't expose it to user code: gVisor (sentry FUSE is host-stub only — no `mount` of arbitrary FUSE FSes), K8s `restricted` PSS, GitHub Codespaces (no mount caps in the remote env), Modal sandboxes (FUSE is internal-only, not user-exposed), Fly Machines (FUSE not in default kernel — kernel-arg/custom kernel needed). Rootless FUSE in 2026 is viable on Linux ≥ 5.11 inside a user namespace (`unshare -Urm` + `fusermount3` setuid), but most managed sandboxes block userns creation. virtio-fs is an interesting end-run: the host runs the FUSE server, the guest just mounts it — no `/dev/fuse` exposure to the workload — but it requires platform cooperation.

**Biggest single adoption blocker: gVisor + restricted-PSS Kubernetes are the dominant agent-sandbox substrate (Cloud Run, Vertex Agent Engine, GKE Sandbox, many in-house) and neither lets you mount FUSE today.**

## Compatibility Matrix

| Runtime | FUSE? | Incantation / Blocker | Last checked |
|---|---|---|---|
| Docker rootful | Yes | `docker run --cap-add SYS_ADMIN --device /dev/fuse [--security-opt apparmor:unconfined]` | 2026-02 |
| Docker rootless | Conditional | Host needs `/dev/fuse`; container needs same `--cap-add SYS_ADMIN --device /dev/fuse`. Works but inherits userns constraints. On kernel ≥ 5.11 native overlay removes one fuse-overlayfs dep. | 2026-01 |
| Podman rootful | Yes | Same as Docker rootful | 2026-03 |
| Podman rootless | Conditional | `--privileged` does NOT grant `SYS_ADMIN` to non-UID-0 in rootless (issue #13449). Must use unprivileged-userns FUSE path or run inside a userns where you're root. | 2025 |
| K8s — privileged PSS | Yes | `securityContext: {privileged: true}` or `capabilities.add: [SYS_ADMIN]` + manual `/dev/fuse`. | 2026 |
| K8s — baseline PSS | Conditional | `SYS_ADMIN` allowed if explicitly added; `/dev/fuse` requires device plugin or hostPath. | 2026 |
| K8s — restricted PSS | No | `SYS_ADMIN` forbidden; `allowPrivilegeEscalation: false` blocks deploy. Workaround: CSI sidecar that does the mount in a privileged init then bind-shares. Or 1.33+ userns (`hostUsers: false`) to safely grant SYS_ADMIN. | 2026-04 (K8s 1.33, Apr 2025) |
| GKE Autopilot | Conditional | Cluster-managed FUSE only via GCS FUSE CSI driver (sidecar pattern, unprivileged workload pod). User can't mount their own FUSE. | 2026 |
| GitHub Codespaces / devcontainers (remote) | No | Bind mounts and device flags don't take effect in Codespaces remote env. Local devcontainer can pass `--device /dev/fuse`. | 2026 |
| Fly.io Machines (Firecracker) | No (default) | Default Fly kernel does NOT have `CONFIG_FUSE_FS=y`. LiteFS works because Fly ships a custom kernel for it. User images can't get FUSE without Fly enabling it or shipping a custom kernel (limited support). | 2025-Q4 |
| Modal sandboxes | No (user-facing) | Modal uses FUSE internally for lazy image loading, but user code in sandboxes has no privileges and no `/dev/fuse` access. No documented user mount capability. | 2025-09 |
| E2B sandboxes | Yes | Native support — `s3fs`, `gcsfuse`, R2 via FUSE. Bucket mount API auto-installs tools at runtime. Firecracker-based, FUSE explicitly enabled. | 2026 |
| Daytona workspaces | Conditional | Built-in volumes are FUSE-backed (S3) but limited (`mv`, `touch`, `stat` broken per issue #3331). User custom images: standard Docker, but no public confirmation of `--cap-add SYS_ADMIN` in managed mode. | 2026-01 |
| Cloudflare Containers | Yes | Native FUSE support shipped 2025-11-21. Install `tigrisfs`/`s3fs`/`gcsfuse` in Dockerfile, mount at startup. Platform handles `/dev/fuse`. | 2025-11 |
| Apple Container (macOS) | Yes (Linux side) | One-VM-per-container, full Linux kernel — FUSE works in-guest like any Linux VM. macFUSE 5.1.0 (Oct 2025) on host side via FSKit. | 2026-03 |
| Firecracker generally | Conditional | `CONFIG_FUSE_FS=y` NOT set in default microvm-kernel config — must rebuild kernel. | 2025 |
| Kata Containers | Yes | virtio-fs is default since Kata 2.0; in-guest FUSE also supported with `SYS_ADMIN`. | 2025 |
| gVisor (runsc) | No | Sentry has a stub FUSE client (issues #2752/#2753 from 2020, still incomplete). `/dev/fuse` is a stub. Mounting arbitrary FUSE FSes inside a runsc sandbox is not supported. Confirmed by gVisor compatibility docs. | 2026 |

## Per-runtime notes

### Docker / Podman
Canonical: `--cap-add SYS_ADMIN --cap-add MKNOD --device /dev/fuse [--security-opt apparmor:unconfined]`. AppArmor on Ubuntu hosts is the common gotcha. Source: [docker/for-linux #321](https://github.com/docker/for-linux/issues/321), [oneuptime guide 2026](https://oneuptime.com/blog/post/2026-02-08-how-to-mount-azure-blob-storage-as-a-docker-volume/view).

Rootless Podman quirk: [podman #13449](https://github.com/containers/podman/issues/13449) — `--privileged` doesn't actually give `SYS_ADMIN` to non-UID-0 processes; you need to be UID-0 inside the userns.

### Kubernetes
- `restricted` PSS forbids `SYS_ADMIN` and `allowPrivilegeEscalation`. [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/).
- K8s 1.33 (Apr 2025) made user namespaces opt-in via `hostUsers: false` — pods can safely receive `SYS_ADMIN` because it's scoped to the userns. [CNCF blog](https://www.cncf.io/blog/2025/07/16/securing-kubernetes-1-33-pods-the-impact-of-user-namespace-isolation/).
- "Two-step mount" pattern (GCS FUSE CSI): privileged CSI node-driver opens `/dev/fuse` and hands the FD to an unprivileged sidecar that runs the FUSE daemon. The workload pod is unprivileged. [Preferred Networks blog](https://tech.preferred.jp/en/blog/meta-fuse-csi-plugin/), [GCS FUSE CSI](https://github.com/GoogleCloudPlatform/gcs-fuse-csi-driver). This is the right pattern for agent-fs in a managed-K8s context.

### GitHub Codespaces
Codespaces ignores devcontainer `mounts` / `runArgs` for `--device` in the hosted environment. [community #163129](https://github.com/orgs/community/discussions/163129). Local VS Code dev containers can pass `--device /dev/fuse` fine.

### Fly.io Machines (Firecracker)
Fly provides the kernel; you can pass `--kernel-arg` but cannot ship your own (with narrow exceptions). FUSE module is NOT compiled in by default. [community #649 (2021)](https://community.fly.io/t/include-fuse-module-in-the-kernel-of-the-vm/649), still the canonical thread; default kernel bumped to 5.15 in 2023 but no public confirmation FUSE was enabled. LiteFS works because Fly ships LiteFS-specific kernel support. Practical conclusion: agent-fs FUSE won't run on Fly Machines without Fly-side change.

### Modal
Modal uses FUSE internally for its lazy-loading image filesystem. Sandboxes have "no credentials or privileges to interact with the rest of your Modal ecosystem" by default. No public docs surface `/dev/fuse` to user code. [Modal Sandboxes guide](https://modal.com/docs/guide/sandboxes), [Amplify deep-dive](https://www.amplifypartners.com/blog-posts/behind-the-scenes-of-modal-sandboxes).

### E2B
First-class FUSE. `e2b.dev` Connect-bucket API auto-installs `s3fs`/`gcsfuse`/R2 helpers at mount time. [E2B connect-bucket docs](https://e2b.dev/docs/sandbox/connect-bucket). Firecracker-based but with FUSE explicitly enabled in the guest kernel.

### Daytona
Built-in FUSE volumes exist but have functional gaps — [daytonaio/daytona #3331](https://github.com/daytonaio/daytona/issues/3331) reports `mv`, `touch`, `stat` broken. For our own FUSE driver, no public statement on whether custom images get `SYS_ADMIN`. [Daytona images docs](https://www.daytona.io/docs/images/) imply standard OCI but managed deployment likely strips caps.

### Cloudflare Containers
Shipped FUSE support 2025-11-21. [Changelog](https://developers.cloudflare.com/changelog/post/2025-11-21-fuse-support-in-containers/), [r2-fuse-mount example](https://developers.cloudflare.com/containers/examples/r2-fuse-mount/). Platform handles the device exposure; you just install the FUSE binary in your image and run it at startup. This is the cleanest "agent-fs as a container" target.

### Apple Container
WWDC 2025 launch, one-VM-per-container model. Each container is a full Linux VM, so in-guest FUSE behaves like any Linux VM. macFUSE 5.1.0 / fuse-t are macOS-host concerns, separate from in-guest behavior. [Apple Containerization announcement](https://www.infoq.com/news/2025/06/apple-container-linux/).

### Firecracker (raw)
[Kernel policy](https://github.com/firecracker-microvm/firecracker/blob/main/docs/kernel-policy.md). Default `microvm-kernel-ci-*.config` has `CONFIG_FUSE_FS` unset. Anyone building on Firecracker (Fly, Modal, E2B) must rebuild the kernel with `CONFIG_FUSE_FS=y` to support FUSE.

### Kata Containers
virtio-fs is the default sharing mechanism since Kata 2.0 [docs](https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/how-to-use-virtio-fs-with-kata.md). In-guest FUSE also works when capabilities are granted.

### gVisor
Practical status: **broken for our use case.** [google/gvisor #2752](https://github.com/google/gvisor/issues/2752) "Implement /dev/fuse" and [#2753](https://github.com/google/gvisor/issues/2753) "Mount a trivial FUSE filesystem" — opened 2020, the sentry has a stub FUSE client only. The "Setting up FUSE" boot message is internal scaffolding, not user-mountable. Google's [compatibility doc](https://gvisor.dev/docs/user_guide/compatibility/) lists FUSE as not generally supported. This matters because GKE Sandbox, Cloud Run gen1, and several agent platforms use gVisor.

## Rootless FUSE story in 2026

- Linux merged "fuse: Allow fully unprivileged mounts" ([torvalds/linux@4ad769f](https://github.com/torvalds/linux/commit/4ad769f3c346ec3d458e255548dec26ca5284cf6), kernel ≥ 4.18). A root user *inside a user namespace* can `mount(2)` a FUSE FS. So `unshare -Urm` + libfuse3 = unprivileged mount on modern kernels.
- Practical recipe: setuid `fusermount3` (still standard on Ubuntu/Debian/Alpine) — or run libfuse in a userns where the user is "root" and mount directly.
- `allow_other` is restricted to descendant userns to plug the security hole. For agent-fs single-tenant-per-sandbox use, this is fine.
- **Caveat**: many managed sandboxes block `unshare(CLONE_NEWUSER)` outright (seccomp), or run unprivileged seccomp profiles that forbid `mount(2)` regardless of userns. So "rootless FUSE exists" but won't save us in restricted-PSS K8s, gVisor, Codespaces, or default Modal.
- `fuse2fs` vs `fuse3`: `fuse2fs` is a specific extfs-image driver built on libfuse, not a libfuse version. We want libfuse3 (the current generation). Alpine ships [`fuse3-static`](https://pkgs.alpinelinux.org/package/edge/main/x86/fuse3-static) for static binary linking.

## fuse-overlayfs

Not relevant to agent-fs as a filesystem. It's a container-image-layering tool used by rootless Docker/Podman to substitute for kernel overlayfs on pre-5.11 kernels. Don't confuse it with FUSE mounting in general. We don't need overlay semantics — we want a userspace fileserver-backed mount.

## Static binary with elevated caps — realistic?

Yes, technically: build a self-contained Go/Rust binary that links libfuse3 statically (Alpine's `fuse3-static`, or vendored). Then either:
1. Setcap `cap_sys_admin+ep` on the binary on first install (works on Linux ≥ 2.6.24 with file caps). **But** capabilities are dropped on `execve` from non-root in many container configs, and many sandboxes mount `/` `nosuid`.
2. Setuid root on the helper, like `fusermount3` itself does. Same restrictions apply.
3. **Realistic for sandboxes**: bundle a static `fusermount3` + our FUSE daemon, accept that we still need `CAP_SYS_ADMIN` somewhere — getting it from the platform is the only path. There's no kernel magic that turns it off.

## Routes that avoid `SYS_ADMIN`

1. **virtio-fs adapter** — host runs the FUSE server (`virtiofsd`), guest just does an ordinary `mount -t virtiofs`. The workload needs neither `/dev/fuse` nor `SYS_ADMIN` beyond what a regular mount needs. This is exactly Kata's design and where serverless filesystem proxies are heading. For us this means: instead of shipping a FUSE driver to the agent, we could ship a *virtio-fs server* to the sandbox host. Only works where we control the hypervisor (so: our own infra, partnerships with E2B/Fly/Modal).
2. **CSI sidecar pattern** (K8s) — privileged init container opens `/dev/fuse`, passes FD to unprivileged sidecar that runs the FUSE daemon, bind-shared into the workload. The workload pod is restricted-PSS compliant. [meta-fuse-csi-plugin](https://tech.preferred.jp/en/blog/meta-fuse-csi-plugin/) and the [GCS FUSE CSI driver](https://github.com/GoogleCloudPlatform/gcs-fuse-csi-driver) demonstrate this works in production.
3. **NFS / 9p / SMB instead** — serve agent-fs as an NFSv4 server; let agents mount it with `mount -t nfs4`. Most agent sandboxes still won't let unprivileged code call `mount(2)`, but in-VM (Fly, Modal) where you have root in your microVM, this is easier than rebuilding the kernel for FUSE. Trade-off: NFS has poor `unlink`/rename semantics and worse cache control.
4. **Userns trick** — `unshare -Urm` + libfuse where the kernel allows it. Blocked by seccomp on most managed platforms.

## Strategies for FUSE-forbidden sandboxes

- **Don't try to mount.** Ship agent-fs as an HTTP/MCP API + a small CLI shim (`afs cat`, `afs grep`). Most agents already use tools, not raw `cat`. This is the lowest-friction path and works everywhere.
- **Where we control the host (E2B partnership, Cloudflare Containers, Apple Container, dedicated Fly app)**: ship a real FUSE mount.
- **K8s production**: ship a CSI driver with the two-step mount pattern. Workload pods stay restricted-PSS compliant.
- **gVisor / Modal / Codespaces**: rely on the API-only path. Document that `mount` won't work and that's expected.
- **Fly.io**: lobby Fly to flip `CONFIG_FUSE_FS=y` (cheap kernel change, no security impact for their model) or accept Fly is API-only.

## Sources

- [Docker FUSE issue #321](https://github.com/docker/for-linux/issues/321)
- [Docker rootless docs](https://docs.docker.com/engine/security/rootless/)
- [Podman rootless overlay (Red Hat)](https://www.redhat.com/en/blog/podman-rootless-overlay)
- [Podman #13449 — rootless privileged ≠ SYS_ADMIN](https://github.com/containers/podman/issues/13449)
- [K8s Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
- [CNCF: K8s 1.33 user namespace isolation (2025-07)](https://www.cncf.io/blog/2025/07/16/securing-kubernetes-1-33-pods-the-impact-of-user-namespace-isolation/)
- [kubernetes/kubernetes #79265 — FUSE pod sys_admin apparmor](https://github.com/kubernetes/kubernetes/issues/79265)
- [GCS FUSE CSI driver docs](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/cloud-storage-fuse-csi-driver)
- [Preferred Networks meta-fuse-csi-plugin](https://tech.preferred.jp/en/blog/meta-fuse-csi-plugin/)
- [Codespaces mounts limitation #163129](https://github.com/orgs/community/discussions/163129)
- [Fly community: include FUSE module #649](https://community.fly.io/t/include-fuse-module-in-the-kernel-of-the-vm/649)
- [Fly LiteFS mount docs](https://fly.io/docs/litefs/mount/)
- [Firecracker kernel policy](https://github.com/firecracker-microvm/firecracker/blob/main/docs/kernel-policy.md)
- [Archil — Firecracker FUSE recompile guide](https://docs.archil.com/guides/virtualization/firecracker)
- [Modal sandboxes guide](https://modal.com/docs/guide/sandboxes)
- [Modal: behind the scenes (Amplify)](https://www.amplifypartners.com/blog-posts/behind-the-scenes-of-modal-sandboxes)
- [E2B connect-bucket](https://e2b.dev/docs/sandbox/connect-bucket)
- [Daytona volumes docs](https://www.daytona.io/docs/en/volumes/)
- [daytonaio/daytona #3331 (FUSE volume limitations)](https://github.com/daytonaio/daytona/issues/3331)
- [Cloudflare Containers FUSE changelog 2025-11](https://developers.cloudflare.com/changelog/post/2025-11-21-fuse-support-in-containers/)
- [Cloudflare R2 FUSE example](https://developers.cloudflare.com/containers/examples/r2-fuse-mount/)
- [Apple Containerization (InfoQ 2025-06)](https://www.infoq.com/news/2025/06/apple-container-linux/)
- [macFUSE 5.1.0 (2025-10)](https://macfuse.github.io/2025/10/30/macfuse-5.1.0.html)
- [Kata virtio-fs how-to](https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/how-to-use-virtio-fs-with-kata.md)
- [virtio-fs project](https://virtio-fs.gitlab.io/)
- [gVisor compatibility](https://gvisor.dev/docs/user_guide/compatibility/)
- [gVisor #2752 /dev/fuse](https://github.com/google/gvisor/issues/2752)
- [gVisor #2753 mount FUSE](https://github.com/google/gvisor/issues/2753)
- [Linux: fuse fully unprivileged mounts commit](https://github.com/torvalds/linux/commit/4ad769f3c346ec3d458e255548dec26ca5284cf6)
- [Zameer Manji — using FUSE without root](https://zameermanji.com/blog/2022/8/5/using-fuse-without-root-on-linux/)
- [Alpine fuse3-static](https://pkgs.alpinelinux.org/package/edge/main/x86/fuse3-static)
