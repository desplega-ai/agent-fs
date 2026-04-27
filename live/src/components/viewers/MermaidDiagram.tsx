import { useEffect, useRef, useState, useId, useCallback } from "react"
import { Maximize2, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { downloadBlob } from "@/lib/download"
import { AssetLightbox } from "./AssetLightbox"

/**
 * Renders a mermaid-emitted SVG string. Mermaid's output already contains a
 * scoped <style> block, so we just inject it. Wrapped in its own component so
 * both the inline and lightbox views go through the same render path.
 */
function MermaidSvg({ svg, className }: { svg: string; className?: string }) {
  return (
    <div
      className={cn(
        "[&>svg]:block [&>svg]:h-auto [&>svg]:max-w-full [&>svg]:max-h-full",
        className,
      )}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({ startOnLoad: false, securityLevel: "strict" })
      return m.default
    })
  }
  return mermaidPromise
}

function currentTheme(): "default" | "dark" {
  if (typeof document === "undefined") return "default"
  return document.documentElement.classList.contains("dark") ? "dark" : "default"
}

interface MermaidDiagramProps {
  code: string
}

export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const reactId = useId()
  const diagramId = `mermaid-${reactId.replace(/:/g, "")}`
  const [error, setError] = useState<string | null>(null)
  const [theme, setTheme] = useState<"default" | "dark">(currentTheme)
  const [svg, setSvg] = useState<string | null>(null)
  const [lightboxSvg, setLightboxSvg] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const update = () => setTheme(currentTheme())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    setError(null)
    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({ startOnLoad: false, theme, securityLevel: "strict" })
        const result = await mermaid.render(diagramId, code)
        if (cancelled || !containerRef.current) return
        containerRef.current.innerHTML = result.svg
        result.bindFunctions?.(containerRef.current)
        setSvg(result.svg)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [code, theme, diagramId])

  // Render a second copy with its own id for the lightbox. Mermaid's emitted
  // SVG includes a <style> block with selectors keyed off the diagram id; if
  // we reused the inline SVG verbatim the two copies would share an id and
  // CSS would collapse onto the first one in the DOM, leaving the lightbox
  // copy unstyled (or, depending on size, invisible).
  useEffect(() => {
    if (!open) return
    let cancelled = false
    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({ startOnLoad: false, theme, securityLevel: "strict" })
        const result = await mermaid.render(`${diagramId}-lightbox`, code)
        if (cancelled) return
        setLightboxSvg(result.svg)
      })
      .catch(() => {
        // If the lightbox render fails fall back to the inline SVG string.
        if (!cancelled) setLightboxSvg(svg)
      })
    return () => {
      cancelled = true
    }
  }, [open, code, theme, diagramId, svg])

  const handleDownload = useCallback(() => {
    if (!svg) return
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" })
    downloadBlob(blob, "diagram.svg")
  }, [svg])

  if (error) {
    return (
      <div className="my-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
        <div className="font-medium text-destructive">Mermaid render error</div>
        <pre className="mt-1 whitespace-pre-wrap text-muted-foreground">{error}</pre>
        <pre className="mt-2 whitespace-pre-wrap text-muted-foreground">{code}</pre>
      </div>
    )
  }

  return (
    <>
      <div className="group relative my-4">
        <div
          ref={containerRef}
          className="flex justify-center overflow-auto rounded-md border border-border bg-card p-4"
        />
        <div className="pointer-events-none absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
          <Button
            variant="secondary"
            size="icon-xs"
            onClick={() => setOpen(true)}
            aria-label="Expand diagram"
            className="shadow-sm"
            disabled={!svg}
          >
            <Maximize2 />
          </Button>
          <Button
            variant="secondary"
            size="icon-xs"
            onClick={handleDownload}
            aria-label="Download SVG"
            className="shadow-sm"
            disabled={!svg}
          >
            <Download />
          </Button>
        </div>
      </div>
      <AssetLightbox
        open={open}
        onOpenChange={setOpen}
        filename="diagram.svg"
        onDownload={handleDownload}
      >
        {lightboxSvg ? (
          <MermaidSvg
            svg={lightboxSvg}
            className="w-[min(90vw,1400px)] max-h-[85vh] overflow-auto rounded-lg border border-border bg-card p-8 shadow-2xl"
          />
        ) : (
          <div className="text-sm text-white/70">Rendering…</div>
        )}
      </AssetLightbox>
    </>
  )
}
