import { useCallback, useRef, useState, type HTMLAttributes } from "react"
import { Copy, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { toast } from "@/stores/toast"

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
        toast.success("Code copied")
      },
      () => {
        toast.error("Couldn't copy code")
      },
    )
  }, [])

  return (
    <div className="group relative">
      <pre ref={ref} {...props} />
      <Tooltip>
        <TooltipTrigger
          render={
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
          }
        />
        <TooltipContent>Copy code</TooltipContent>
      </Tooltip>
    </div>
  )
}
