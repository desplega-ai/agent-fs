import { BookOpen, ChevronRight, ExternalLink, FileCode2, Menu, Search, X } from "lucide-react"
import { Highlight, type Language } from "prism-react-renderer"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"

import { DOC_SECTIONS, DOCS, getDocBySlug, type DocEntry } from "@/content/docs"
import { agentFsDark, agentFsLight } from "@/lib/code-theme"
import { useTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"

const PRISM_LANGUAGE_MAP: Record<string, Language> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  yml: "yaml",
  py: "python",
}

const PRISM_SUPPORTED: Language[] = [
  "bash",
  "javascript",
  "jsx",
  "typescript",
  "tsx",
  "json",
  "yaml",
  "python",
  "markup",
  "css",
  "diff",
  "graphql",
  "markdown",
  "sql",
]

function resolveLanguage(raw: string): Language | null {
  if (!raw) return null
  const normalized = raw.toLowerCase()
  const mapped = PRISM_LANGUAGE_MAP[normalized] ?? (normalized as Language)
  return PRISM_SUPPORTED.includes(mapped) ? mapped : null
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const { theme } = useTheme()
  const prismTheme = theme === "light" ? agentFsLight : agentFsDark
  const prismLanguage = resolveLanguage(language)

  return (
    <figure className="my-6 overflow-hidden rounded-md border border-border bg-background/80">
      {language ? (
        <figcaption className="border-b border-border px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {language}
        </figcaption>
      ) : null}
      {prismLanguage ? (
        <Highlight code={code} language={prismLanguage} theme={prismTheme}>
          {({ className, style, tokens, getLineProps, getTokenProps }) => (
            <pre
              className={cn(className, "overflow-x-auto p-4 text-sm leading-6")}
              style={{ ...style, background: "transparent" }}
            >
              <code>
                {tokens.map((line, i) => (
                  <div key={i} {...getLineProps({ line })}>
                    {line.map((token, key) => (
                      <span key={key} {...getTokenProps({ token })} />
                    ))}
                  </div>
                ))}
              </code>
            </pre>
          )}
        </Highlight>
      ) : (
        <pre className="overflow-x-auto p-4 text-sm leading-6 text-foreground/85">
          <code>{code}</code>
        </pre>
      )}
    </figure>
  )
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

function stripMarkdown(value: string) {
  return value
    .replace(/[`*_#>\[\]]/g, "")
    .replace(/\((https?:\/\/[^)]+)\)/g, "")
    .trim()
}

function splitMarkdownTableRow(line: string) {
  const cells: string[] = []
  let cell = ""
  let inCode = false

  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (char === "`") inCode = !inCode
    if (char === "|" && !inCode) {
      cells.push(cell.trim())
      cell = ""
      continue
    }
    cell += char
  }

  cells.push(cell.trim())
  if (cells[0] === "") cells.shift()
  if (cells[cells.length - 1] === "") cells.pop()
  return cells
}

type Heading = { level: number; title: string; id: string }

function getHeadings(markdown: string): Heading[] {
  return markdown
    .split("\n")
    .filter((line) => /^#{2,3}\s+/.test(line))
    .map((line) => {
      const level = line.startsWith("###") ? 3 : 2
      const title = stripMarkdown(line.replace(/^#{2,3}\s+/, ""))
      return { level, title, id: slugify(title) }
    })
}

function docHrefForMarkdown(sourcePath: string, href: string) {
  if (/^(https?:|mailto:|#)/.test(href)) return href

  const normalized = new URL(href, `https://agent-fs.dev/${sourcePath}`).pathname.replace(/^\//, "")
  if (!normalized.startsWith("docs/")) return href

  const withoutPrefix = normalized.replace(/^docs\//, "")
  const withoutExtension = withoutPrefix.replace(/\.md(#.*)?$/, "")
  if (withoutExtension === "mounting/README") return "/docs/mounting"

  const routeSlug = withoutExtension
    .replace(/^mounting\//, "mounting-")
    .replace(/\//g, "-")

  return `/docs/${routeSlug}`
}

function parseInline(text: string, sourcePath: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const tokenPattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g
  let lastIndex = 0
  let index = 0

  for (const match of text.matchAll(tokenPattern)) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))

    const token = match[0]
    if (token.startsWith("`")) {
      nodes.push(
        <code key={index++} className="rounded bg-neon/10 px-1.5 py-0.5 font-mono text-[0.88em] text-neon">
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith("**")) {
      nodes.push(
        <strong key={index++} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>,
      )
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (linkMatch) {
        const href = docHrefForMarkdown(sourcePath, linkMatch[2])
        const external = /^https?:\/\//.test(href)
        nodes.push(
          <a
            key={index++}
            href={href}
            target={external ? "_blank" : undefined}
            rel={external ? "noreferrer" : undefined}
            className="text-neon underline decoration-neon/30 underline-offset-4 transition hover:decoration-neon"
          >
            {linkMatch[1]}
          </a>,
        )
      }
    }

    lastIndex = match.index + token.length
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

function MarkdownContent({ doc }: { doc: DocEntry }) {
  const markdown = doc.markdown
  const lines = markdown.split("\n")
  const blocks: ReactNode[] = []
  let index = 0
  let key = 0

  while (index < lines.length) {
    const line = lines[index]

    if (!line.trim()) {
      index++
      continue
    }

    if (line.startsWith("```")) {
      const language = line.slice(3).trim()
      const code: string[] = []
      index++
      while (index < lines.length && !lines[index].startsWith("```")) {
        code.push(lines[index])
        index++
      }
      index++
      blocks.push(<CodeBlock key={key++} code={code.join("\n")} language={language} />)
      continue
    }

    if (/^#{1,4}\s+/.test(line)) {
      const level = line.match(/^#+/)?.[0].length ?? 2
      const text = stripMarkdown(line.replace(/^#{1,4}\s+/, ""))
      const id = slugify(text)
      if (level === 1) {
        index++
        continue
      }

      const className = cn(
        "scroll-mt-24 font-bold tracking-tight text-foreground",
        level === 1 && "mt-0 text-4xl",
        level === 2 && "mt-12 border-t border-border pt-10 text-2xl",
        level === 3 && "mt-8 text-xl",
        level >= 4 && "mt-6 text-base",
      )
      const Tag = `h${Math.min(level, 4)}` as "h1" | "h2" | "h3" | "h4"
      blocks.push(
        <Tag key={key++} id={id} className={className}>
          {parseInline(text, doc.sourcePath)}
        </Tag>,
      )
      index++
      continue
    }

    if (line.startsWith(">")) {
      const quote: string[] = []
      while (index < lines.length && lines[index].startsWith(">")) {
        quote.push(lines[index].replace(/^>\s?/, ""))
        index++
      }
      blocks.push(
        <blockquote key={key++} className="my-6 border-l-2 border-neon/70 pl-5 text-sm leading-7 text-foreground/80">
          {quote.map((part, quoteIndex) => (
            <p key={quoteIndex}>{parseInline(part, doc.sourcePath)}</p>
          ))}
        </blockquote>,
      )
      continue
    }

    if (/^\|.+\|$/.test(line) && /^\|[-:\s|]+$/.test(lines[index + 1] ?? "")) {
      const headers = splitMarkdownTableRow(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && /^\|.+\|$/.test(lines[index])) {
        rows.push(splitMarkdownTableRow(lines[index]))
        index++
      }
      blocks.push(
        <div key={key++} className="my-6 overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <thead className="bg-neon/10 text-foreground">
              <tr>
                {headers.map((header) => (
                  <th key={header} className="border-b border-border px-4 py-3 font-mono text-xs">
                    {parseInline(header, doc.sourcePath)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-border/70 last:border-0">
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="px-4 py-3 align-top text-muted-foreground">
                      {parseInline(cell, doc.sourcePath)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }

    if (/^(\d+\.|-)\s+/.test(line)) {
      const ordered = /^\d+\.\s+/.test(line)
      const items: string[] = []
      const itemPattern = ordered ? /^\d+\.\s+/ : /^-\s+/
      while (index < lines.length && itemPattern.test(lines[index])) {
        items.push(lines[index].replace(itemPattern, ""))
        index++
      }
      const ListTag = ordered ? "ol" : "ul"
      blocks.push(
        <ListTag
          key={key++}
          className={cn(
            "my-5 space-y-2 pl-6 text-sm leading-7 text-muted-foreground",
            ordered ? "list-decimal" : "list-disc",
          )}
        >
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{parseInline(item, doc.sourcePath)}</li>
          ))}
        </ListTag>,
      )
      continue
    }

    const paragraph: string[] = []
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^#{1,4}\s+/.test(lines[index]) &&
      !lines[index].startsWith("```") &&
      !lines[index].startsWith(">") &&
      !/^\|.+\|$/.test(lines[index]) &&
      !/^(\d+\.|-)\s+/.test(lines[index])
    ) {
      paragraph.push(lines[index].trim())
      index++
    }

    blocks.push(
      <p key={key++} className="my-4 text-sm leading-7 text-muted-foreground">
        {parseInline(paragraph.join(" "), doc.sourcePath)}
      </p>,
    )
  }

  return <div className="docs-markdown">{blocks}</div>
}

function DocNavLink({ doc, active }: { doc: DocEntry; active: boolean }) {
  return (
    <a
      href={`/docs/${doc.slug}`}
      className={cn(
        "block border-l px-4 py-3 transition",
        active
          ? "border-neon bg-neon/10 text-foreground"
          : "border-border text-muted-foreground hover:border-neon/50 hover:bg-card/70 hover:text-foreground",
      )}
    >
      <span className="block font-mono text-xs">{doc.title}</span>
      <span className="mt-1 block text-xs leading-5 text-muted-foreground">{doc.summary}</span>
    </a>
  )
}

function DocSidebarNav({ activeSlug }: { activeSlug: string }) {
  return (
    <nav className="space-y-6" aria-label="Documentation">
      {DOC_SECTIONS.map((section) => {
        const docs = DOCS.filter((doc) => doc.section === section)
        if (docs.length === 0) return null
        return (
          <section key={section}>
            <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground/70">
              {section}
            </h2>
            <div>
              {docs.map((doc) => (
                <DocNavLink key={doc.slug} doc={doc} active={doc.slug === activeSlug} />
              ))}
            </div>
          </section>
        )
      })}
    </nav>
  )
}

type SearchHit = {
  doc: DocEntry
  heading?: Heading
  excerpt: string
  score: number
}

function buildSearchHits(query: string): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const terms = q.split(/\s+/).filter(Boolean)
  const hits: SearchHit[] = []

  for (const doc of DOCS) {
    const titleLower = doc.title.toLowerCase()
    const summaryLower = doc.summary.toLowerCase()
    let titleScore = 0
    for (const t of terms) {
      if (titleLower.includes(t)) titleScore += 8
      if (summaryLower.includes(t)) titleScore += 3
    }
    if (titleScore > 0) {
      hits.push({ doc, excerpt: doc.summary, score: titleScore + 5 })
    }

    const lines = doc.markdown.split("\n")
    let currentHeading: Heading | undefined
    for (const line of lines) {
      const headingMatch = /^(#{2,3})\s+(.+)$/.exec(line)
      if (headingMatch) {
        const level = headingMatch[1].length
        const title = stripMarkdown(headingMatch[2])
        currentHeading = { level, title, id: slugify(title) }
        const lower = title.toLowerCase()
        let score = 0
        for (const t of terms) if (lower.includes(t)) score += 6
        if (score > 0) {
          hits.push({ doc, heading: currentHeading, excerpt: title, score })
        }
        continue
      }
      const lower = line.toLowerCase()
      let score = 0
      for (const t of terms) if (lower.includes(t)) score += 1
      if (score >= terms.length && line.trim()) {
        hits.push({
          doc,
          heading: currentHeading,
          excerpt: line.trim().slice(0, 180),
          score,
        })
      }
    }
  }

  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, 30)
}

function SearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const hits = useMemo(() => buildSearchHits(query), [query])

  useEffect(() => {
    if (open) {
      setQuery("")
      setSelected(0)
      setTimeout(() => inputRef.current?.focus(), 10)
    }
  }, [open])

  useEffect(() => {
    setSelected(0)
  }, [query])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose()
        return
      }
      if (hits.length === 0) return
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setSelected((s) => (s + 1) % hits.length)
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setSelected((s) => (s - 1 + hits.length) % hits.length)
      } else if (e.key === "Enter") {
        const hit = hits[selected]
        if (!hit) return
        e.preventDefault()
        const href = hit.heading ? `/docs/${hit.doc.slug}#${hit.heading.id}` : `/docs/${hit.doc.slug}`
        window.location.href = href
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose, hits, selected])

  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${selected}"]`)
    el?.scrollIntoView({ block: "nearest" })
  }, [selected, open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-background/80 px-4 pt-20 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Search className="size-4 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search docs..."
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            ESC
          </kbd>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {query.trim() === "" ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              Type to search across all docs.
            </div>
          ) : hits.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No results for "{query}"
            </div>
          ) : (
            <ul ref={listRef} className="divide-y divide-border">
              {hits.map((hit, i) => {
                const href = hit.heading ? `/docs/${hit.doc.slug}#${hit.heading.id}` : `/docs/${hit.doc.slug}`
                const isSelected = i === selected
                return (
                  <li key={i} data-idx={i}>
                    <a
                      href={href}
                      onClick={onClose}
                      onMouseEnter={() => setSelected(i)}
                      className={cn(
                        "block px-4 py-3 transition",
                        isSelected ? "bg-neon/15" : "hover:bg-neon/10",
                      )}
                    >
                      <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-neon/70">
                        <span>{hit.doc.section}</span>
                        <ChevronRight className="size-3" aria-hidden="true" />
                        <span className="text-muted-foreground">{hit.doc.title}</span>
                        {hit.heading ? (
                          <>
                            <ChevronRight className="size-3" aria-hidden="true" />
                            <span className="text-muted-foreground">{hit.heading.title}</span>
                          </>
                        ) : null}
                      </div>
                      <p className="mt-1 text-sm text-foreground line-clamp-2">{hit.excerpt}</p>
                    </a>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function SearchButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md border border-border bg-card/60 px-3 py-2 text-left text-xs text-muted-foreground transition hover:border-neon/50 hover:text-foreground",
        className,
      )}
    >
      <Search className="size-3.5" aria-hidden="true" />
      <span className="flex-1">Search docs...</span>
      <kbd className="hidden rounded border border-border px-1.5 py-0.5 font-mono text-[10px] sm:inline">
        ⌘K
      </kbd>
    </button>
  )
}

function useActiveHeading(slug: string): string {
  const [activeId, setActiveId] = useState<string>("")
  useEffect(() => {
    const article = document.querySelector("article.docs-article")
    if (!article) return
    const headings = Array.from(article.querySelectorAll<HTMLElement>("h2[id], h3[id]"))
    if (headings.length === 0) return

    const update = () => {
      const scrollY = window.scrollY + 120
      let current = headings[0].id
      for (const h of headings) {
        if (h.offsetTop <= scrollY) current = h.id
        else break
      }
      setActiveId(current)
    }
    update()
    window.addEventListener("scroll", update, { passive: true })
    window.addEventListener("resize", update)
    return () => {
      window.removeEventListener("scroll", update)
      window.removeEventListener("resize", update)
    }
  }, [slug])
  return activeId
}

function MobileDrawer({
  open,
  onClose,
  activeSlug,
}: {
  open: boolean
  onClose: () => void
  activeSlug: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = ""
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-[90] lg:hidden" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" onClick={onClose} />
      <div className="absolute inset-y-0 left-0 flex w-[85%] max-w-sm flex-col overflow-y-auto border-r border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <a href="/" className="font-mono text-sm font-medium text-foreground">
            agent-fs
          </a>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-card/80 hover:text-foreground"
            aria-label="Close menu"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 px-4 py-4">
          <DocSidebarNav activeSlug={activeSlug} />
        </div>
      </div>
    </div>
  )
}

const SIDEBAR_SCROLL_KEY = "docs:sidebar:scrollTop"

export function DocsPage({ slug }: { slug?: string }) {
  const activeDoc = getDocBySlug(slug)
  const headings = useMemo(() => getHeadings(activeDoc.markdown), [activeDoc])
  const [searchOpen, setSearchOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const activeId = useActiveHeading(activeDoc.slug)
  const sidebarRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  useEffect(() => {
    const stored = sessionStorage.getItem(SIDEBAR_SCROLL_KEY)
    if (stored && sidebarRef.current) {
      sidebarRef.current.scrollTop = Number(stored) || 0
    }
  }, [])

  const onSidebarScroll = () => {
    if (sidebarRef.current) {
      sessionStorage.setItem(SIDEBAR_SCROLL_KEY, String(sidebarRef.current.scrollTop))
    }
  }

  return (
    <main className="mx-auto grid w-full max-w-screen-2xl gap-8 px-4 pb-20 pt-24 sm:px-6 lg:grid-cols-[260px_minmax(0,1fr)_220px] lg:gap-10 lg:px-10 lg:pt-28">
      <aside
        ref={sidebarRef}
        onScroll={onSidebarScroll}
        className="hidden lg:sticky lg:top-20 lg:block lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto lg:pr-4 docs-sidebar-scroll"
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <BookOpen className="size-4 text-neon" aria-hidden="true" />
          Docs
        </div>
        <div className="mt-4">
          <SearchButton onClick={() => setSearchOpen(true)} />
        </div>
        <div className="mt-6">
          <DocSidebarNav activeSlug={activeDoc.slug} />
        </div>
      </aside>

      <article className="docs-article min-w-0">
        <div className="mb-4 flex items-center gap-2 lg:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 font-mono text-xs text-muted-foreground transition hover:border-neon/50 hover:text-foreground"
            aria-label="Open navigation"
          >
            <Menu className="size-4" aria-hidden="true" />
            Docs menu
          </button>
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="inline-flex flex-1 items-center gap-2 rounded-md border border-border px-3 py-2 font-mono text-xs text-muted-foreground transition hover:border-neon/50 hover:text-foreground"
          >
            <Search className="size-3.5" aria-hidden="true" />
            <span className="flex-1 text-left">Search</span>
          </button>
        </div>

        <div className="mb-8 rounded-md border border-border bg-card/70 p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-widest text-neon/70">
                {activeDoc.sourcePath}
              </p>
              <h1 className="mt-3 text-4xl font-bold tracking-tight text-foreground">{activeDoc.title}</h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">{activeDoc.summary}</p>
            </div>
            <a
              href={`/docs/${activeDoc.sourcePath.replace(/^docs\//, "")}`}
              className="inline-flex shrink-0 items-center gap-2 rounded-md border border-border px-3 py-2 font-mono text-xs text-muted-foreground transition hover:border-neon/50 hover:text-neon"
            >
              <FileCode2 className="size-4" aria-hidden="true" />
              Markdown
            </a>
          </div>
        </div>

        <MarkdownContent doc={activeDoc} />
      </article>

      <aside className="hidden lg:sticky lg:top-20 lg:block lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto docs-sidebar-scroll">
        <h2 className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground/70">On this page</h2>
        <nav className="mt-4 space-y-1" aria-label="Page sections">
          {headings.map((heading, index) => {
            const isActive = heading.id === activeId
            return (
              <a
                key={`${heading.id}-${index}`}
                href={`#${heading.id}`}
                className={cn(
                  "block border-l py-1 text-xs leading-5 transition",
                  heading.level === 3 ? "pl-5" : "pl-3",
                  isActive
                    ? "border-neon text-neon"
                    : "border-border text-muted-foreground hover:border-neon/60 hover:text-foreground",
                )}
              >
                {heading.title}
              </a>
            )
          })}
        </nav>
        <a
          href="https://github.com/desplega-ai/agent-fs/tree/main/docs"
          target="_blank"
          rel="noreferrer"
          className="mt-8 inline-flex items-center gap-2 font-mono text-xs text-muted-foreground transition hover:text-neon"
        >
          Source docs
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
      </aside>

      <MobileDrawer open={mobileOpen} onClose={() => setMobileOpen(false)} activeSlug={activeDoc.slug} />
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
    </main>
  )
}

export function DocsIndexPage() {
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <main className="mx-auto max-w-5xl px-6 pb-24 pt-28">
      <div className="max-w-2xl">
        <p className="font-mono text-sm uppercase tracking-widest text-neon/70">Documentation</p>
        <h1 className="mt-4 text-[clamp(2.5rem,7vw,4.75rem)] font-bold leading-none tracking-tight">
          Build against the agent filesystem.
        </h1>
        <p className="mt-6 text-lg leading-8 text-muted-foreground">
          The landing docs are rendered from the repository docs and ship the same markdown artifacts at build time.
        </p>
      </div>

      <div className="mt-10">
        <SearchButton onClick={() => setSearchOpen(true)} className="py-3 text-sm" />
      </div>

      <div className="mt-14 space-y-12">
        {DOC_SECTIONS.map((section) => {
          const docs = DOCS.filter((doc) => doc.section === section)
          if (docs.length === 0) return null
          return (
            <section key={section}>
              <div className="flex items-baseline justify-between border-b border-border pb-3">
                <h2 className="font-mono text-xs uppercase tracking-widest text-neon/70">{section}</h2>
                <span className="font-mono text-[11px] text-muted-foreground/70">{docs.length} doc{docs.length === 1 ? "" : "s"}</span>
              </div>
              <div className="mt-4 grid gap-px overflow-hidden rounded-lg border border-border md:grid-cols-2">
                {docs.map((doc) => (
                  <a
                    key={doc.slug}
                    href={`/docs/${doc.slug}`}
                    className="group relative block bg-card p-6 transition hover:bg-card/40"
                  >
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-neon to-transparent opacity-0 transition group-hover:opacity-100"
                    />
                    <h3 className="text-xl font-semibold tracking-tight text-foreground transition group-hover:text-neon">
                      {doc.title}
                    </h3>
                    <p className="mt-3 text-sm leading-7 text-muted-foreground">{doc.summary}</p>
                    <span className="mt-4 inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground transition group-hover:text-neon">
                      Read
                      <ChevronRight className="size-3 transition group-hover:translate-x-0.5" aria-hidden="true" />
                    </span>
                  </a>
                ))}
              </div>
            </section>
          )
        })}
      </div>

      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
    </main>
  )
}
