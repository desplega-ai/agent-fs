# agent-fs FUSE helper (`agent-fs-fuse`)

Standalone Rust binary that exposes the user's `agent-fs` drives as a Linux FUSE filesystem. Mounts under `/mnt/agent-fs/<drive-slug>/` plus a synthetic `current` symlink resolved on every `readlink`.

This is Phase 2 of the FUSE mount plan — the helper builds and mounts but talks to a stubbed daemon. Phase 3 wires in the real daemon IPC.

## Layout

```
packages/fuse-helper/
├── Cargo.toml             # crate manifest (lto, strip, opt-level=z)
├── Cross.toml             # cross-rs targets: musl x86_64 + aarch64
├── README.md              # this file
├── docker/
│   ├── Dockerfile.test    # Ubuntu 24.04 + FUSE + helper for macOS dev
│   └── run-mount-test.sh  # one-shot harness: build, mount, assert
├── src/
│   ├── main.rs            # CLI entry + tokio runtime + fuser::mount2
│   ├── lib.rs             # re-exports for integration tests
│   ├── fs.rs              # AgentFsFs<I>: state, working-copy lifecycle
│   ├── ipc.rs             # length-prefixed msgpack Unix-socket client
│   ├── layout.rs          # inode table, TTL caches, root + `current` view
│   ├── sidecar.rs         # NDJSON conflict/error sidecars
│   └── errno.rs           # HTTP-status → libc::errno translation
└── tests/
    ├── ipc_roundtrip.rs   # stub Unix server, 100-way multiplex check
    └── filesystem_smoke.rs# MockIpc-backed open/write/release coverage
```

## Host build (Darwin / Linux dev box)

```sh
cd packages/fuse-helper
cargo build --release
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

On Darwin the binary builds but cannot actually mount — macOS doesn't have a native FUSE kernel module. Use the Docker harness for actual mount tests (see below).

## Release build (musl static binary)

```sh
cargo install cross  # once
cd packages/fuse-helper
cross build --release --target x86_64-unknown-linux-musl
cross build --release --target aarch64-unknown-linux-musl
ls -lh target/x86_64-unknown-linux-musl/release/agent-fs-fuse
```

Expect a stripped binary ≤ 5 MB on each target. These artifacts feed the per-platform npm sub-packages in Phase 4.

## Testing on macOS

macOS hosts can't mount FUSE natively (macFUSE / fuse-t are intentionally out of v1 scope). Use the Docker harness to validate mount-time behavior:

```sh
packages/fuse-helper/docker/run-mount-test.sh
```

The script:
1. Builds an Ubuntu 24.04 image with `fuse3`, the Rust toolchain, and the source tree.
2. Runs the container with `--cap-add SYS_ADMIN --device /dev/fuse`.
3. Starts a tiny stub Unix server (defined inside the container) that answers `Ping` / `ListDrives`.
4. Mounts the helper at `/mnt/test`, lists it, and asserts the mount table contains an `agent-fs.agent-fs` entry.

If you change `fuser`, the mount-option set, or anything that affects how the binary starts up against `/dev/fuse`, re-run this script.

For full E2E coverage (create / write / read / rename / unlink) against a real daemon and MinIO, see Phase 5's additions to `scripts/e2e.ts`.

## Running manually against a real daemon

After Phase 3 lands and the daemon binds `~/.agent-fs/agent-fs.sock`:

```sh
mkdir -p /tmp/m
target/release/agent-fs-fuse \
  --mountpoint /tmp/m \
  --socket ~/.agent-fs/agent-fs.sock
mount | grep /tmp/m
```

Add `--allow-other` if other UIDs (e.g. processes inside containers) need access; this requires `user_allow_other` in `/etc/fuse.conf`.

## Logging

The helper writes `~/.agent-fs/mount.log` by default. Override with `--log-file <path>`. Format is `tracing`'s default human-readable layout, ANSI off (so it's safe to tail in log aggregators).

## Workspace integration

The repo root has a thin `Cargo.toml` declaring this crate as the only workspace member. `cargo build` at the repo root builds the helper. `target/` is gitignored.
