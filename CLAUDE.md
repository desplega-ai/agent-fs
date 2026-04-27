# agent-fs

See [PRODUCT.md](./PRODUCT.md) for product vision and positioning (agent-fs is to files what agentmail is to email).

Bun monorepo: `packages/{core, cli, mcp, server}`

## Commands

- `bun install` — install dependencies
- `bun run typecheck` — TypeScript type checking (`tsc --build`)
- `bun run build` — bundle CLI for npm to `packages/cli/dist/cli.js`
- `bun run test` — run tests (manual/integration tests auto-skip without env)
- `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"` — CLI E2E tests (requires Docker for MinIO)

## Releasing & Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for full deployment details (npm publishing, secrets, install methods).

## Release Steps

1. Update `version` in root `package.json`
2. Commit the version bump
3. Run `./scripts/release.sh`

This creates a git tag matching `v{version}` and pushes it, which triggers the release workflow. The workflow:
- Validates the tag matches `package.json` version
- Runs typecheck and tests
- Publishes to npm with provenance
- Creates a GitHub Release with install instructions

## Release Checklist (applies to plans, research, and Plan mode)

When making changes to core ops, CLI commands, or MCP tools, always check:

1. **Skill update** — If a new op/command was added or existing behavior changed, update `skills/agent-fs/SKILL.md` (command tables, description triggers, workflow examples).
2. **Plugin version bump** — If the skill was updated, bump `version` in `.claude-plugin/plugin.json`.
3. **Package version bump** — Bump `version` in root `package.json` (patch for fixes/features, minor for breaking changes).
4. **E2E coverage** — If a new op was added, add corresponding tests to `scripts/e2e.ts`.

Plans and research documents MUST include these as explicit steps when they involve core/CLI/MCP changes.

## E2E Tests

`scripts/e2e.ts` spins up an isolated MinIO container, starts a daemon on a random port, and runs 24 CLI + MCP tests end-to-end. Run it as a regression check when modifying core ops, CLI commands, or MCP. If a core change breaks something, extend the E2E suite to cover it. Not in CI or pre-push — run on demand locally.

## Gotcha: `live/` is pnpm, not bun

The root + `packages/*` use bun. **`live/` uses pnpm** (Vercel deploys it with `pnpm install`). Add deps there with `pnpm add <pkg>` so `live/pnpm-lock.yaml` stays the source of truth — running `bun add` in `live/` creates a stale `bun.lock` and the Vercel preview deploy fails because pnpm's lockfile no longer matches `package.json`. The "Bun-only" runtime decision below applies to the CLI/server, not to `live/`'s package manager.

## Gotcha: Stale `.js` files in `src/` dirs

`tsc --build` outputs compiled `.js`/`.d.ts` files to `dist/` via `outDir`. However, if `dist/` is ever missing or a previous misconfiguration wrote outputs to `src/`, stale `.js` files can linger in `packages/*/src/`. **Bun prefers `.js` over `.ts` when an import specifies `.js` extension**, so these stale files silently shadow the real `.ts` source — causing baffling runtime bugs (e.g., calling an old async function that's now sync). If you see inexplicable runtime behavior that contradicts the source, check for `.js` files in `src/` dirs: `find packages/*/src -maxdepth 1 -name "*.js"` and delete them.

## Key Decisions

- **CLI binary name:** `agent-fs` (hyphenated, matches repo name)
- **npm package:** `@desplega.ai/agent-fs` (`agent-fs` is squatted on npm)
- **Internal package names:** `@desplega.ai/agent-fs-core`, `@desplega.ai/agent-fs-server`, `@desplega.ai/agent-fs-mcp` (workspace-only, not published)
- **Import aliases:** `@/core`, `@/server`, `@/mcp` via tsconfig paths (used in all source imports)
- **Config paths:** `AGENT_FS_HOME`, `~/.agent-fs/`, `agent-fs.db`, `agent-fs.pid`, `agent-fs.log`
- **Docker names:** `agent-fs-minio`, `agent-fs-minio-data`
- **Local user:** `local@agent-fs.local`
- **Env vars:** `AGENT_FS_API_URL`, `AGENT_FS_API_KEY`, `AGENT_FS_HOME`
- **npm publishing:** `bun publish` (not `npm publish`), auth via `NPM_CONFIG_TOKEN`
- **Runtime target:** Bun-only, no Node.js support
