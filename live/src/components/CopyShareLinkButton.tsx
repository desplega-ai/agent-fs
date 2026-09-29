import { Check, Share2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/** Header button that copies a public share link for the open file. */
export function CopyShareLinkButton({ onClick, copied }: { onClick: () => void; copied: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onClick}
            className="text-muted-foreground"
            aria-label="Copy share link"
          >
            {copied ? <Check /> : <Share2 />}
          </Button>
        }
      />
      <TooltipContent>Copy share link</TooltipContent>
    </Tooltip>
  )
}
