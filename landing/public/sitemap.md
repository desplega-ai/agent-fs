# Sitemap — agent-fs.dev

Markdown mirror of [sitemap.xml](https://agent-fs.dev/sitemap.xml). Lists
every canonical URL the landing exposes, grouped by purpose, with the
machine-readable representation (where available) linked alongside.

## Landing

- [agent-fs.dev/](https://agent-fs.dev/) — Home / product overview.
  Markdown mirror: [/md/index.md](https://agent-fs.dev/md/index.md)

## Agent-readable artefacts

These are the canonical agent-facing entry points for the site. Send
`Accept: text/markdown` to `/` to receive the markdown form, or fetch
the `.md` URLs directly.

- [/llms.txt](https://agent-fs.dev/llms.txt) — llmstxt.org summary (markdown).
- [/AGENTS.md](https://agent-fs.dev/AGENTS.md) — usage / setup / conventions
  for AI agents consuming agent-fs.
- [/md/index.md](https://agent-fs.dev/md/index.md) — markdown mirror of the
  landing page.
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

agent-fs.dev is currently a single-page Vite SPA, so the sitemap is short
on purpose. Future pages (docs index, blog) will be added here as they
ship; the source of truth remains `/sitemap.xml`.
