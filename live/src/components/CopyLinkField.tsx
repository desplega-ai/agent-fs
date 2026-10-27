import { useState } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toast } from "@/stores/toast"

/** A read-only link with a copy button that shows a check for a moment. */
export function CopyLinkField({ link, label }: { link: string; label: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error("Couldn't copy link")
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        readOnly
        value={link}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        className="font-mono text-xs"
      />
      <Button variant="outline" size="icon-sm" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  )
}
