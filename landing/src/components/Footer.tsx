import { cn } from "@/lib/utils"

const footerDocsLinks = [
  { href: "/docs", label: "Docs" },
  { href: "/docs/mcp-setup", label: "MCP setup" },
  { href: "/docs/api-reference", label: "API" },
  { href: "/docs/fuse-mount", label: "FUSE" },
]

export function Footer({ wide = false }: { wide?: boolean }) {
  return (
    <footer
      className={cn(
        "mx-auto px-6 pb-12 pt-20",
        wide ? "max-w-screen-2xl lg:px-10" : "max-w-5xl",
      )}
    >
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-border pt-8">
        <div className="text-center sm:text-left">
          <a href="https://desplega.sh" className="text-sm font-medium text-foreground/70 hover:text-neon transition-colors">Desplega Labs</a>
          <p className="text-xs text-muted-foreground mt-0.5 italic">Made by builders, for builders.</p>
        </div>
        <nav className="flex flex-wrap items-center justify-center gap-4 font-mono text-xs text-muted-foreground" aria-label="Footer">
          {footerDocsLinks.map((link) => (
            <a key={link.href} href={link.href} className="transition hover:text-neon">
              {link.label}
            </a>
          ))}
          <a href="/llms.txt" className="transition hover:text-neon">llms.txt</a>
          <a href="https://github.com/desplega-ai/agent-fs" className="transition hover:text-neon">GitHub</a>
        </nav>
        <p className="text-xs text-muted-foreground/50">
          &copy; 2026 Desplega Labs. All rights reserved.
        </p>
      </div>
    </footer>
  )
}
