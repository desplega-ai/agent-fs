# agent-fs

Bun monorepo: `packages/{core, cli, mcp, server}`. Product vision and positioning: [PRODUCT.md](./PRODUCT.md) (agent-fs is to files what agentmail is to email).

## Key decisions

- CLI binary: `agent-fs` (hyphenated, matches the repo name). npm package: `@desplega.ai/agent-fs` (`agent-fs` is squatted on npm).
- Internal packages, workspace-only and not published: `@desplega.ai/agent-fs-core`, `@desplega.ai/agent-fs-server`, `@desplega.ai/agent-fs-mcp`. Import aliases in all source imports: `@/core`, `@/server`, `@/mcp` (tsconfig paths).
- Runtime target: Bun only, no Node.js support. Publish with `bun publish` (auth through `NPM_CONFIG_TOKEN`), not `npm publish`.
- Config paths: `AGENT_FS_HOME`, `~/.agent-fs/`, `agent-fs.db`, `agent-fs.pid`, `agent-fs.log`. Env vars: `AGENT_FS_API_URL`, `AGENT_FS_API_KEY`, `AGENT_FS_HOME`.
- Docker names: `agent-fs-minio`, `agent-fs-minio-data`. Local user: `local@agent-fs.local`.

## Pull requests

Every PR, from anyone, fills the org template [desplega-ai/.github/pull_request_template.md](https://github.com/desplega-ai/.github/blob/main/pull_request_template.md): keep its `**Why:**`, `**Risk:**` and `**Urgency:**` lines and its `##` headings. `gh pr create --body` and `--fill` skip the template, so write the body to a file, check it with the org checker, then pass it with `--body-file`:

```bash
git clone --depth 1 https://github.com/desplega-ai/.github /tmp/desplega-github
cd /tmp/desplega-github/pr-body && PR_TEMPLATE_PATH=../pull_request_template.md \
  bun scripts/check-pr-body.ts --title "<title>" --body-file <absolute path>
```

A red **PR Body** check fails the required `ci` job and blocks the merge. Editing the description re-runs it, with no push.

- `## Before / after` is required on every PR. Show what a user or an agent sees change: CLI output or an API result as a `diff` block, a screenshot pair for `live/` or `landing/`, or the line `No visible change: <reason>` for a change that nobody can see.
- For a `fix:` title, `## Verified` shows the control on `main`: the failure before the fix.

<important if="you need to run commands to install, type check, build or test">

| Command | What it does |
|---|---|
| `bun install` | Install dependencies |
| `bun run typecheck` | TypeScript type checking (`tsc --build`) |
| `bun run build` | Bundle the CLI for npm to `packages/cli/dist/cli.js` |
| `bun run test` | Run tests (manual and integration tests skip themselves without env) |
| `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"` | CLI E2E tests (needs Docker for MinIO) |
| `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only` | Local-filesystem E2E mode, no credentials. CI uses it |

</important>

<important if="you are changing core ops, CLI commands or MCP tools, or writing a plan or research document that involves them">

Check these three, and list them as explicit steps in a plan or research document:

1. **Skill update.** A new op or command, or changed behavior, also changes `skills/agent-fs/SKILL.md`: command tables, description triggers, workflow examples.
2. **E2E coverage.** A new op gets tests in `scripts/e2e.ts`.
3. **Version bump.** Run `./scripts/release.sh <version>` (patch for fixes and features, minor for breaking changes). It bumps every target at once, including `.claude-plugin/plugin.json`, and the release publishes when it reaches `main`.

`scripts/e2e.ts` starts an isolated backend and a daemon on a random port, then runs the CLI and MCP tests end to end. CI uses `--local-only` (local filesystem, no Docker). The default mode also covers MinIO presigned URLs and Docker FUSE: run it as a regression check when you modify core ops, CLI commands or MCP. If a core change breaks something, extend the E2E suite to cover it.

</important>

<important if="you are touching versions, release scripts, publish workflows, Dockerfiles or the Bun version">

[RELEASING.md](./RELEASING.md) is the source of truth for the release process. Read it first, and link to it instead of restating its mechanics. Deployment targets (npm package contents, Docker/GHCR, Fly.io, env vars): [DEPLOYMENT.md](./DEPLOYMENT.md).

Releases are automatic: a version change that lands on `main` triggers the tag and the publish.

```bash
./scripts/release.sh 0.13.0   # sync every version target, commit, push
```

- Bump a version only through that script. `scripts/sync-versions.ts` owns every place the version appears (every `package.json`, the FUSE `Cargo.toml`, `.claude-plugin/plugin.json`), and CI fails a partial bump.
- `sync-versions.ts --check` runs on every PR and before every tag ([RELEASING.md § Version targets](./RELEASING.md#version-targets)). It requires that `bun.lock` workspace versions move with the release version, and that one exact Bun version is pinned in `package.json` `packageManager`, both `Dockerfile` `FROM oven/bun:` tags and every workflow `bun-version:`.
- Pin the exact Bun number in those three places together. A floating `oven/bun:1.4` tag lets the image and CI drift apart.
- Run `bun install --frozen-lockfile` after any dependency or version change, so that the lockfile is committed with it.

</important>

<important if="you are working in live/ or landing/">

`live/` and `landing/` use pnpm, not bun: Vercel deploys them with `pnpm install`. Add a dependency there with `pnpm add <pkg>`, so that `pnpm-lock.yaml` stays the source of truth. `bun add` creates a stale `bun.lock`, and the Vercel preview deploy then fails because pnpm's lockfile no longer matches `package.json`. The Bun-only runtime decision applies to the CLI and the server, not to these two web apps.

`landing/` notes:

- Vite SPA (`landing/src/`). Doc pages render at `/docs/<slug>` through client-side routing in `App.tsx`.
- Docs content is imported from the top-level `docs/` with `?raw` (`landing/src/content/docs.ts`), and `landing/scripts/generate-markdown.ts` also syncs it to `landing/public/docs/` (it runs in `pnpm build`).
- `landing/content/markdown.ts` is the source of truth for `/llms.txt` and `/md/index.md`. Update it when you add a doc page, so that agents discover it.
- Theme handling is in `landing/src/lib/theme.tsx` (light and dark, persisted to `localStorage`). CSS variables are in `landing/src/index.css`, with `:root.light { ... }` overrides. An inline pre-paint script in `landing/index.html` sets the class before React mounts, which avoids a flash of the wrong theme.

</important>

<important if="runtime behavior contradicts the TypeScript source, or you changed tsconfig or build output paths">

Look for stale `.js` files in `src/` directories. `tsc --build` writes `.js` and `.d.ts` files to `dist/` through `outDir`. If `dist/` was ever missing, or an earlier misconfiguration wrote outputs to `src/`, stale `.js` files can remain in `packages/*/src/`. Bun prefers `.js` over `.ts` when an import names the `.js` extension, so a stale file silently shadows the real source (for example a call reaches an old async function that is now sync). Find them with `find packages/*/src -maxdepth 1 -name "*.js"` and delete them.

</important>

<important if="you are working on the FUSE helper (packages/fuse-helper, packages/fuse-helper-linux-x64, packages/fuse-helper-linux-arm64) or the mount command">

`packages/fuse-helper/` is a Rust crate that exposes agent-fs drives as a Linux FUSE filesystem. It builds apart from the Bun monorepo: it is a `cargo` workspace member rooted at `/Cargo.toml`. `target/` is gitignored, and `Cargo.lock` is committed (binary crate).

| Task | Command |
|---|---|
| Host build (Darwin or Linux) | `cd packages/fuse-helper && cargo build --release`. On Darwin it builds but cannot mount |
| Mount test on macOS | `packages/fuse-helper/docker/run-mount-test.sh`: Ubuntu 24.04 with `fuse3` and `/dev/fuse`, mounts the helper against a stub Unix socket and asserts the mount table |
| Cross build for release | `cross build --release --target x86_64-unknown-linux-musl` (and `aarch64-unknown-linux-musl`): stripped static musl binaries of 5 MB or less, which feed `@desplega.ai/agent-fs-fuse-linux-{x64,arm64}` |
| Tests | `cargo test`: unit tests, `tests/ipc_roundtrip.rs` (stub Unix server, 100-way multiplex check) and `tests/filesystem_smoke.rs` (MockIpc-backed open, write, release). No `/dev/fuse` needed |
| Lint and format | `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` |

**Local dev without the published sub-package.** The CLI's binary resolver looks for `@desplega.ai/agent-fs-fuse-linux-<arch>` through `optionalDependencies`. On Darwin that fails, because the sub-package's `os: ["linux"]` constraint prevents the install. Use your own build:

```bash
cd packages/fuse-helper && cargo build --release
export AGENT_FS_FUSE_BIN="$PWD/target/release/agent-fs-fuse"
agent-fs mount /tmp/m
```

`AGENT_FS_FUSE_BIN` takes precedence over the sub-package resolver. On Darwin the build succeeds but the mount call still fails: use `packages/fuse-helper/docker/run-mount-test.sh` for an end-to-end mount test.

The CLI also reads `packages/cli/dist/fuse-bin.manifest.json`, a SHA-256 manifest of the published binaries, to verify what it spawns. `bun run packages/cli/scripts/build-fuse-manifest.ts` generates it in the release workflow. Locally it is usually absent: the CLI prints a warning and continues.

**Per-platform sub-packages** (`packages/fuse-helper-linux-{x64,arm64}/`). Each one is a thin wrapper around the cross-compiled binary, published to npm on its own as `@desplega.ai/agent-fs-fuse-linux-x64` and `-linux-arm64`. It holds only `package.json`, `README.md` and `bin/agent-fs-fuse`. The release workflow fills `bin/`, and locally it holds only `.gitkeep`. The main `@desplega.ai/agent-fs` package lists both in `optionalDependencies`, pinned to the exact main version. `scripts/sync-versions.ts <version>` keeps them in lockstep.

</important>

<important if="you are changing storage adapters (packages/core/src/storage) or bumping files-sdk">

`packages/core/src/storage/factory.ts` picks one of two adapters. `provider: "local"` uses `LocalStorageAdapter`, the only code that imports [`files-sdk`](https://github.com/haydenbleasel/files-sdk) (its `files-sdk/fs` adapter). Every other provider goes through `AgentS3Client` (AWS SDK v3), so a remote store works only if it speaks the S3 API. The other provider adapters of files-sdk (Convex, Upstash Blob, Vercel Blob and more) are not wired in. When you bump files-sdk across a major version, read its CHANGELOG for `Files`, `files-sdk/fs`, the `head` and `list` result shapes and the error codes, then run `packages/core/src/storage/__tests__/` and the `--local-only` E2E.

</important>
