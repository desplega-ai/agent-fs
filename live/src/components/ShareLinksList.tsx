import { useEffect, useState } from "react"
import { useAuth } from "@/contexts/auth"
import { useRevokeShare, useShareList } from "@/hooks/use-share-list"
import type { ShareListItem } from "@/api/types"
import { coveringLabel, creatorLabel, expiryLabel, formatWhen, statusLabel, viewsLabel } from "@/lib/share-list"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"

/**
 * The links on one file or folder, plus folder links that also publish it,
 * each with its own revoke. Renders nothing on servers without `share-list`,
 * and nothing while there are no active links and inactive ones are hidden.
 */
export function ShareLinksList({ path }: { path: string }) {
  const [includeInactive, setIncludeInactive] = useState(false)
  const list = useShareList({ scope: "drive", path: path || "/", includeInactive })

  if (!list.supported || list.isPending) return null
  if (list.error) {
    return <p role="alert" className="text-xs text-destructive">Couldn't load existing links.</p>
  }
  if (list.shares.length === 0 && !includeInactive) return null

  return (
    <section aria-label="Existing links" className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">
          Existing links ({list.total})
        </p>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch size="sm" checked={includeInactive} onCheckedChange={setIncludeInactive} />
          Show inactive
        </label>
      </div>
      {list.visibility === "own" && (
        <p className="text-[11px] text-muted-foreground">Showing only your links.</p>
      )}
      {list.shares.length === 0 ? (
        <p className="text-xs text-muted-foreground">No links on this path.</p>
      ) : (
        <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {list.shares.map((item) => (
            <ShareLinkRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </section>
  )
}

function ShareLinkRow({ item }: { item: ShareListItem }) {
  const { user } = useAuth()
  const covering = coveringLabel(item)
  const mine = user?.userId === item.createdBy.userId
  const expiry = expiryLabel(item.expiresAt)
  return (
    <li className="flex items-start gap-2 px-2 py-1.5 text-xs">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-1">
          <Badge variant="outline">{item.kind === "site" ? "Site" : "File"}</Badge>
          <Badge variant={item.status === "active" ? "secondary" : "destructive"}>{statusLabel(item.status)}</Badge>
          <span
            className="text-muted-foreground"
            title={item.expiresAt ? formatWhen(item.expiresAt) : undefined}
          >
            {item.expiresAt === null ? "Never expires" : item.status === "expired" ? `Expired ${expiry}` : `Expires ${expiry}`}
          </span>
        </div>
        <p className="truncate text-muted-foreground">
          {viewsLabel(item.views, item.maxViews)} · created {formatWhen(item.createdAt)}
          {!mine && ` by ${creatorLabel(item)}`}
        </p>
        {covering && <p className="truncate text-muted-foreground">{covering}</p>}
      </div>
      {item.canRevoke && item.status !== "revoked" && <RevokeButton item={item} />}
    </li>
  )
}

/** Two clicks: "Revoke", then "Confirm revoke". The second state times out after a few seconds. */
export function RevokeButton({ item, label }: { item: ShareListItem; label?: string }) {
  const revoke = useRevokeShare()
  const [confirming, setConfirming] = useState(false)
  const busy = revoke.isPending

  useEffect(() => {
    if (!confirming) return
    const t = setTimeout(() => setConfirming(false), 4000)
    return () => clearTimeout(t)
  }, [confirming])

  return (
    <Button
      variant={confirming ? "destructive" : "outline"}
      size="xs"
      disabled={busy}
      aria-label={confirming ? `Confirm revoke ${label ?? "link"}` : `Revoke ${label ?? "link"}`}
      onClick={() => {
        if (!confirming) return setConfirming(true)
        setConfirming(false)
        revoke.mutate(item)
      }}
    >
      {busy ? "Revoking…" : confirming ? "Confirm revoke" : "Revoke"}
    </Button>
  )
}
