import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Copy, ExternalLink, Share2 } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { copyShareLink, DEFAULT_SHARE_EXPIRY_SECONDS, SHARE_EXPIRY_CHOICES } from "@/lib/share-link"
import { isHtmlPath } from "@/lib/html-view"
import { healthQueryOptions } from "@/lib/upload-limit"
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

/**
 * Mint a public link for a file or folder, with a chosen expiry. The link is
 * copied inside the click (Safari needs that), then shown so it can be copied
 * again or opened. Changing the expiry asks for a new link.
 *
 * Callers mount it only while open, so every opening starts with fresh state.
 */
export function ShareDialog({ path, isDir, open, onOpenChange }: ShareDialogProps) {
  const { client, orgId, driveId } = useAuth()
  const queryClient = useQueryClient()
  const { data: health } = useQuery(healthQueryOptions(client))
  const [expiresIn, setExpiresIn] = useState<number>(DEFAULT_SHARE_EXPIRY_SECONDS)
  const [link, setLink] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copiedAgain, setCopiedAgain] = useState(false)
  const name = path.split("/").filter(Boolean).pop() ?? "drive"

  const handleCreate = async () => {
    if (!orgId || !driveId) return
    setBusy(true)
    // The server's public address, read fresh: one cached from before the
    // server changed it would hand out the old or a private address. The
    // cached value only stands in when the server cannot be asked.
    const getPublicUrl = () => queryClient
      .fetchQuery({ ...healthQueryOptions(client), staleTime: 0 })
      .then((fresh) => fresh.publicUrl, () => health?.publicUrl)
    const next = await copyShareLink(client, orgId, driveId, path, { expiresIn, getPublicUrl })
    setBusy(false)
    if (next) setLink(next)
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
            value={[String(expiresIn)]}
            onValueChange={(v) => {
              const next = Number(v[0])
              if (!next || next === expiresIn) return
              setExpiresIn(next)
              setLink(null)
            }}
          >
            {SHARE_EXPIRY_CHOICES.map((choice) => (
              <ToggleGroupItem key={choice.seconds} value={String(choice.seconds)} className="h-7 w-auto px-2.5 text-xs">
                {choice.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
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
