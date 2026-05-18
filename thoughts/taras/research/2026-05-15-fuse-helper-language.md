---
date: 2026-05-15
author: Claude (bg research)
topic: "FUSE helper language: Rust fuser vs Go bazil vs Go go-fuse"
tags: [research, agent-fs, fuse, rust, go]
parent_brainstorm: thoughts/taras/brainstorms/2026-05-15-agent-fs-as-linux-filesystem.md
status: complete
---

# FUSE helper language: Rust `fuser` vs Go `bazil.org/fuse` vs Go `hanwen/go-fuse`

## Summary

**Pick Rust `fuser` (cberner) v0.17+.** The Feb 2026 release added `Config::n_threads` multi-event-loop dispatch and an experimental `AsyncFilesystem` trait, removing the concurrency gap that historically favored go-fuse, while AWS's `mountpoint-s3-fuser` fork is the closest production analog to our S3-backed mount. `hanwen/go-fuse` is a strong runner-up (pure-Go, no-CGO, trivial cross-compile, JuiceFS/GCSFuse/restic in production) and the right choice if dev ergonomics outweigh latency; `bazil.org/fuse` is effectively dead (last commit Jan 2023) and should not be considered.

## Comparison table

| Dimension | Rust `fuser` (cberner) | Go `hanwen/go-fuse` v2 | Go `bazil.org/fuse` |
|---|---|---|---|
| **Last release** | 0.17.0 — 2026-02-14 | v2.9.x — Feb 2026 (active) | v0.0.0-20230120... — Jan 2023 (stale) |
| **Maintenance** | Very active; cberner also maintains redb | Very active; hanwen + ~76 contributors | Effectively unmaintained; rclone migrating away |
| **Stars (≈)** | ~1.2k | ~2.3k | ~1.5k (frozen) |
| **libfuse 3 / protocol** | Pure-Rust protocol; libfuse calls optional (feature flag). Implements libfuse up to 3.10.3 | Pure-Go protocol; talks to `/dev/fuse` directly; supports recent FUSE protocol incl. 7.31 `max_pages` and passthrough_ll (`PassthroughFd` + `RegisterBackingFd`) | Pure-Go; older protocol coverage; no kernel passthrough |
| **passthrough_ll support** | Supported (kernel ≥6.9); fuser exposes passthrough FDs (added 0.16) | Supported (`PassthroughFd` / `RegisterBackingFd`) — explicit feature in v2.6+ | No |
| **Concurrency model** | Sync `Filesystem` trait. Session loop reads non-concurrently to avoid extra buffers; user spawns threads from method bodies. **0.17 adds `Config::n_threads` for multiple event loops + experimental `AsyncFilesystem`.** | Goroutine-per-request by default (`Server` dispatches each FUSE op in its own goroutine); thread-safety is the FS author's problem. Optional multi-FD session/worker pattern for advanced cases. | Goroutine-per-request, but old protocol limits matter more than the concurrency model |
| **Static binary** | musl + `cross` or `rust-musl-cross` Docker image → fully static binary, no libc/libfuse needed at runtime (build without `libfuse` feature). ~1–3 MB stripped. | `CGO_ENABLED=0 GOOS=linux go build` → fully static, pure-Go, no toolchain. ~5–10 MB stripped. | Same as go-fuse |
| **Cross-compile macOS → linux-x64 / arm64** | `cross build --target {x86_64,aarch64}-unknown-linux-musl` (needs Docker); or `rustup target add ...` + musl-cross-make. CI-friendly but not single-command on a fresh mac | `GOOS=linux GOARCH={amd64,arm64} CGO_ENABLED=0 go build` — single command, no Docker, no extra toolchain | Same as go-fuse |
| **API ergonomics for our op set** | `Filesystem` trait: `getattr/readdir/open/read/release/readlink/create/write/flush/truncate/unlink/rename/mkdir/rmdir` all map 1:1; no-op `chmod/chown/utimens/fsync` and ENOSYS for flock/fcntl is trivial (default trait impl returns ENOSYS). Strong typing via newtypes in 0.17. | `fs.InodeEmbedder` interface methods or raw `fuse.RawFileSystem`. Same op set maps 1:1. Looser typing (uint32 flags), easier to write, fewer compile-time guarantees. | Similar to go-fuse but older API |
| **IPC-to-daemon pattern** | Sync trait: `Handle::block_on(unix_socket.request(...))` per op — needs a tokio runtime parked on a thread (or use experimental `AsyncFilesystem`). Latency overhead: 1 thread-hop per op if going sync→async, ~µs scale. | Goroutine-per-request fits naturally: each handler does `conn.WriteJSON(req); conn.ReadJSON(&reply)` against the Unix socket. Idiomatic Go, no runtime acrobatics. | Same as go-fuse |
| **Latency floor** | Lowest. Pure Rust, no GC pauses, no goroutine scheduling jitter. AWS chose it for mountpoint-s3 partly for this reason. | Higher than Rust but competitive with C libfuse per project README. GC pauses possible under load. | Same as go-fuse but with older protocol overhead |
| **Notable production users** | **AWS mountpoint-s3** (forked as `mountpoint-s3-fuser`); various redb-related tools; smaller ecosystem | **JuiceFS** (distributed POSIX FS on Redis+S3), **GCSFuse** (Google), **restic**, **CERN reva**, Zoekt | Historical: rclone (Linux only, being deprecated in favor of go-fuse); some legacy Bazil project users |

## Per-option

### Rust `fuser` (cberner) — RECOMMENDED

**Pros**
- Active maintenance from a single high-signal maintainer (Christopher Berner, also redb).
- 0.17 (Feb 2026) is a major API modernization: typed newtypes/bitflags, `&self` methods (requires `Send + Sync + 'static`), `Config::n_threads` for parallel event loops, experimental `AsyncFilesystem` trait.
- Pure-Rust on Linux when built without the `libfuse` feature — only mount/umount touch libc. Static musl binary is trivial.
- AWS `mountpoint-s3` is the closest large-scale production analog to our S3-backed FUSE; they vendored fuser and are upstreaming changes. Strong validation for our workload shape.
- Passthrough FD support landed in 0.16, giving us kernel-direct passthrough_ll for any future "host-backed file" optimization.
- Tight memory control, no GC — latency tail behavior much more predictable than Go.

**Cons**
- `AsyncFilesystem` is marked **experimental**; if it churns we have to either pin or fall back to sync + `block_on`.
- Sync `Filesystem` over a Unix socket needs careful runtime threading (one tokio runtime, blocking call per op). Workable but more boilerplate than go-fuse.
- Cross-compile from macOS host needs Docker (`cross`) or a Linux CI runner; not single-command like Go.
- Smaller community vs go-fuse for FUSE-specific edge cases.
- Build time is longer than Go; matters for CI iteration but not for end users.

### Go `hanwen/go-fuse` v2 — RUNNER-UP

**Pros**
- Very active maintenance; v2.6+ added FreeBSD, passthrough, new directory/forget APIs; v2.9 line currently shipping.
- **Pure Go, no CGO**: `CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build` produces a static binary from a macOS dev host with zero extra toolchain. Best-in-class for our cross-compile story.
- Goroutine-per-request maps trivially to our "handler → Unix socket → daemon → reply" pattern; no async/sync impedance.
- Heavyweight production users: **JuiceFS** (distributed FS on S3+Redis — closest moral cousin to agent-fs), **GCSFuse** (Google), **restic**, **CERN reva**. Battle-tested at scale.
- Passthrough FD support in v2.6+ matches what fuser offers.
- Op-set ergonomics: `fs.InodeEmbedder` is the easiest path; `fuse.RawFileSystem` if we want raw control.

**Cons**
- GC pause latency tail (not a dealbreaker for our many-concurrent-agent workload — tail is typically <1 ms on tuned GOGC — but Rust has none).
- Per-request goroutine + Go scheduler add a few µs vs Rust.
- Thread-safety burden on us; need to be careful since methods run concurrently.
- "An access can tie up two OS threads (request + server)" — documented deadlock risk if our daemon-side handler somehow round-trips back through the mount (it won't in our design, but worth noting).
- Larger static binary (~5–10 MB vs ~1–3 MB Rust).

### Go `bazil.org/fuse` — REJECT

**Pros**
- Pure Go, simple API, historically well-documented.

**Cons**
- **Last release ~Jan 2023; effectively unmaintained.**
- No support for newer FUSE protocol features (no passthrough_ll, weaker protocol coverage).
- rclone — the most visible Bazil user — has open work to switch to hanwen/go-fuse.
- Picking a dead library for a v1 distribution target is a non-starter.

## Risks & gotchas

1. **fuser 0.17 `AsyncFilesystem` is experimental.** If we depend on it and it changes shape, we eat a migration. Mitigation: prefer sync `Filesystem` trait + a dedicated tokio runtime thread that owns the Unix socket connection to the Bun daemon; use `Handle::block_on(socket.request(...))` inside trait methods. Revisit async once the API stabilizes (likely 0.18+).

2. **`mountpoint-s3-fuser` is a fork, not upstream.** AWS is "working to upstream changes." We should use upstream `fuser` and watch for the merge; if AWS-only patches turn out to matter (e.g., specific reply shortcuts) we can vendor them too.

3. **macOS cross-compile to Linux for Rust.** Requires Docker (`cross`) or a Linux CI runner. For solo dev velocity on a Mac this is friction vs Go's single-command build. Mitigation: GitHub Actions Linux runner producing release artifacts; local devs run the daemon on Linux via the existing Docker MinIO infra or a Lima/OrbStack VM.

4. **Go GC tail latency at high concurrency.** "Many concurrent agents hammering the mount" implies hundreds of getattr/readdir/read ops/sec. Go's GC is fine here, but P99.9 will jitter. If latency tail is a product-visible metric, Rust wins by construction.

5. **passthrough_ll requires Linux kernel ≥6.9.** Both fuser (0.16+) and go-fuse (2.6+) expose it, but our v1 target distros must have a recent kernel for the optimization to engage. Not a blocker for v1 since we control the kernel-touching code path and can fall back to userspace read/write.

6. **Pure-protocol implementations vs libfuse.** Both fuser (without `libfuse` feature) and go-fuse implement the FUSE wire protocol in their own language. This is good (no libfuse-dev dependency in the binary) but means any kernel-side FUSE protocol bump requires a library update — both libraries track this well, but it's a maintenance surface.

7. **Unix socket IPC framing.** Independent of language choice: pick length-prefixed binary (msgpack or bincode/cbor) over JSON for the helper↔daemon hop. JSON parse cost dominates per-op latency for hot paths like getattr/read. Both Rust and Go have good libs (serde+rmp-serde or msgpack-go).

8. **Op set "no-op vs ENOSYS" semantics.** For `chmod/chown/utimens/fsync` returning success-noop vs ENOSYS materially changes how apps behave (`cp -p`, `rsync`, editors writing then fsync'ing). Verify against actual agent workloads early; both libraries let us pick per-op.

9. **`flock/fcntl` returning ENOSYS** means anything doing file locking (sqlite, git index lock, some build tools) will get `EBADF`/`ENOTSUP` and may behave oddly. Expect to revisit once agents try to run real toolchains inside the mount.

## Sources

- [cberner/fuser GitHub](https://github.com/cberner/fuser)
- [fuser CHANGELOG](https://github.com/cberner/fuser/blob/master/CHANGELOG.md)
- [fuser on crates.io](https://crates.io/crates/fuser)
- [fuser docs.rs — Filesystem trait](https://docs.rs/fuser/latest/fuser/trait.Filesystem.html)
- [fuser docs.rs — BackgroundSession](https://docs.rs/fuser/latest/fuser/struct.BackgroundSession.html)
- [mountpoint-s3-fuser fork (AWS)](https://github.com/awslabs/mountpoint-s3/tree/fuser/fork)
- [mountpoint-s3-fuser on crates.io](https://crates.io/crates/mountpoint-s3-fuser)
- [hanwen/go-fuse GitHub](https://github.com/hanwen/go-fuse)
- [go-fuse v2 fuse package docs](https://pkg.go.dev/github.com/hanwen/go-fuse/v2/fuse)
- [go-fuse v2 fs package docs](https://pkg.go.dev/github.com/hanwen/go-fuse/v2/fs)
- [go-fuse DeepWiki](https://deepwiki.com/hanwen/go-fuse)
- [JuiceFS using go-fuse](https://github.com/juicedata/juicefs/blob/main/pkg/fuse/fuse.go)
- [GCSFuse](https://github.com/GoogleCloudPlatform/gcsfuse)
- [restic internal/fuse](https://pkg.go.dev/github.com/restic/restic/internal/fuse)
- [bazil/fuse GitHub](https://github.com/bazil/fuse)
- [rclone issue: switch to hanwen/go-fuse](https://github.com/rclone/rclone/issues/5896)
- [fuse3 (alternative async Rust)](https://crates.io/crates/fuse3)
- [fuser-async (Tokio bridge)](https://crates.io/crates/fuser-async)
- [Linux kernel FUSE passthrough docs](https://docs.kernel.org/filesystems/fuse/fuse-passthrough.html)
- [rust-musl-cross Docker images](https://github.com/rust-cross/rust-musl-cross)
