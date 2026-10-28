import { useState } from "react"
import { Check, Copy, Download } from "lucide-react"
import type { useFileActions } from "@/hooks/use-file-actions"
import { copyBlockMessage } from "@/lib/copy-contents"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

/**
 * The header copy button. A click copies the file's contents; hovering or
 * focusing it opens a popover with "Copy path" (also `Y`). Files that are not
 * text, or are too large, keep the button but offer "Download instead".
 */
export function CopyButton({ path, actions }: { path: string; actions: ReturnType<typeof useFileActions> }) {
  const { copyContents, copyPath, download, contents, copiedContents, copiedPath, canShare } = actions
  const [open, setOpen] = useState(false)
  const blocked = contents.ok ? null : copyBlockMessage(contents.reason)

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        // A click copies; it neither opens nor pins the popover.
        if (details.reason !== "trigger-press") setOpen(next)
      }}
    >
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={100}
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={copyContents}
            onFocus={(e) => {
              if (e.currentTarget.matches(":focus-visible")) setOpen(true)
            }}
            className="text-muted-foreground"
            aria-label={copiedContents ? "Contents copied" : "Copy contents"}
            aria-disabled={!contents.ok || undefined}
          >
            {copiedContents || copiedPath ? <Check /> : <Copy />}
          </Button>
        }
      />
      <PopoverContent side="bottom" align="end" initialFocus={false} finalFocus={false} className="w-auto min-w-64 max-w-sm gap-1 p-1 text-xs">
        <div className="flex items-center justify-between gap-2 px-2 py-1 text-muted-foreground">
          <span className="whitespace-nowrap">{copiedContents ? "Contents copied" : blocked ?? "Click to copy contents"}</span>
          {blocked && (
            <Button variant="ghost" size="xs" onClick={download} disabled={!canShare}>
              <Download />
              Download instead
            </Button>
          )}
        </div>
        <button
          type="button"
          onClick={() => void copyPath()}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
        >
          {copiedPath ? <Check className="size-3.5 shrink-0" /> : <Copy className="size-3.5 shrink-0" />}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-medium">{copiedPath ? "Path copied" : "Copy path"}</span>
            <span className="truncate font-mono text-muted-foreground" title={path}>{path}</span>
          </span>
          <Kbd>Y</Kbd>
        </button>
      </PopoverContent>
    </Popover>
  )
}
