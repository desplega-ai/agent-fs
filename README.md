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

## Contributing

We welcome contributions! Whether it's bug reports, feature requests, docs improvements, or code — all are welcome.

1. Fork the repo
2. Create a branch (`git checkout -b my-feature`)
3. Make your changes
4. Open a PR

Join our [Discord](https://discord.gg/KZgfyyDVZa) if you have questions or want to discuss ideas.

## License

[MIT](./LICENSE) — 2025-2026 [desplega.ai](https://desplega.ai)
