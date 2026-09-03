import { Save, X, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"

interface EditToolbarProps {
  isDirty: boolean
  isSaving: boolean
  saveError?: Error | null
  onClearError?: () => void
  onSave: () => void
  onCancel: () => void
}

/** Save / Cancel bar shared by the Monaco editor and the rich markdown editor. */
export function EditToolbar({ isDirty, isSaving, saveError, onClearError, onSave, onCancel }: EditToolbarProps) {
  return (
    <div className="flex items-center justify-between border-b border-border px-3 py-1.5 shrink-0 bg-muted/30">
      <div className="flex items-center gap-2">
        {isDirty && (
          <span className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <span className="size-1.5 rounded-full bg-amber-500" />
            Unsaved
          </span>
        )}
        {saveError && (
          <span className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertCircle className="size-3" />
            {saveError.message}
            <button onClick={onClearError} className="hover:text-foreground">
              <X className="size-3" />
            </button>
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="xs" onClick={onCancel} disabled={isSaving} className="gap-1">
          <X className="size-3" />
          Cancel
        </Button>
        <Button
          variant="default"
          size="xs"
          onClick={onSave}
          disabled={isSaving || !isDirty}
          className="gap-1"
        >
          {isSaving ? <Spinner className="size-3" /> : <Save className="size-3" />}
          Save
          <Kbd className="ml-1">⌘S</Kbd>
        </Button>
      </div>
    </div>
  )
}
