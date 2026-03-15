# agent-fs

Bun monorepo: `packages/{core, cli, mcp, server}`

## Commands

- `bun install` — install dependencies
- `bun run typecheck` — TypeScript type checking (`tsc --build`)
- `bun run build` — compile CLI binary to `dist/agentfs`
- `bun run test` — run tests (manual/integration tests auto-skip without env)

## Releasing

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
