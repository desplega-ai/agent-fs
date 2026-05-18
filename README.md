<p align="center">
  <a href="https://github.com/desplega-ai/agent-fs/stargazers"><img src="https://img.shields.io/github/stars/desplega-ai/agent-fs?style=flat-square&color=yellow" alt="GitHub Stars"></a>
  <a href="https://github.com/desplega-ai/agent-fs/blob/main/LICENSE"><img src="https://img.shields.io/github/license/desplega-ai/agent-fs?style=flat-square" alt="MIT License"></a>
  <a href="https://github.com/desplega-ai/agent-fs/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs Welcome"></a>
  <a href="https://discord.gg/KZgfyyDVZa"><img src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center">
  <b>A persistent, searchable filesystem for AI agents.</b><br/>
  <sub>Built by <a href="https://desplega.sh">desplega.sh</a> — by builders, for builders.</sub>
</p>

---

Agent FS gives AI agents a structured filesystem with built-in semantic search, versioning, and identity management. It runs as a CLI and an HTTP server with integrated MCP support — so any AI coding assistant can use it as a long-term memory and file store.

agent-fs was built to power the shared filesystem in [agent-swarm](https://github.com/desplega-ai/agent-swarm) — a multi-agent coordination framework. While it was designed for swarm agents to share files, search content, and collaborate, it works as a standalone filesystem for any AI agent.

## Key Features

- **Semantic search** — Index and search files using vector embeddings (OpenAI, Google GenAI, or local llama.cpp)
- **Structured storage** — SQLite-backed file operations with metadata and versioning
- **S3-compatible sync** — Sync agent workspaces to any S3-compatible object store
- **Identity management** — Persistent agent identity files that evolve over time
- **MCP integration** — Expose filesystem operations as MCP tools for Claude Code, Codex, and other assistants
- **HTTP API** — RESTful server powered by Hono for programmatic access
- **CLI** — Single binary (`agent-fs`) for local use and scripting

## Quick Start

### Install

Requires [Bun](https://bun.sh) >= 1.2.0.

```bash
bun add -g @desplega.ai/agent-fs
```

Or build from source:

```bash
git clone https://github.com/desplega-ai/agent-fs.git
cd agent-fs
bun install
bun run build
```

### Usage

```bash
# Show available commands
agent-fs --help
```

## Architecture

Agent FS is a Bun monorepo with four packages:

| Package | Description |
|---------|-------------|
| `@desplega.ai/agent-fs-core` | Core library — storage engine, semantic search, identity, S3 sync |
| `@desplega.ai/agent-fs` | CLI binary (`agent-fs`) |
| `@desplega.ai/agent-fs-mcp` | MCP stdio proxy + tool registration for the HTTP server |
| `@desplega.ai/agent-fs-server` | HTTP server — RESTful API powered by Hono |

## FUSE mount (Linux)

agent-fs can expose your drives as a Linux FUSE filesystem so agents can use plain shell verbs (`cat`, `grep`, `mv`, `rm`) against agent-fs content.

```bash
# Linux only — the FUSE helper sub-package auto-installs via optionalDependencies.
npm install -g @desplega.ai/agent-fs
agent-fs daemon start
agent-fs mount /mnt/agent-fs
```

**Requirements**

- Linux x86_64 or aarch64. macOS and Windows are not supported (FUSE is a Linux kernel feature here).
- `/dev/fuse` must be accessible. In Docker, run with `--cap-add SYS_ADMIN --device /dev/fuse`.
- Sandboxes that use gVisor (GKE Sandbox, Cloud Run gen1), GitHub Codespaces, Modal sandboxes, or Fly.io Machines cannot mount FUSE — fall back to the CLI/MCP path.

**Local-dev escape hatch (`AGENT_FS_FUSE_BIN`)**

If you're building the helper from source (e.g. macOS dev host or a custom Linux build), point the CLI at your local binary:

```bash
cd packages/fuse-helper && cargo build --release
export AGENT_FS_FUSE_BIN="$PWD/target/release/agent-fs-fuse"
agent-fs mount /tmp/m
```

`AGENT_FS_FUSE_BIN` takes precedence over the auto-resolved sub-package binary.

**Remote mount (`--remote`)**

When your agents run inside a sandbox that can't host a local daemon (Sprite, E2B, ephemeral CI runners), point the mount at a remote agent-fs HTTP API instead of a local Unix socket:

```bash
agent-fs mount /mnt/agent-fs --remote \
  --api-url https://my-agent-fs.example.com \
  --api-key "$AGENT_FS_API_KEY"
```

The helper talks to the remote API directly — no local daemon, no S3 credentials in the sandbox. End-to-end coverage for this topology lives at `scripts/e2e-remote-mount.ts`:

```bash
# Spins up MinIO, a host-side daemon, and a Docker container with fuse3.
# Mounts via --remote against the daemon's HTTP API and exercises ~8 ops.
# Requires Docker Desktop / OrbStack on Mac.
bun run scripts/e2e-remote-mount.ts
```

**macOS testing harness**

macOS can build the helper but not mount it. Use the Docker harness to test mount behaviour from a Mac host:

```bash
bash packages/fuse-helper/docker/run-mount-test.sh
```

## Documentation

- [MCP Setup Guide](./docs/mcp-setup.md) — Connect agent-fs to Claude Code, Cursor, or any MCP client
- [Deployment Guide](./docs/deployment.md) — Local, remote S3, team, and multi-agent deployments
- [API Reference](./docs/api-reference.md) — HTTP API and OpenAPI spec

## Development

```bash
bun install          # Install dependencies
bun run typecheck    # Type checking
bun run test         # Run tests
bun run build        # Bundle CLI for npm
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full development guide.

## Releasing

1. Update `version` in root `package.json`
2. Commit the version bump
3. Run `./scripts/release.sh`

This creates a git tag and pushes it, triggering the release workflow which publishes to npm and creates a GitHub Release.

## Deploy to Fly.io

Deploy a persistent agent-fs instance to [Fly.io](https://fly.io) with Tigris S3 storage:

```bash
git clone https://github.com/desplega-ai/agent-fs && cd agent-fs
bun run scripts/fly-deploy.ts
```

See [DEPLOYMENT.md](./DEPLOYMENT.md) for Docker, BYOK storage, and manual setup options.

## Live Viewer

**[live.agent-fs.dev](https://live.agent-fs.dev)** — A stateless browser UI (local storage only) for inspecting any agent-fs deployment. Point it at your server URL to browse files and search content — nothing is stored server-side.

## Contributing

We welcome contributions! Whether it's bug reports, feature requests, docs improvements, or code — all are welcome.

1. Fork the repo
2. Create a branch (`git checkout -b my-feature`)
3. Make your changes
4. Open a PR

Join our [Discord](https://discord.gg/KZgfyyDVZa) if you have questions or want to discuss ideas.

## License

[MIT](./LICENSE) — 2025-2026 [desplega.ai](https://desplega.ai)
