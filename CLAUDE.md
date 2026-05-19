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

## Gotcha: `live/` and `landing/` are pnpm, not bun

The root + `packages/*` use bun. **`live/` and `landing/` both use pnpm** (Vercel deploys them with `pnpm install`). Add deps there with `pnpm add <pkg>` so the local `pnpm-lock.yaml` stays the source of truth — running `bun add` creates a stale `bun.lock` and the Vercel preview deploy fails because pnpm's lockfile no longer matches `package.json`. The "Bun-only" runtime decision below applies to the CLI/server, not to these two web apps.

`landing/` notes:
- Vite SPA (`landing/src/`); doc pages render at `/docs/<slug>` via client-side routing in `App.tsx`.
- Docs content is imported from the repo's top-level `docs/` via `?raw` (see `landing/src/content/docs.ts`) and additionally synced to `landing/public/docs/` by `landing/scripts/generate-markdown.ts` (runs in `pnpm build`).
- `landing/content/markdown.ts` is the source of truth for `/llms.txt` and `/md/index.md` — update it when adding new doc pages so agents discover them.
- Theme handling lives in `landing/src/lib/theme.tsx` (light/dark, persisted to `localStorage`); CSS vars are defined in `landing/src/index.css` with `:root.light { ... }` overrides. An inline pre-paint script in `landing/index.html` sets the class before React mounts to avoid FOUC.

## Gotcha: Stale `.js` files in `src/` dirs

`tsc --build` outputs compiled `.js`/`.d.ts` files to `dist/` via `outDir`. However, if `dist/` is ever missing or a previous misconfiguration wrote outputs to `src/`, stale `.js` files can linger in `packages/*/src/`. **Bun prefers `.js` over `.ts` when an import specifies `.js` extension**, so these stale files silently shadow the real `.ts` source — causing baffling runtime bugs (e.g., calling an old async function that's now sync). If you see inexplicable runtime behavior that contradicts the source, check for `.js` files in `src/` dirs: `find packages/*/src -maxdepth 1 -name "*.js"` and delete them.

## FUSE helper (`packages/fuse-helper/`)

Rust crate that exposes `agent-fs` drives as a Linux FUSE filesystem. Built independently from the Bun monorepo (it's a `cargo` workspace member rooted at `/Cargo.toml`).

- **Host build (Darwin/Linux dev):** `cd packages/fuse-helper && cargo build --release` — compiles + checks the binary. On Darwin it builds but cannot mount; use the Docker harness for mount tests.
- **macOS mount testing:** `packages/fuse-helper/docker/run-mount-test.sh` — Ubuntu 24.04 + `fuse3` + `/dev/fuse`, mounts the helper against a stub Unix socket, asserts the mount table.
- **Cross build for release artifacts:** `cross build --release --target x86_64-unknown-linux-musl` (and `aarch64-unknown-linux-musl`) — produces stripped static musl binaries ≤ 5 MB that feed the per-platform npm sub-packages in `@desplega.ai/agent-fs-fuse-linux-{x64,arm64}`.
- **Tests:** `cargo test` runs unit tests + `tests/ipc_roundtrip.rs` (stub Unix server, 100-way multiplex check) and `tests/filesystem_smoke.rs` (MockIpc-backed open/write/release coverage). No `/dev/fuse` needed.
- **Lint/format:** `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check`.

The `target/` directory is gitignored. `Cargo.lock` is committed (binary crate).

### Local dev — bypassing the published sub-package

On Darwin (or any host without the published Linux binary), the CLI's binary resolver looks for `@desplega.ai/agent-fs-fuse-linux-<arch>` via `optionalDependencies` and fails on Darwin (the sub-package's `os: ["linux"]` constraint prevents install). To bypass:

```bash
cd packages/fuse-helper && cargo build --release
export AGENT_FS_FUSE_BIN="$PWD/target/release/agent-fs-fuse"
agent-fs mount /tmp/m
```

`AGENT_FS_FUSE_BIN` takes precedence over the sub-package resolver, so the helper you just built is used. On Darwin the build succeeds but the mount call still fails — use `packages/fuse-helper/docker/run-mount-test.sh` for end-to-end mount tests.

The CLI also looks for `packages/cli/dist/fuse-bin.manifest.json` (a SHA-256 manifest of the published binaries) to verify what it spawns. The manifest is generated by `bun run packages/cli/scripts/build-fuse-manifest.ts` during the release workflow. Locally, the manifest is usually absent — the CLI prints a warning and proceeds.

### Per-platform sub-packages (`packages/fuse-helper-linux-{x64,arm64}/`)

Each sub-package is a thin wrapper around the cross-compiled binary, published independently to npm as `@desplega.ai/agent-fs-fuse-linux-x64` / `-linux-arm64`. They contain only `package.json`, `README.md`, and `bin/agent-fs-fuse` (populated by the release workflow — locally the `bin/` dir is empty except for `.gitkeep`). The main `@desplega.ai/agent-fs` package lists both in `optionalDependencies`, pinned to the exact main version. `scripts/sync-versions.ts <version>` rewrites every `package.json`, the FUSE Cargo.toml, and `.claude-plugin/plugin.json` together so they stay in lockstep.

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
