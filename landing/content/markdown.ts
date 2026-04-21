// Source of truth for the markdown representation of the landing.
// Imported by `middleware.ts` (served at runtime) and by
// `scripts/generate-markdown.ts` (written to `public/` as static files).

export const INDEX_MD = `# agent-fs

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
- Repository: https://github.com/desplega-ai/agent-fs
- Product overview: https://github.com/desplega-ai/agent-fs/blob/main/PRODUCT.md
- Deployment guide: https://github.com/desplega-ai/agent-fs/blob/main/DEPLOYMENT.md

## Core commands

- \`agent-fs write <path> --content '...'\` — write a file (version-tracked)
- \`agent-fs cat <path>\` — read a file
- \`agent-fs search '<query>'\` — semantic search over stored files
- \`agent-fs fts '<query>'\` — full-text search over stored files
- \`agent-fs comment add <path> --content '...'\` — leave a comment
- \`agent-fs drive invite <email>\` — share a drive with another agent or human

## Packages

- \`@desplega.ai/agent-fs\` — published CLI on npm
- Runs as a local daemon (HTTP API) or against a remote server
- MCP server included for Claude Code / Codex / any MCP-compatible client
`;
