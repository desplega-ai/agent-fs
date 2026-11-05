import { useState } from "react"
import { Check, Copy, ExternalLink, Share2 } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { useHealth } from "@/hooks/use-health"
import { useInvalidateShareLists } from "@/hooks/use-share-list"
import { ShareLinksList } from "@/components/ShareLinksList"
import { copyShareLink, DEFAULT_SHARE_EXPIRY_SECONDS, effectiveShareExpiry, SHARE_EXPIRY_CHOICES, supportsNoExpiry } from "@/lib/share-link"
import { isHtmlPath } from "@/lib/html-view"
import { toast } from "@/stores/toast"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

interface ShareDialogProps {
  /** Drive-relative path of the file or folder. */
  path: string
  /** A folder is shared as an HTML site (`/site/<token>/`). */
  isDir: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}

function describeShare(path: string, isDir: boolean): string {
  if (isDir) {
    const atRoot = path.split("/").filter(Boolean).length === 0
    return atRoot
      ? "Publishes the whole drive as a site. Every file in it is public while the link is valid."
      : "Publishes this folder as a site. Every file in it is public while the link is valid."
  }
  if (isHtmlPath(path)) {
    return "Anyone with the link can view this page. Only this file is shared, so files next to it (images, scripts) do not load."
  }
  return "Anyone with the link can view and download this file."
}

/** The toggle group wants string values; `null` (never expires) has none of its own. */
const NEVER = "never"
const choiceValue = (seconds: number | null) => (seconds === null ? NEVER : String(seconds))

/**
 * Mint a public link for a file or folder, with a chosen expiry. The link is
 * copied inside the click (Safari needs that), then shown so it can be copied
 * again or opened. Changing the expiry asks for a new link.
 *
 * Callers mount it only while open, so every opening starts with fresh state.
 */
export function ShareDialog({ path, isDir, open, onOpenChange }: ShareDialogProps) {
  const { client, orgId, driveId } = useAuth()
  const { data: health } = useHealth()
  // Older servers reject `expiresIn: null`, so they never see the choice, and a
  // Never chosen before the health changed is not sent to them either.
  const choices = supportsNoExpiry(health) ? SHARE_EXPIRY_CHOICES : SHARE_EXPIRY_CHOICES.filter((c) => c.seconds !== null)
  const [selected, setSelected] = useState<number | null>(DEFAULT_SHARE_EXPIRY_SECONDS)
  const expiresIn = effectiveShareExpiry(selected, health)
  const [link, setLink] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copiedAgain, setCopiedAgain] = useState(false)
  const invalidateShareLists = useInvalidateShareLists()
  const name = path.split("/").filter(Boolean).pop() ?? "drive"

  const handleCreate = async () => {
    if (!orgId || !driveId) return
    setBusy(true)
    const next = await copyShareLink(client, orgId, driveId, path, { expiresIn })
    setBusy(false)
    if (next) {
      setLink(next)
      void invalidateShareLists()
    }
  }

  const handleCopyAgain = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopiedAgain(true)
      setTimeout(() => setCopiedAgain(false), 1500)
    } catch {
      toast.error("Couldn't copy link")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isDir ? `Share ${name} as a site` : `Share ${name}`}</DialogTitle>
          <DialogDescription>{describeShare(path, isDir)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Link expires after</p>
          <ToggleGroup
            value={[choiceValue(expiresIn)]}
            onValueChange={(v) => {
              const next = v[0] === undefined ? undefined : v[0] === NEVER ? null : Number(v[0])
              if (next === undefined || next === expiresIn) return
              setSelected(next)
              setLink(null)
            }}
          >
            {choices.map((choice) => (
              <ToggleGroupItem key={choice.label} value={choiceValue(choice.seconds)} className="h-7 w-auto px-2.5 text-xs">
                {choice.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {expiresIn === null && (
            <p className="text-xs text-muted-foreground">
              This link never expires. Revoke it to end it.
            </p>
          )}
        </div>
        {link && (
          <div className="flex items-center gap-1.5">
            <Input
              readOnly
              value={link}
              aria-label="Share link"
              onFocus={(e) => e.currentTarget.select()}
              className="font-mono text-xs"
            />
            <Button variant="outline" size="icon-sm" onClick={handleCopyAgain} aria-label="Copy link again">
              {copiedAgain ? <Check /> : <Copy />}
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Open link"
              nativeButton={false}
              render={<a href={link} target="_blank" rel="noopener noreferrer" />}
            >
              <ExternalLink />
            </Button>
          </div>
        )}
        <ShareLinksList path={path} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {link ? "Done" : "Cancel"}
          </Button>
          {!link && (
            <Button onClick={handleCreate} disabled={busy || !orgId || !driveId}>
              {busy ? "Creating…" : "Copy link"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Labeled header button that opens the share dialog for the open file. */
export function ShareButton({ path }: { path: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="ghost" size="xs" onClick={() => setOpen(true)} className="text-muted-foreground">
        <Share2 />
        Share
      </Button>
      {open && <ShareDialog path={path} isDir={false} open onOpenChange={setOpen} />}
    </>
  )
}
