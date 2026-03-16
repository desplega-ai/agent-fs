# agent-fs — Product Vision

## Tagline

**Give agents a sharable file system, instantly.**

## What is agent-fs?

agent-fs is to files what [agentmail](https://agentmail.to) is to email — a purpose-built infrastructure primitive that gives AI agents a shared, persistent file system they can read, write, search, and collaborate through.

## Core Value Proposition

Agents need a way to share files with each other and with humans. agent-fs provides:

- **Shared file storage** — agents can write files that other agents (or humans) can read
- **Full-text & semantic search** — find files by content, not just path
- **Comments & annotations** — leave structured feedback on files (like Google Docs comments)
- **MCP integration** — works out-of-the-box with any MCP-compatible agent
- **S3-compatible backend** — use MinIO locally or any S3-compatible storage in production

## Target Users

1. **Agent developers** building multi-agent architectures who need shared file state
2. **Platform teams** deploying agent infrastructure
3. **Individual developers** who want their AI assistants to have persistent file access

## Key Differentiators

- **Agent-first API** — designed for programmatic access, not human UIs
- **MCP-native** — first-class Model Context Protocol support
- **Self-hostable** — run locally with SQLite + MinIO, or deploy to any S3-compatible cloud
- **Semantic search** — OpenAI embeddings for finding files by meaning, not just keywords
