# Sitemap — agent-fs.dev

Markdown mirror of [sitemap.xml](https://agent-fs.dev/sitemap.xml). Lists
every canonical URL the landing exposes, grouped by purpose, with the
machine-readable representation (where available) linked alongside.

## Landing

- [agent-fs.dev/](https://agent-fs.dev/) — Home / product overview.
  Markdown mirror: [/md/index.md](https://agent-fs.dev/md/index.md)

## Documentation

- [/docs](https://agent-fs.dev/docs) — Documentation index.
- [/docs/api-reference](https://agent-fs.dev/docs/api-reference) — HTTP API,
  auth, MCP transport, and operation dispatch.
- [/docs/mcp-setup](https://agent-fs.dev/docs/mcp-setup) — MCP client setup.
- [/docs/deployment](https://agent-fs.dev/docs/deployment) — Local and hosted
  deployment guide.
- [/docs/fuse-mount](https://agent-fs.dev/docs/fuse-mount) — Linux FUSE mount
  semantics.
- [/docs/fuse-compat](https://agent-fs.dev/docs/fuse-compat) — FUSE sandbox
  compatibility matrix.
- [/docs/fuse-troubleshooting](https://agent-fs.dev/docs/fuse-troubleshooting) —
  Mount troubleshooting guide.
- [/docs/mounting](https://agent-fs.dev/docs/mounting) — Remote mount overview.
- [/docs/mounting-sprite](https://agent-fs.dev/docs/mounting-sprite) — Sprite
  sandbox guide.
- [/docs/mounting-e2b](https://agent-fs.dev/docs/mounting-e2b) — E2B sandbox
  guide.
- [/docs/mounting-hetzner](https://agent-fs.dev/docs/mounting-hetzner) —
  Hetzner VM guide.

## Agent-readable artefacts

These are the canonical agent-facing entry points for the site. Send
`Accept: text/markdown` to `/` to receive the markdown form, or fetch
the `.md` URLs directly.

- [/llms.txt](https://agent-fs.dev/llms.txt) — llmstxt.org summary (markdown).
- [/AGENTS.md](https://agent-fs.dev/AGENTS.md) — usage / setup / conventions
  for AI agents consuming agent-fs.
- [/md/index.md](https://agent-fs.dev/md/index.md) — markdown mirror of the
  landing page.
- [/docs/*.md](https://agent-fs.dev/docs/api-reference.md) — generated markdown
  mirrors of the repository docs.
- [/docs/openapi.json](https://agent-fs.dev/docs/openapi.json) — OpenAPI schema.
- [/sitemap.xml](https://agent-fs.dev/sitemap.xml) — XML sitemap for crawlers.
- [/sitemap.md](https://agent-fs.dev/sitemap.md) — this file.
- [/robots.txt](https://agent-fs.dev/robots.txt) — robots policy.

## Off-site resources

External canonical sources for product documentation and code.

- [GitHub repository](https://github.com/desplega-ai/agent-fs) — source code,
  issues, releases.
- [Live agent-fs service](https://live.agent-fs.dev) — the running service
  agents read/write against.
- [npm: @desplega.ai/agent-fs](https://www.npmjs.com/package/@desplega.ai/agent-fs) —
  installable CLI package.
- [PRODUCT.md](https://github.com/desplega-ai/agent-fs/blob/main/PRODUCT.md) —
  product vision and positioning.
- [DEPLOYMENT.md](https://github.com/desplega-ai/agent-fs/blob/main/DEPLOYMENT.md) —
  self-hosting and release guide.

## Notes

agent-fs.dev is a Vite SPA. Documentation pages under `/docs/*` render from
the repository markdown sources, and static `/docs/*.md` artefacts are copied
from the same root `docs/` tree during the landing build.
