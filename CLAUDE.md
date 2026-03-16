# agent-fs

Bun monorepo: `packages/{core, cli, mcp, server}`

## Commands

- `bun install` — install dependencies
- `bun run typecheck` — TypeScript type checking (`tsc --build`)
- `bun run build` — compile CLI binary to `dist/agent-fs`
- `bun run test` — run tests (manual/integration tests auto-skip without env)

## Releasing & Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for full deployment details (npm publishing, secrets, install methods).

## Release Steps

1. Update `version` in root `package.json`
2. Commit the version bump
3. Run `./scripts/release.sh`

This creates a git tag matching `v{version}` and pushes it, which triggers the release workflow. The workflow:
- Validates the tag matches `package.json` version
- Builds binaries for linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64
- Creates a GitHub Release with all binaries attached

## Install script

Users can install via:
```
curl -fsSL https://raw.githubusercontent.com/desplega-ai/agent-fs/main/install.sh | sh
```

## Key Decisions

- **CLI binary name:** `agent-fs` (hyphenated, matches repo name)
- **npm package:** `@desplega-ai/agent-fs` (`agent-fs` is squatted on npm)
- **Internal package names:** `@desplega-ai/agent-fs-core`, `@desplega-ai/agent-fs-server`, `@desplega-ai/agent-fs-mcp` (workspace-only, not published)
- **Import aliases:** `@/core`, `@/server`, `@/mcp` via tsconfig paths (used in all source imports)
- **Config paths:** `AGENT_FS_HOME`, `~/.agent-fs/`, `agent-fs.db`, `agent-fs.pid`, `agent-fs.log`
- **Docker names:** `agent-fs-minio`, `agent-fs-minio-data`
- **Local user:** `local@agent-fs.local`
- **Env vars:** `AGENT_FS_API_URL`, `AGENT_FS_API_KEY`, `AGENT_FS_HOME`
- **npm publishing:** `bun publish` (not `npm publish`), auth via `NPM_CONFIG_TOKEN`
- **Runtime target:** Bun-only, no Node.js support
