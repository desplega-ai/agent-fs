# Deployment

## Prerequisites

- `NPM_TOKEN` secret set in GitHub repo settings (granular access token for `@desplega-ai` scope)
- `@desplega-ai` org exists on npm

## Release Process

1. Update `version` in root `package.json`
2. Commit the version bump
3. Run `./scripts/release.sh`

This creates a git tag `v{version}` and pushes it, triggering the release workflow which:

- **Runs typecheck and tests** to validate the release
- **Publishes to npm** as `@desplega.ai/agent-fs` with provenance
- **Creates a GitHub Release** with install instructions

## npm Package

- **Name:** `@desplega.ai/agent-fs`
- **Scope:** public
- **Runtime:** Bun-only (`engines.bun >= 1.2.0`)
- **Contents:** Bundled CLI (`dist/cli.js`) with external npm dependencies

### Install

```bash
bun add -g @desplega.ai/agent-fs
agent-fs --help
```

## Build Commands

| Command | Description |
|---------|-------------|
| `bun run build` | Bundle CLI for npm to `packages/cli/dist/cli.js` |

## Manual npm Publish (if needed)

```bash
bun run build
cd packages/cli && bun publish --access public
```

Requires `NPM_CONFIG_TOKEN` env var set with a valid npm token.

## Notes

- `bun publish` auto-resolves `workspace:*` dependencies to real versions
- Auth uses `NPM_CONFIG_TOKEN` (not `NODE_AUTH_TOKEN` — Bun ignores that)
- No `--provenance` support in `bun publish` yet; use `npm publish` if needed
