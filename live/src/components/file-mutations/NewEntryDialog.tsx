import { useState, type FormEvent } from "react"
import { useNavigate } from "react-router"
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
import { useAuth } from "@/contexts/auth"
import { useBrowser } from "@/contexts/browser"
import { useFileMutations, KEEP_FILE } from "@/hooks/use-file-mutations"
import { isConflictError } from "@/api/client"
import { ancestorListings, joinPath, normalizeRelativePath } from "@/lib/paths"
import { treeExpansionStore } from "@/stores/tree-expansion"
import { toast } from "@/stores/toast"

export type NewEntryKind = "file" | "folder"

interface NewEntryDialogProps {
  kind: NewEntryKind
  /** Folder the new entry is created in ("" for the drive root). */
  basePath: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * "New file" and "New folder" dialog. Accepts nested relative paths such as
 * `sub/dir/name.md`. Files are created with `expectedVersion: 0` and opened in
 * edit mode; folders are materialized through a `.keep` placeholder.
 *
 * Callers mount it only while open, so every opening starts with fresh state.
 */
export function NewEntryDialog({ kind, basePath, open, onOpenChange }: NewEntryDialogProps) {
  const { orgId, driveId } = useAuth()
  const { setSelectedFile, navigateToFolder } = useBrowser()
  const navigate = useNavigate()
  const { createFile, createFolder } = useFileMutations()
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const isFile = kind === "file"
  const location = basePath || "the drive root"

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const normalized = normalizeRelativePath(value)
    if ("error" in normalized) {
      setError(normalized.error)
      return
    }
    if (!orgId || !driveId) {
      setError("No drive selected.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (isFile) {
        const path = await createFile(basePath, normalized.path)
        toast.success("File created", { description: path })
        onOpenChange(false)
        setSelectedFile(path)
        navigate(`/file/~/${orgId}/${driveId}/${path}?edit=1`)
      } else {
        const folder = await createFolder(basePath, normalized.path)
        // Reveal the new folder in the tree, then open it.
        treeExpansionStore.expandMany(
          ancestorListings(joinPath(folder, KEEP_FILE)).filter((p) => p !== ""),
        )
        toast.success("Folder created", { description: folder })
        onOpenChange(false)
        navigateToFolder(folder)
      }
    } catch (err) {
      const target = joinPath(basePath, normalized.path)
      setError(
        isConflictError(err)
          ? `Something already exists at ${target}.`
          : (err as Error).message || "Request failed.",
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{isFile ? "New file" : "New folder"}</DialogTitle>
            <DialogDescription>
              {isFile ? (
                <>
                  Created in <code className="font-mono text-xs">{location}</code>. Nested paths
                  such as <code className="font-mono text-xs">notes/todo.md</code> create the
                  folders they need.
                </>
              ) : (
                <>
                  Created in <code className="font-mono text-xs">{location}</code>. An empty{" "}
                  <code className="font-mono text-xs">.keep</code> file marks the folder so it
                  shows in listings.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={isFile ? "notes/todo.md" : "reports/2026"}
              aria-label={isFile ? "File path" : "Folder path"}
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
              {busy ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
