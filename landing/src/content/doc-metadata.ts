export type DocSection = "Start" | "Reference" | "Mounting"

export type DocMetadata = {
  slug: string
  title: string
  summary: string
  section: DocSection
  sourcePath: string
}

export const DOC_METADATA: DocMetadata[] = [
  {
    slug: "api-reference",
    title: "API Reference",
    summary: "HTTP endpoints, auth, MCP transport, and operation dispatch.",
    section: "Reference",
    sourcePath: "docs/api-reference.md",
  },
  {
    slug: "mcp-setup",
    title: "MCP Setup",
    summary: "Connect agent-fs to Claude Code, Cursor, Codex, and other MCP clients.",
    section: "Start",
    sourcePath: "docs/mcp-setup.md",
  },
  {
    slug: "deployment",
    title: "Deployment",
    summary: "Run locally, use remote S3, deploy services, and publish releases.",
    section: "Start",
    sourcePath: "docs/deployment.md",
  },
  {
    slug: "sql",
    title: "SQL Queries",
    summary: "Query CSV, Parquet, Excel, JSON, and SQLite documents with DuckDB.",
    section: "Reference",
    sourcePath: "docs/sql.md",
  },
  {
    slug: "fuse-mount",
    title: "FUSE Mount",
    summary: "Mount an agent-fs drive as a Linux filesystem with open-to-close consistency.",
    section: "Mounting",
    sourcePath: "docs/fuse-mount.md",
  },
  {
    slug: "fuse-compat",
    title: "FUSE Compatibility",
    summary: "Sandbox and container runtime matrix for Linux FUSE support.",
    section: "Mounting",
    sourcePath: "docs/fuse-compat.md",
  },
  {
    slug: "fuse-troubleshooting",
    title: "FUSE Troubleshooting",
    summary: "Common mount errors, diagnosis order, and recovery commands.",
    section: "Mounting",
    sourcePath: "docs/fuse-troubleshooting.md",
  },
  {
    slug: "mounting",
    title: "Mounting Overview",
    summary: "Topologies, prerequisites, auth, and the remote mount flow.",
    section: "Mounting",
    sourcePath: "docs/mounting/README.md",
  },
  {
    slug: "mounting-sprite",
    title: "Mounting on Sprite",
    summary: "Prerequisites and remote mount flow for Sprite sandboxes.",
    section: "Mounting",
    sourcePath: "docs/mounting/sprite.md",
  },
  {
    slug: "mounting-e2b",
    title: "Mounting on E2B",
    summary: "Best-effort E2B sandbox template and mount flow.",
    section: "Mounting",
    sourcePath: "docs/mounting/e2b.md",
  },
  {
    slug: "mounting-hetzner",
    title: "Mounting on Hetzner",
    summary: "A clean VM install and systemd auto-mount path.",
    section: "Mounting",
    sourcePath: "docs/mounting/hetzner.md",
  },
]

export const DOC_SECTIONS = ["Start", "Reference", "Mounting"] as const
