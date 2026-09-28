import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export function ProfileDialog({ onClose }: { onClose: () => void }) {
  const { client, user } = useAuth()
  const queryClient = useQueryClient()
  const [name, setName] = useState(user?.displayName ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent>
      <DialogTitle>Edit profile</DialogTitle>
      <DialogDescription>Your display name is visible to people who can read your comments.</DialogDescription>
      <form className="grid gap-4" onSubmit={async (event) => {
        event.preventDefault()
        setSaving(true)
        setError("")
        try {
          await client.updateProfile(name.trim() || null)
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["me"] }),
            queryClient.invalidateQueries({ queryKey: ["comments"] }),
          ])
          onClose()
        } catch (err) {
          setError((err as Error).message || "Could not save profile")
        } finally { setSaving(false) }
      }}>
        <label className="grid gap-2 text-sm">
          Display name
          <Input autoFocus value={name} maxLength={100} disabled={saving} onChange={(event) => setName(event.target.value)} />
        </label>
        <p className="text-xs text-muted-foreground">Leave blank to clear your name.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save profile"}</Button>
      </form>
    </DialogContent>
  </Dialog>
}
