import { DOC_METADATA, getDocMetadataBySlug } from "./content/doc-metadata"

const SITE_URL = "https://agent-fs.dev"
const SITE_NAME = "agent-fs"
const HOME_TITLE = "agent-fs — A file system built for AI agents"
const HOME_DESCRIPTION =
  "A sharable, searchable, persistent file system that any AI agent can use — via CLI or MCP. Write, search, comment, and share files across systems."
const OG_IMAGE = `${SITE_URL}/og.png`

export type RouteSeo = {
  title: string
  description: string
  canonical: string
  ogType: "website" | "article"
}

export const PRERENDER_ROUTES = [
  "/",
  "/docs",
  ...DOC_METADATA.map((doc) => `/docs/${doc.slug}`),
] as const

export function getRouteSeo(route: string): RouteSeo {
  const normalized = route.replace(/\/$/, "") || "/"

  if (normalized === "/docs") {
    return {
      title: "agent-fs docs — Build against the agent filesystem",
      description:
        "Documentation for agent-fs setup, deployment, API usage, SQL queries, and FUSE mounting.",
      canonical: `${SITE_URL}/docs`,
      ogType: "website",
    }
  }

  if (normalized.startsWith("/docs/")) {
    const slug = normalized.replace(/^\/docs\//, "")
    const doc = getDocMetadataBySlug(slug)
    return {
      title: `${doc.title} — agent-fs docs`,
      description: doc.summary,
      canonical: `${SITE_URL}/docs/${doc.slug}`,
      ogType: "article",
    }
  }

  return {
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    canonical: SITE_URL,
    ogType: "website",
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function metaTag(name: string, content: string) {
  return `<meta name="${name}" content="${escapeHtml(content)}" />`
}

function propertyTag(property: string, content: string) {
  return `<meta property="${property}" content="${escapeHtml(content)}" />`
}

export function renderHeadTags(route: string) {
  const seo = getRouteSeo(route)
  const alternateMarkdown =
    seo.canonical === SITE_URL
      ? `${SITE_URL}/md/index.md`
      : seo.canonical.startsWith(`${SITE_URL}/docs/`)
        ? `${seo.canonical}.md`
        : null
  const jsonLd =
    seo.ogType === "article"
      ? `\n    <script type="application/ld+json">${JSON.stringify({
          "@context": "https://schema.org",
          "@type": "TechArticle",
          headline: seo.title.replace(" — agent-fs docs", ""),
          description: seo.description,
          url: seo.canonical,
          inLanguage: "en",
          isPartOf: { "@type": "WebSite", name: SITE_NAME, url: SITE_URL },
        }).replace(/</g, "\\u003c")}</script>`
      : ""

  return [
    `<title>${escapeHtml(seo.title)}</title>`,
    metaTag("description", seo.description),
    `<link rel="canonical" href="${escapeHtml(seo.canonical)}" />`,
    alternateMarkdown
      ? `<link rel="alternate" type="text/markdown" href="${escapeHtml(alternateMarkdown)}" />`
      : "",
    propertyTag("og:type", seo.ogType),
    propertyTag("og:title", seo.title),
    propertyTag("og:description", seo.description),
    propertyTag("og:url", seo.canonical),
    propertyTag("og:site_name", SITE_NAME),
    propertyTag("og:image", OG_IMAGE),
    propertyTag("og:image:width", "1200"),
    propertyTag("og:image:height", "630"),
    metaTag("twitter:card", "summary_large_image"),
    metaTag("twitter:title", seo.title),
    metaTag("twitter:description", seo.description),
    metaTag("twitter:image", OG_IMAGE),
  ]
    .filter(Boolean)
    .join("\n    ") + jsonLd
}
