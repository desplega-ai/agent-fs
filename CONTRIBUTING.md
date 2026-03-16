# Contributing to Agent FS

Thanks for your interest in contributing to Agent FS!

## Table of Contents

- [Development Setup](#development-setup)
- [Running the Project](#running-the-project)
- [Code Quality](#code-quality)
- [Project Structure](#project-structure)

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
# Build CLI binary
bun run build
```

Output: `./dist/agentfs`

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
│   ├── cli/            # CLI binary (agentfs)
│   ├── mcp/            # MCP server integration
│   └── server/         # HTTP server (Hono)
├── scripts/            # Build and release scripts
├── install.sh          # Curl-pipe installer
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

Join our [Discord](https://discord.gg/KZgfyyDVZa) if you have questions or want to discuss ideas.
