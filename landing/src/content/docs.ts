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
import { DOC_METADATA, DOC_SECTIONS, type DocMetadata } from "./doc-metadata"

export type DocEntry = DocMetadata & {
  markdown: string
}

const MARKDOWN_BY_SLUG: Record<string, string> = {
  "api-reference": apiReference,
  "mcp-setup": mcpSetup,
  deployment,
  sql: sqlQueries,
  "fuse-mount": fuseMount,
  "fuse-compat": fuseCompat,
  "fuse-troubleshooting": fuseTroubleshooting,
  mounting: mountingOverview,
  "mounting-sprite": mountingSprite,
  "mounting-e2b": mountingE2b,
  "mounting-hetzner": mountingHetzner,
}

export const DOCS: DocEntry[] = DOC_METADATA.map((doc) => ({
  ...doc,
  markdown: MARKDOWN_BY_SLUG[doc.slug],
}))

export { DOC_METADATA, DOC_SECTIONS }

export function getDocBySlug(slug: string | undefined): DocEntry {
  return DOCS.find((doc) => doc.slug === slug) ?? DOCS[0]
}
