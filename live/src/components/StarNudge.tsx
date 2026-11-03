import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import type { LsResult } from "@/api/types"
import { hasEnoughFiles, starNudgeKey } from "@/lib/star-nudge"
import { showStarNudgeToast } from "@/stores/star-nudge"
import { toast } from "@/stores/toast"

export function StarNudge() {
  const { user, orgId, driveId, credential, isLoading } = useAuth()
  if (isLoading || !user || !orgId || !driveId) return null
  const key = starNudgeKey(credential.endpoint, user.userId, orgId, driveId)
  return <DriveStarNudge key={key} storageKey={key} orgId={orgId} driveId={driveId} />
}

function DriveStarNudge({ storageKey, orgId, driveId }: { storageKey: string; orgId: string; driveId: string }) {
  const { client } = useAuth()
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
  const { data } = useQuery({
    queryKey: ["star-nudge-files", storageKey],
    queryFn: ({ signal }) => hasEnoughFiles((path) => client.callOp<LsResult>(orgId, "ls", { path }, driveId, { signal })),
    enabled: !dismissed,
    refetchInterval: (query) => query.state.data ? false : 60_000,
  })
  useEffect(() => {
    if (!data || dismissed) return
    const id = showStarNudgeToast(() => {
      try { localStorage.setItem(storageKey, "1") } catch { /* Keep the dismissal in memory. */ }
      setDismissed(true)
    })
    return () => toast.dismiss(id)
  }, [data, dismissed, storageKey])
  return null
}
