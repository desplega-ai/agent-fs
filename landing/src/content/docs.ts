import apiReference from "../../../docs/api-reference.md?raw"
import deployment from "../../../docs/deployment.md?raw"
import fuseCompat from "../../../docs/fuse-compat.md?raw"
import fuseMount from "../../../docs/fuse-mount.md?raw"
import fuseTroubleshooting from "../../../docs/fuse-troubleshooting.md?raw"
import mcpSetup from "../../../docs/mcp-setup.md?raw"
import mountingOverview from "../../../docs/mounting/README.md?raw"
import mountingE2b from "../../../docs/mounting/e2b.md?raw"
import mountingHetzner from "../../../docs/mounting/hetzner.md?raw"
import mountingSprite from "../../../docs/mounting/sprite.md?raw"
import sqlQueries from "../../../docs/sql.md?raw"

export type DocEntry = {
  slug: string
  title: string
  summary: string
  section: "Start" | "Reference" | "Mounting"
  sourcePath: string
  markdown: string
}

export const DOCS: DocEntry[] = [
  {
    slug: "api-reference",
    title: "API Reference",
    summary: "HTTP endpoints, auth, MCP transport, and operation dispatch.",
    section: "Reference",
    sourcePath: "docs/api-reference.md",
    markdown: apiReference,
  },
  {
    slug: "mcp-setup",
    title: "MCP Setup",
    summary: "Connect agent-fs to Claude Code, Cursor, Codex, and other MCP clients.",
    section: "Start",
    sourcePath: "docs/mcp-setup.md",
    markdown: mcpSetup,
  },
  {
    slug: "deployment",
    title: "Deployment",
    summary: "Run locally, use remote S3, deploy services, and publish releases.",
    section: "Start",
    sourcePath: "docs/deployment.md",
    markdown: deployment,
  },
  {
    slug: "sql",
    title: "SQL Queries",
    summary: "Query CSV, Parquet, Excel, JSON, and SQLite documents with DuckDB.",
    section: "Reference",
    sourcePath: "docs/sql.md",
    markdown: sqlQueries,
  },
  {
    slug: "fuse-mount",
    title: "FUSE Mount",
    summary: "Mount an agent-fs drive as a Linux filesystem with open-to-close consistency.",
    section: "Mounting",
    sourcePath: "docs/fuse-mount.md",
    markdown: fuseMount,
  },
  {
    slug: "fuse-compat",
    title: "FUSE Compatibility",
    summary: "Sandbox and container runtime matrix for Linux FUSE support.",
    section: "Mounting",
    sourcePath: "docs/fuse-compat.md",
    markdown: fuseCompat,
  },
  {
    slug: "fuse-troubleshooting",
    title: "FUSE Troubleshooting",
    summary: "Common mount errors, diagnosis order, and recovery commands.",
    section: "Mounting",
    sourcePath: "docs/fuse-troubleshooting.md",
    markdown: fuseTroubleshooting,
  },
  {
    slug: "mounting",
    title: "Mounting Overview",
    summary: "Topologies, prerequisites, auth, and the remote mount flow.",
    section: "Mounting",
    sourcePath: "docs/mounting/README.md",
    markdown: mountingOverview,
  },
  {
    slug: "mounting-sprite",
    title: "Mounting on Sprite",
    summary: "Prerequisites and remote mount flow for Sprite sandboxes.",
    section: "Mounting",
    sourcePath: "docs/mounting/sprite.md",
    markdown: mountingSprite,
  },
  {
    slug: "mounting-e2b",
    title: "Mounting on E2B",
    summary: "Best-effort E2B sandbox template and mount flow.",
    section: "Mounting",
    sourcePath: "docs/mounting/e2b.md",
    markdown: mountingE2b,
  },
  {
    slug: "mounting-hetzner",
    title: "Mounting on Hetzner",
    summary: "A clean VM install and systemd auto-mount path.",
    section: "Mounting",
    sourcePath: "docs/mounting/hetzner.md",
    markdown: mountingHetzner,
  },
]

export const DOC_SECTIONS = ["Start", "Reference", "Mounting"] as const

export function getDocBySlug(slug: string | undefined): DocEntry {
  return DOCS.find((doc) => doc.slug === slug) ?? DOCS[0]
}
