# MCP Setup Guide

Connect agent-fs to any MCP-compatible AI assistant (Claude Code, Cursor, Windsurf, etc.).

## Claude Code

Add to your `.mcp.json` (project-level or `~/.claude/.mcp.json` for global):

```json
{
  "mcpServers": {
    "agent-fs": {
      "command": "agent-fs",
      "args": ["mcp"],
      "env": {
        "AGENT_FS_API_URL": "http://localhost:7433",
        "AGENT_FS_API_KEY": "your-api-key"
      }
    }
  }
}
```

For local/embedded mode (no server required):

```json
{
  "mcpServers": {
    "agent-fs": {
      "command": "agent-fs",
      "args": ["mcp"]
    }
  }
}
```

### With embeddings

To enable semantic search, add your embedding provider API key:

```json
{
  "mcpServers": {
    "agent-fs": {
      "command": "agent-fs",
      "args": ["mcp"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

Supported providers: `OPENAI_API_KEY` (OpenAI), `GEMINI_API_KEY` (Google Gemini), or local llama.cpp (configured in `~/.agent-fs/config.json`).

## Cursor

Add to your Cursor MCP settings (Settings > MCP Servers):

```json
{
  "agent-fs": {
    "command": "agent-fs",
    "args": ["mcp"],
    "env": {
      "AGENT_FS_API_URL": "http://localhost:7433",
      "AGENT_FS_API_KEY": "your-api-key"
    }
  }
}
```

## Generic MCP Client (stdio transport)

agent-fs uses **stdio transport**. Spawn the process and communicate via JSON-RPC over stdin/stdout:

```bash
agent-fs mcp
```

The server advertises tools via the standard MCP `tools/list` method.

## Available Tools

### Content Operations

| Tool | Description |
|------|-------------|
| `write` | Write or overwrite a file. Creates a new version. Use `expectedVersion` for optimistic concurrency. |
| `cat` | Read file content with optional pagination via `offset`/`limit`. |
| `edit` | Replace a specific string in a file (surgical find-and-replace). |
| `append` | Append content to the end of an existing file. |
| `tail` | Read the last N lines of a file. |

### Navigation

| Tool | Description |
|------|-------------|
| `ls` | List immediate children of a directory. Path defaults to `/` (root). |
| `stat` | Get file metadata without reading content. |
| `tree` | Recursively list all files and directories. Path defaults to `/` (root). Use `depth` to limit. |
| `glob` | Find files by pattern. `*.md` matches root only; `**/*.md` matches recursively. |

### File Management

| Tool | Description |
|------|-------------|
| `rm` | Delete a file. Removes from S3, cleans up FTS5 and embeddings. |
| `mv` | Move or rename a file. Preserves version history. |
| `cp` | Copy a file using server-side S3 copy. |

### Version Control

| Tool | Description |
|------|-------------|
| `log` | Show version history for a file. |
| `diff` | Show the diff between two versions of a file. |
| `revert` | Revert a file to a previous version. Creates a new version with the old content. |

### Search

| Tool | Description |
|------|-------------|
| `grep` | Regex search across file content via FTS5 index. |
| `fts` | Full-text keyword search across all files using FTS5 tokens. |
| `search` | Semantic search using natural language (requires embedding provider). |

### Maintenance

| Tool | Description |
|------|-------------|
| `recent` | Show recent activity. Filter by path prefix and time window. |
| `reindex` | Re-index files with failed or missing FTS5/embedding entries. |

### Comments

| Tool | Description |
|------|-------------|
| `comment-add` | Add a comment to a file. Supports line ranges and threading. |
| `comment-list` | List comments on a file with inline replies. Filter by path, resolved state, or parent. |
| `comment-get` | Get a single comment by ID with all replies. |
| `comment-update` | Update a comment's body (author only). |
| `comment-delete` | Soft-delete a comment (author only). |
| `comment-resolve` | Resolve or reopen a root comment. |

## Which Search Tool Should I Use?

agent-fs has three search tools for different use cases:

| Tool | Use When | Example |
|------|----------|---------|
| `grep` | You know the exact text or pattern | `grep --pattern "TODO"` |
| `fts` | You know keywords but not exact text | `fts --query "authentication middleware"` |
| `search` | You want to find by meaning/concept | `search --query "how does auth work?"` |

**`grep`** is fastest — it uses regex against the FTS5 index. Use for exact strings, patterns, variable names.

**`fts`** is keyword-based full-text search. Use when you know relevant terms but not the exact phrasing. Supports FTS5 query syntax (AND, OR, NOT, phrases).

**`search`** is semantic/vector search. Use when you want to find files by meaning, not keywords. Requires an embedding provider (OpenAI, Gemini, or local llama.cpp). Best for questions like "files related to user authentication" where keyword matching would miss relevant results.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `AGENT_FS_API_URL` | Server URL (e.g., `http://localhost:7433`) | For remote mode |
| `AGENT_FS_API_KEY` | API key for authentication | For remote mode |
| `AGENT_FS_HOME` | Data directory (default: `~/.agent-fs`) | No |
| `OPENAI_API_KEY` | OpenAI API key for embeddings | For semantic search |
| `GEMINI_API_KEY` | Google Gemini API key for embeddings | For semantic search |

## Troubleshooting

### "No embedding provider configured"

Semantic search (`search` tool) requires an embedding provider. Set `OPENAI_API_KEY` or `GEMINI_API_KEY` in your MCP config's `env` block, or configure a provider in `~/.agent-fs/config.json`.

### "Connection refused" in remote mode

Ensure the agent-fs server is running (`agent-fs server`) and the `AGENT_FS_API_URL` matches. Default port is 7433.

### Tools not appearing

Restart your MCP client after updating the config. Check that `agent-fs` is in your PATH (`which agent-fs`).
