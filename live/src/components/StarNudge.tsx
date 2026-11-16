import { useEffect, useState } from "react"
import { useAuth } from "@/contexts/auth"
import { hasEnoughFiles, starNudgeKey } from "@/lib/star-nudge"
import { showStarNudgeToast } from "@/stores/star-nudge"
import { toast } from "@/stores/toast"

export function StarNudge() {
  const { user, orgId, driveId, credential, isLoading } = useAuth()
  if (isLoading || !user || !orgId || !driveId) return null
  const key = starNudgeKey(credential.endpoint, user.userId, orgId, driveId)
  return <DriveStarNudge key={key} storageKey={key} />
}

function DriveStarNudge({ storageKey }: { storageKey: string }) {
  const { drives, driveId } = useAuth()
  const eligible = hasEnoughFiles(drives.find((drive) => drive.id === driveId))
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(storageKey) === "1" } catch { return false }
  })
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey) setDismissed(event.newValue === "1")
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [storageKey])
  useEffect(() => {
    if (!eligible || dismissed) return
    const id = showStarNudgeToast(() => {
      try { localStorage.setItem(storageKey, "1") } catch { /* Keep the dismissal in memory. */ }
      setDismissed(true)
    })
    return () => toast.dismiss(id)
  }, [eligible, dismissed, storageKey])
  return null
}
