import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useBrowser } from "@/contexts/browser"
import { useFileMutations } from "@/hooks/use-file-mutations"
import { parentOf } from "@/lib/paths"
import { toast } from "@/stores/toast"

interface DeleteDialogProps {
  /** Drive-relative path of the file to delete. */
  path: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Confirm-and-delete for a single file via the `rm` op. `rm` writes a delete
 * marker version, so the history stays available for `revert`.
 *
 * Callers mount it only while open, so every opening starts with fresh state.
 */
export function DeleteDialog({ path, open, onOpenChange }: DeleteDialogProps) {
  const { selectedFile, navigateToFolder } = useBrowser()
  const { deleteFile } = useFileMutations()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const handleDelete = async () => {
    setBusy(true)
    setError(null)
    try {
      await deleteFile(path)
      toast.success("Deleted", { description: path })
      onOpenChange(false)
      if (selectedFile === path) navigateToFolder(parentOf(path))
    } catch (err) {
      setError((err as Error).message || "Delete failed.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete file</DialogTitle>
          <DialogDescription>
            Delete <code className="font-mono text-xs break-all">{path}</code>? It disappears from
            listings. Its version history is kept, so{" "}
            <code className="font-mono text-xs">agent-fs revert</code> can restore it.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-xs text-destructive">{error}</p>}
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
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={handleDelete}
            disabled={busy}
          >
            {busy ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
