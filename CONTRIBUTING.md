# Contributing to Agent FS

Thanks for your interest in contributing to Agent FS!

## Table of Contents

- [Development Setup](#development-setup)
- [Running the Project](#running-the-project)
- [Code Quality](#code-quality)
- [Project Structure](#project-structure)
- [Submitting Changes](#submitting-changes)
- [Pull Requests](#pull-requests)
- [Releasing](#releasing)

---

## Development Setup

### Prerequisites

- [Bun](https://bun.sh) v1.2+
- Git

### Install Dependencies

```bash
git clone https://github.com/desplega-ai/agent-fs.git
cd agent-fs
bun install
```

---

## Running the Project

### Tests

```bash
# Run all tests
bun run test

# With coverage
bun run test:coverage
```

### Build

```bash
# Bundle CLI for npm
bun run build
```

Output: `packages/cli/dist/cli.js`

---

## Code Quality

### Type Checking

```bash
bun run typecheck
```

Run this before committing to catch type errors early.

---

## Project Structure

```
agent-fs/
├── packages/
│   ├── core/           # Core library — storage, search, identity, database
│   ├── cli/            # CLI binary (agent-fs)
│   ├── mcp/            # MCP server integration
│   └── server/         # HTTP server (Hono)
├── scripts/            # Release scripts
├── package.json        # Workspace root
└── tsconfig.json
```

---

## Submitting Changes

1. Fork the repo
2. Create a branch (`git checkout -b my-feature`)
3. Make your changes
4. Run `bun run typecheck` and `bun run test`
5. Open a PR

Don't bump the version in your PR unless you're cutting a release — see below.

---

## Pull Requests

Every PR description fills the org [PR template](https://github.com/desplega-ai/.github/blob/main/pull_request_template.md). Keep its `**Why:**` and `**Risk:**` lines and its `##` headings, and replace each HTML comment with your text. The comments say what each part needs.

GitHub pre-fills the template only in the web UI. `gh pr create --body` and `--fill` skip it, and so does a coding agent that calls them. Write the body to a file and open the PR with `gh pr create --title "<title>" --body-file <file>`.

To check the file before you open the PR:

```bash
git clone --depth 1 https://github.com/desplega-ai/.github /tmp/desplega-github
cd /tmp/desplega-github/pr-body
PR_TEMPLATE_PATH=../pull_request_template.md bun scripts/check-pr-body.ts --title "<title>" --body-file <absolute path to your body file>
```

The **PR Body** check runs the same script on every PR. When it fails, the required `ci` job fails and the PR cannot merge. Edit the PR description to fix it; no push is needed.

---

## Releasing

Maintainers only. Releases are automatic: a version change landing on `main` tags and publishes.

```bash
./scripts/release.sh 0.13.0
```

Never hand-edit a version in `package.json` — `scripts/sync-versions.ts` owns every place it appears, and CI fails a partial bump. Full process in [RELEASING.md](./RELEASING.md).

---

Join our [Discord](https://discord.gg/KZgfyyDVZa) if you have questions or want to discuss ideas.
