import { useCallback, useRef, useState, type HTMLAttributes } from "react"
import { Copy, Check } from "lucide-react"
import { Button } from "@/components/ui/button"

export function CodeBlock(props: HTMLAttributes<HTMLPreElement>) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    const text = ref.current?.textContent ?? ""
    if (!text) return
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      },
      () => {
        // Clipboard write blocked (insecure context, denied perms) — silently
        // ignore; the user can still select and copy manually.
      },
    )
  }, [])

  return (
    <div className="group relative">
      <pre ref={ref} {...props} />
      <Button
        type="button"
        variant="secondary"
        size="icon-xs"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy code"}
        className="absolute right-2 top-2 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  )
}
