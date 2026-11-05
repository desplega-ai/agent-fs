import { useMemo, useState } from "react"
import { Link } from "react-router"
import { FileText, Folder, Link2 } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { useDocumentTitle } from "@/hooks/use-document-title"
import { useShareList } from "@/hooks/use-share-list"
import type { ShareListItem } from "@/api/types"
import { driveOptions, expiryLabel, formatWhen, statusLabel, viewsLabel } from "@/lib/share-list"
import { RevokeButton } from "@/components/ShareLinksList"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

const ALL_DRIVES = "all"

/**
 * Every link the signed-in user created in this org's drives, with a revoke
 * on each. The drive in the URL only satisfies the server's membership check;
 * the list spans every drive of the org the user is on.
 */
export function SharedLinksPage() {
  useDocumentTitle("Shared links")
  const { orgId } = useAuth()
  const [includeInactive, setIncludeInactive] = useState(false)
  const [drive, setDrive] = useState(ALL_DRIVES)
  const list = useShareList({ scope: "mine", includeInactive })
  const drives = useMemo(() => driveOptions(list.shares), [list.shares])
  const rows = drive === ALL_DRIVES ? list.shares : list.shares.filter((s) => s.drive.id === drive)

  let body: React.ReactNode
  if (!list.supported) {
    body = <p className="text-sm text-muted-foreground">This server cannot list shared links yet.</p>
  } else if (list.isPending) {
    body = <div className="flex justify-center py-10"><Spinner /></div>
  } else if (list.error) {
    body = <p role="alert" className="text-sm text-destructive">{list.error.message || "Couldn't load shared links"}</p>
  } else if (rows.length === 0) {
    body = (
      <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        {includeInactive
          ? "You have no shared links in this organization."
          : "You have no active shared links in this organization."}
      </p>
    )
  } else {
    body = (
      <>
        <ul aria-label="Shared links" className="divide-y divide-border rounded-lg border border-border">
          {rows.map((item) => (
            <SharedLinkRow key={item.id} item={item} orgId={orgId!} />
          ))}
        </ul>
        {list.hasMore && (
          <div className="flex justify-center">
            <Button variant="outline" size="sm" disabled={list.isLoadingMore} onClick={() => list.loadMore()}>
              {list.isLoadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6 sm:px-6">
        <header className="space-y-1">
          <div className="flex items-center gap-2">
            <Link2 className="size-4 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Shared links</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Links you created in this organization's drives. A link is shown only once, when you create it, so this list cannot copy it again.
          </p>
        </header>

        {list.supported && (
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup
              value={[includeInactive ? "all" : "active"]}
              onValueChange={(v) => {
                if (v[0] !== undefined) setIncludeInactive(v[0] === "all")
              }}
            >
              <ToggleGroupItem value="active" className="h-7 w-auto px-2.5 text-xs">Active</ToggleGroupItem>
              <ToggleGroupItem value="all" className="h-7 w-auto px-2.5 text-xs">All</ToggleGroupItem>
            </ToggleGroup>
            {drives.length > 1 && (
              <select
                aria-label="Drive"
                value={drive}
                onChange={(e) => setDrive(e.target.value)}
                className="h-7 rounded-md border border-border bg-background px-2 text-xs"
              >
                <option value={ALL_DRIVES}>All drives</option>
                {drives.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            )}
            {!list.isPending && (
              <span className="ml-auto text-xs text-muted-foreground">
                {list.total} {list.total === 1 ? "link" : "links"}
              </span>
            )}
          </div>
        )}

        {body}
      </div>
    </div>
  )
}

function SharedLinkRow({ item, orgId }: { item: ShareListItem; orgId: string }) {
  const Icon = item.kind === "site" ? Folder : FileText
  const target = `/file/~/${orgId}/${item.drive.id}/${item.path.replace(/^\/+/, "")}`
  const expiry = expiryLabel(item.expiresAt)
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Link to={target} className="min-w-0 truncate font-mono text-sm hover:underline">
            {item.path === "/" ? "/ (whole drive)" : item.path}
          </Link>
          <Badge variant="outline">{item.kind === "site" ? "Site" : "File"}</Badge>
          <Badge variant={item.status === "active" ? "secondary" : "destructive"}>{statusLabel(item.status)}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          <span>{item.drive.name ?? item.drive.id}</span>
          {" · "}
          <span title={item.expiresAt ? formatWhen(item.expiresAt) : undefined}>
            {item.expiresAt === null ? "Never expires" : item.status === "expired" ? `Expired ${expiry}` : `Expires ${expiry}`}
          </span>
          {" · "}
          {viewsLabel(item.views, item.maxViews)}
          {" · "}
          created {formatWhen(item.createdAt)}
        </p>
      </div>
      {item.canRevoke && item.status !== "revoked" && (
        <RevokeButton item={item} label={`link to ${item.path}`} />
      )}
    </li>
  )
}
