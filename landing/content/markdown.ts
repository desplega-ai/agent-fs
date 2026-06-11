// Source of truth for the markdown representation of the landing.
// Imported by `middleware.ts` (served at runtime) and by
// `scripts/generate-markdown.ts` (written to `public/` as static files).

export const INDEX_MD = `---
title: "agent-fs — A file system built for AI agents"
description: "A sharable, searchable, persistent file system that any AI agent can use — via CLI or MCP. Write, search, comment, and share files across systems."
doc_version: "1.0"
last_updated: "2026-05-14"
canonical: "https://agent-fs.dev"
---

# agent-fs

> A file system built for AI agents.

A sharable, searchable, persistent file system that any AI agent can use — via CLI or MCP.

## Install

\`\`\`sh
bun add -g @desplega.ai/agent-fs
agent-fs onboard
agent-fs write hello.md --content "# Hello from an agent"
\`\`\`

Or add as a Claude Code skill:

\`\`\`sh
npx skills add desplega-ai/agent-fs
\`\`\`

## Why agent-fs

Agents are the new users. They need a file system that speaks their language — APIs, search, and interop. Not mount points.

- **Agent-first** — Designed for autonomous agents to read, write, and share files across systems without human intervention.
- **CLI + MCP** — Full CLI for scripting and automation. MCP server for Claude Code, Codex, and any MCP-compatible agent.
- **Semantic search** — Find files by meaning, not just name. Full-text search and vector embeddings built in.
- **Self-hostable** — SQLite metadata + S3-compatible blob storage. Run anywhere. Your data stays yours.

## How agents use it

\`\`\`sh
agent-fs write report.md --content '...'
\`\`\`
Agents write files with full version history. Every change is tracked with diffs and timestamps.

\`\`\`sh
agent-fs search 'quarterly metrics'
\`\`\`
Find files by meaning using semantic search. Agents don't need to know file paths — just ask.

\`\`\`sh
agent-fs cat report.md
\`\`\`
Read files back. Any agent with access can retrieve what another agent wrote.

\`\`\`sh
agent-fs comment add report.md --content 'Needs revision'
\`\`\`
Leave comments on any file. Agents and humans can annotate, review, and discuss — Google Docs style.

\`\`\`sh
agent-fs drive invite agent@example.com
\`\`\`
Invite other agents or teammates to a shared drive. Collaboration across systems in one command.

## Links

- Source: https://github.com/desplega-ai/agent-fs
- Made by [Desplega Labs](https://desplega.sh)
`;

export const LLMS_TXT = `# agent-fs

> A sharable, searchable, persistent file system that any AI agent can use — via CLI or MCP.

agent-fs is a file system built for AI agents. It lets autonomous agents write, read,
search, comment on, and share files across systems — without human intervention.
Metadata is stored in SQLite and blobs in any S3-compatible storage, so it's
fully self-hostable.

## Quickstart

- Install: \`bun add -g @desplega.ai/agent-fs\`
- Onboard: \`agent-fs onboard\`
- Write: \`agent-fs write hello.md --content "# Hello from an agent"\`
- Claude Code skill: \`npx skills add desplega-ai/agent-fs\`

## Docs

- Homepage: https://agent-fs.dev
- Docs index: https://agent-fs.dev/docs
- Repository: https://github.com/desplega-ai/agent-fs
- Product overview: https://github.com/desplega-ai/agent-fs/blob/main/PRODUCT.md

### Getting started

- MCP setup: https://agent-fs.dev/docs/mcp-setup — connect agent-fs to Claude Code, Cursor, Codex, and other MCP clients
- Deployment: https://agent-fs.dev/docs/deployment — run locally, use remote S3, deploy services, and publish releases

### Reference

- API reference: https://agent-fs.dev/docs/api-reference — HTTP endpoints, auth, MCP transport, and operation dispatch
- SQL queries: https://agent-fs.dev/docs/sql — query CSV, Parquet, Excel, JSON, and SQLite documents with DuckDB
- OpenAPI spec: https://agent-fs.dev/docs/openapi.json

### Mounting (FUSE)

- Mounting overview: https://agent-fs.dev/docs/mounting — topologies, prerequisites, auth, and the remote mount flow
- FUSE mount: https://agent-fs.dev/docs/fuse-mount — mount an agent-fs drive as a Linux filesystem with open-to-close consistency
- FUSE compatibility: https://agent-fs.dev/docs/fuse-compat — sandbox and container runtime matrix for Linux FUSE support
- FUSE troubleshooting: https://agent-fs.dev/docs/fuse-troubleshooting — common mount errors, diagnosis order, and recovery commands
- Mounting on Sprite: https://agent-fs.dev/docs/mounting-sprite
- Mounting on E2B: https://agent-fs.dev/docs/mounting-e2b
- Mounting on Hetzner: https://agent-fs.dev/docs/mounting-hetzner

Every doc page is also available as raw markdown at the same path with a \`.md\` suffix
under \`/docs/\` (e.g. https://agent-fs.dev/docs/mcp-setup.md), suitable for agents that
prefer fetching markdown directly.

## Core commands

- \`agent-fs write <path> --content '...'\` — write a file (version-tracked)
- \`agent-fs cat <path>\` — read a file
- \`agent-fs search '<query>'\` — semantic search over stored files
- \`agent-fs fts '<query>'\` — full-text search over stored files
- \`agent-fs sql "SELECT * FROM '/data/sales.csv'"\` — DuckDB SQL over stored documents (csv, parquet, xlsx, json, sqlite)
- \`agent-fs comment add <path> --content '...'\` — leave a comment
- \`agent-fs drive invite <email>\` — share a drive with another agent or human

## Packages

- \`@desplega.ai/agent-fs\` — published CLI on npm
- Runs as a local daemon (HTTP API) or against a remote server
- MCP server included for Claude Code / Codex / any MCP-compatible client
`;
