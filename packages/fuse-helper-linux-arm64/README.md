# @desplega.ai/agent-fs-fuse-linux-arm64

Platform-specific FUSE helper binary for [@desplega.ai/agent-fs](https://www.npmjs.com/package/@desplega.ai/agent-fs). Do not install directly — it is automatically resolved via `optionalDependencies` when you install the main package on Linux aarch64.

The binary at `bin/agent-fs-fuse` is a stripped, statically linked musl build produced by the agent-fs release workflow. It speaks the IPC protocol of the agent-fs daemon over a Unix socket; it is not useful standalone.

For local development of the helper itself, build from source: `cd packages/fuse-helper && cargo build --release` in the [agent-fs repo](https://github.com/desplega-ai/agent-fs).
