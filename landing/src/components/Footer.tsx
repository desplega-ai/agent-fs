import { cn } from "@/lib/utils"
import { DOC_METADATA } from "@/content/doc-metadata"

const footerDocs = DOC_METADATA.slice(0, 6)

export function Footer({ wide = false }: { wide?: boolean }) {
  return (
    <footer
      className={cn(
        "mx-auto px-6 pb-12 pt-20",
        wide ? "max-w-screen-2xl lg:px-10" : "max-w-5xl",
      )}
    >
      <div className="grid gap-8 border-t border-border pt-8 md:grid-cols-[1fr_1fr_auto]">
        <div className="text-center sm:text-left">
          <a href="https://desplega.sh" className="text-sm font-medium text-foreground/70 hover:text-neon transition-colors">Desplega Labs</a>
          <p className="text-xs text-muted-foreground mt-0.5 italic">Made by builders, for builders.</p>
        </div>
        <nav className="grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-xs text-muted-foreground sm:grid-cols-3" aria-label="Footer docs">
          <a href="/docs" className="transition hover:text-neon">Docs index</a>
          {footerDocs.map((doc) => (
            <a key={doc.slug} href={`/docs/${doc.slug}`} className="transition hover:text-neon">
              {doc.title}
            </a>
          ))}
        </nav>
        <nav className="flex items-start justify-center gap-4 font-mono text-xs text-muted-foreground md:justify-end" aria-label="Footer">
          <a href="/llms.txt" className="transition hover:text-neon">llms.txt</a>
          <a href="https://github.com/desplega-ai/agent-fs" className="transition hover:text-neon">GitHub</a>
        </nav>
        <p className="text-center text-xs text-muted-foreground/50 md:col-span-3 md:text-left">
          &copy; 2026 Desplega Labs. All rights reserved.
        </p>
      </div>
    </footer>
  )
}
