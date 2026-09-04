# Releasing

**A version change landing on `main` is the release trigger.** There is no manual tagging step.

This file is the single source of truth for the release process. `CLAUDE.md`, `README.md`, and `DEPLOYMENT.md` link here rather than restating it — keep it that way, so the mechanics can never drift between copies.

---

## Cut a release

```bash
./scripts/release.sh 0.13.0
```

That syncs every version target, commits as `chore: release v0.13.0`, and pushes the current branch.

- **On a branch** it stops there. Open a PR; the release fires when it merges.
- **On `main`** (or the moment the PR merges) `.github/workflows/auto-release.yml` takes over.

Never bump the version by hand-editing `package.json` alone — see [Version targets](#version-targets).

### Before you bump

When the change touched core ops, CLI commands, or MCP tools:

1. **Skill** — new or changed op? Update `skills/agent-fs/SKILL.md` (command tables, description triggers, workflow examples).
2. **E2E** — new op? Add cases to `scripts/e2e.ts`.
3. **Version** — patch for fixes/features, minor for breaking changes.

`.claude-plugin/plugin.json` is bumped for you by `sync-versions.ts`; never edit it by hand.

---

## What happens on merge

`auto-release.yml` runs on every push to `main`:

1. **Verify version sync** — `sync-versions.ts --check`. Any drift fails the release here, before anything is tagged.
2. **Tag** `v{version}`, unless that tag already exists.
3. **Dispatch the publish workflows.**

Then, in parallel:

| Workflow | Does |
|---|---|
| `npm-publish.yml` | Validates the tag matches `package.json`, runs `--frozen-lockfile` install + typecheck + build + tests, cross-builds the FUSE helper for musl x64/arm64, publishes the two FUSE sub-packages, builds the SHA-256 binary manifest, then publishes the main + `just-bash` packages and creates the GitHub Release |
| `docker-publish.yml` | Builds the multi-arch (`linux/amd64,arm64`) image and pushes to GHCR, tagged full version / major.minor / major / SHA / `latest` |

Ordering inside `npm-publish.yml` is load-bearing: the FUSE sub-packages must reach the registry **before** the main package, or `optionalDependencies` won't resolve for anyone installing it; and `dist/fuse-bin.manifest.json` must be in the published tarball so the CLI can hash-verify the binary it spawns at mount time.

### Published artifacts

| Package | Published? |
|---|---|
| `@desplega.ai/agent-fs` | npm, with provenance |
| `@desplega.ai/agent-fs-just-bash` | npm, with provenance |
| `@desplega.ai/agent-fs-fuse-linux-x64` | npm, with provenance |
| `@desplega.ai/agent-fs-fuse-linux-arm64` | npm, with provenance |
| `ghcr.io/desplega-ai/agent-fs` | GHCR, multi-arch |
| `@desplega.ai/agent-fs-core`, `-server`, `-mcp` | **No** — workspace-only, versioned but never published |

---

## Version targets

`scripts/sync-versions.ts` owns the release version everywhere it appears:

- root `package.json`
- `packages/{cli,core,server,mcp,just-bash,fuse-helper-linux-x64,fuse-helper-linux-arm64}/package.json`
- the FUSE `optionalDependencies` pins in `packages/cli/package.json` (as `^{version}`)
- `packages/fuse-helper/Cargo.toml` and the `agent-fs-fuse` entry in `Cargo.lock`
- `.claude-plugin/plugin.json`
- `bun.lock`: the `version` of every workspace entry and the FUSE `optionalDependencies` pins. Only those fields move; dependency resolutions are never touched.

```bash
bun run scripts/sync-versions.ts 0.13.0            # rewrite them all
bun run scripts/sync-versions.ts 0.13.0 --dry-run  # show what would change
bun run scripts/sync-versions.ts --check           # verify, exit 1 on drift
```

`--check` compares version *fields*, not whole-file bytes, so reformatting a `package.json` can't trip it. It runs in two places:

- **`ci.yml`, on every PR** — a partial bump (root moved, sub-packages left behind) turns the PR red.
- **`auto-release.yml`, before tagging** — the real backstop.

`--check` also enforces **bun pin parity**: `packageManager` in the root `package.json`, both `FROM oven/bun:` tags in `Dockerfile`, and every `bun-version:` in `.github/workflows/` must name the same exact bun version. Floating tags such as `oven/bun:1.4` are rejected. v0.13.4 is the reason: CI ran the pinned 1.4.0 and passed, the image build resolved the floating tag to 1.4.1, which refuses `--frozen-lockfile` on a lagging `bun.lock`, and the Docker and Fly publishes failed after the tag existed. Bump all three places together.

`live/` and `landing/` are deliberately excluded — they're deployed by Vercel and carry their own versions.

---

## Verify a release

```bash
gh run list --limit 5                       # auto-release + both publishes
npm view @desplega.ai/agent-fs version
gh release view v0.13.0
```

Check both publish workflows, not just npm.

---

## Recovery

### A partial bump reached `main`

`auto-release` fails at the `--check` step: nothing is tagged, nothing publishes. Fix it forward:

```bash
./scripts/release.sh          # re-syncs to whatever root package.json says
```

### Tag exists but a publish failed

This is the one case the automation won't retry on its own — the tag exists, so the next push sees nothing to do. Re-dispatch by hand:

```bash
gh workflow run npm-publish.yml    -f tag=v0.13.0
gh workflow run docker-publish.yml -f tag=v0.13.0
```

Safe to re-run: every publish step checks the registry first and skips versions already there.

If the publish failed because the tagged commit itself is broken (for example `bun install --frozen-lockfile` rejects the committed `bun.lock`), re-dispatching cannot help: the tag's content is fixed. Fix it on `main` and cut the next patch version. Never move or delete a released tag.

### Publishing from a laptop

Last resort, when Actions itself is the problem. Requires `NPM_CONFIG_TOKEN` (Bun ignores `NODE_AUTH_TOKEN`):

```bash
bun run build
cd packages/just-bash && bun run build && bun publish --access public
cd packages/cli && bun publish --access public
```

`bun publish` resolves `workspace:*` to real versions, but has no `--provenance` support — use `npm publish --provenance` if provenance matters. This path skips the FUSE sub-packages and the binary manifest.

---

## Design notes

Things that look wrong until you know why.

**Tags pushed by CI don't trigger tag workflows.** A tag pushed with `GITHUB_TOKEN` does not fire `on: push: tags` — GitHub blocks recursive workflow runs from the default token. That's why `auto-release.yml` invokes the publish workflows through `workflow_dispatch` instead of just pushing the tag and walking away. Both workflows still accept a plain tag push, so a manually pushed tag works exactly as before.

**The release is keyed on tag existence, not on a version diff.** Comparing against the previous push would miss a bump that already reached `main` and couldn't self-heal after a failed run. "Does `v{version}` exist yet?" is idempotent: reruns resume instead of duplicating, and an untagged bump gets picked up on the next push.

**`docker-publish.yml` pins `value=` on its semver tags.** `metadata-action`'s `type=semver` reads `github.ref`, which is `refs/heads/main` under `workflow_dispatch` — it would emit no version tags at all. `value=${{ env.RELEASE_TAG }}` points it at the tag instead.

**`release.sh` deliberately does not tag.** It used to. Now that a push to `main` triggers tagging, doing it locally too would race the workflow.

**CI is advisory, not blocking.** `main` has no branch protection and no required status checks, so a red PR can still be merged. The `--check` inside `auto-release` is what actually prevents a broken version set from shipping — it fails safe (no tag, no publish), but it will not stop the merge itself.

---

## Prerequisites

- `NPM_TOKEN` repo secret — granular npm access token scoped to `@desplega-ai`
- Default workflow permissions set to **read and write** (needed to push the tag)
