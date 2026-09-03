import { useState, type FormEvent } from "react"
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
import { useBrowser } from "@/contexts/browser"
import { useFileMutations } from "@/hooks/use-file-mutations"
import { cleanPath, normalizeRelativePath } from "@/lib/paths"
import { toast } from "@/stores/toast"

interface RenameDialogProps {
  /** Current drive-relative path of the file. */
  path: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Rename (or move) a single file with the `mv` op. The input holds the full
 * drive-relative path so changing a folder segment moves the file. `mv`
 * overwrites silently, so the dialog refuses a destination that exists.
 *
 * Callers mount it only while open, so every opening starts with fresh state.
 */
export function RenameDialog({ path, open, onOpenChange }: RenameDialogProps) {
  const { selectedFile, selectFile } = useBrowser()
  const { renameFile, exists } = useFileMutations()
  const [value, setValue] = useState(path)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const normalized = normalizeRelativePath(value)
    if ("error" in normalized) {
      setError(normalized.error)
      return
    }
    const to = normalized.path
    if (to === cleanPath(path)) {
      onOpenChange(false)
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (await exists(to)) {
        setError(`A file already exists at ${to}.`)
        return
      }
      await renameFile(path, to)
      toast.success("Renamed", { description: to })
      onOpenChange(false)
      if (selectedFile === path) selectFile(to)
    } catch (err) {
      setError((err as Error).message || "Rename failed.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Rename file</DialogTitle>
            <DialogDescription>
              Edit the full path to rename or move the file. Version history follows it to the
              new path.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-label="New path"
              aria-invalid={error ? true : undefined}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-xs"
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy || value.trim().length === 0}>
              {busy ? "Renaming..." : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
