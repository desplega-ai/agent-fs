import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Link2, Trash2 } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { fetchFreshOrgMembers, useInviteMutations, usePendingInvites } from "@/hooks/use-org-members"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { CopyLinkField } from "@/components/CopyLinkField"
import { buildAcceptLink, describeTimeLeft, findOrgMember, formatExpiry } from "@/lib/invites"
import { toast } from "@/stores/toast"
import type { ApiError } from "@/api/client"
import type { ManageableDrive, PendingInvite } from "@/api/types"

function errorMessage(err: unknown): string {
  return (err as Partial<ApiError> | null)?.message || "Something went wrong"
}

type FreshLink = { link: string; expiresAt: string; skipped: number }

/**
 * Invites that were sent and not yet accepted, for org admins. A link is shown
 * only once, when it is made, so "New link" issues a new one and the old one
 * stops working. That is confirmed first, in the row, where touch and keyboard
 * users see it as well.
 */
export function PendingInvites({ orgId, drives }: { orgId: string; drives: ManageableDrive[] | undefined }) {
  const { credential, client } = useAuth()
  const queryClient = useQueryClient()
  const invites = usePendingInvites(orgId, true)
  const { invite, revoke } = useInviteMutations(orgId)
  const [fresh, setFresh] = useState<Record<string, FreshLink>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState<string | null>(null)

  const setError = (id: string, message: string | null) =>
    setErrors((prev) => {
      const next = { ...prev }
      if (message) next[id] = message
      else delete next[id]
      return next
    })

  const reissue = async (row: PendingInvite) => {
    setError(row.id, null)
    try {
      // A drive deleted since the invite was sent would make the server refuse the whole invite, so
      // those are left out. That needs the drive list as it is now: a missing or stale one would
      // drop real grants from the new link, and the old link is already gone by then.
      const [current, orgMembers] = await Promise.all([
        queryClient.fetchQuery({
          queryKey: ["manageable-drives", orgId],
          queryFn: () => client.getManageableDrives(orgId),
          staleTime: 0,
        }),
        fetchFreshOrgMembers(queryClient, client, orgId),
      ])
      // Inviting someone already in the org resets their org role to the one on this invite.
      const member = findOrgMember(orgMembers.members, row.email)
      if (member) {
        setError(row.id, `${row.email} is already in the org as ${member.role}. A new link would reset that role. Revoke this invite instead.`)
        return
      }
      const known = new Set(current.drives.map((d) => d.id))
      const grants = row.drives.filter((g) => known.has(g.driveId))
      const result = await invite.mutateAsync({ email: row.email, role: row.orgRole, drives: grants })
      if (result.status === "added") {
        toast.success(`${result.email} has an account now and was added`)
        return
      }
      const link = buildAcceptLink({ token: result.token, endpoint: credential.endpoint, acceptUrl: result.acceptUrl })
      setFresh((prev) => ({ ...prev, [row.email]: { link, expiresAt: result.expiresAt, skipped: row.drives.length - grants.length } }))
      void navigator.clipboard?.writeText(link).catch(() => {})
    } catch (err) {
      setError(row.id, errorMessage(err))
    } finally {
      setConfirming(null)
    }
  }

  const revokeRow = (row: PendingInvite) => {
    setError(row.id, null)
    revoke.mutate(row.id, {
      onSuccess: () => toast.success(`Revoked the invite for ${row.email}`),
      onError: (err) => setError(row.id, errorMessage(err)),
    })
  }

  const driveLabel = (row: PendingInvite) => {
    // While the drive list loads or fails, a name is unknown, not deleted.
    const names = row.drives.map((g) => `${drives ? (drives.find((d) => d.id === g.driveId)?.name ?? "deleted drive") : "…"} (${g.role})`)
    return names.length ? names.join(", ") : "no drives"
  }

  let body: React.ReactNode
  if (invites.isPending) {
    body = <div className="flex justify-center py-4"><Spinner /></div>
  } else if (invites.error) {
    body = <p role="alert" className="text-sm text-destructive">{errorMessage(invites.error)}</p>
  } else if (invites.data.invites.length === 0) {
    body = <p className="text-sm text-muted-foreground">No pending invites.</p>
  } else {
    body = (
      <ul aria-label="Pending invites" className="divide-y divide-border rounded-lg border border-border">
        {invites.data.invites.map((row) => (
          <li key={row.id} data-invite-email={row.email} className="space-y-2 px-3 py-2">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{row.email}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {driveLabel(row)} · org {row.orgRole} · {row.expired ? "expired" : `expires ${describeTimeLeft(row.expiresAt)}`}
                </div>
              </div>
              <Button
                variant="outline"
                size="xs"
                disabled={invite.isPending || confirming === row.id}
                aria-label={`New link for ${row.email}`}
                onClick={() => setConfirming(row.id)}
              >
                <Link2 />
                New link
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={revoke.isPending}
                aria-label={`Revoke invite for ${row.email}`}
                onClick={() => revokeRow(row)}
              >
                <Trash2 />
              </Button>
            </div>
            {confirming === row.id && (
              <div role="group" aria-label={`Confirm new link for ${row.email}`} className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
                <p className="text-sm">
                  This makes a new link for {row.email}. The link they have now stops working.
                </p>
                <div className="flex gap-2">
                  <Button size="xs" disabled={invite.isPending} onClick={() => void reissue(row)}>
                    {invite.isPending ? <Spinner size="sm" /> : null}
                    Make new link
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setConfirming(null)}>Cancel</Button>
                </div>
              </div>
            )}
            {fresh[row.email] && (
              <div className="space-y-1 pl-0.5">
                <CopyLinkField link={fresh[row.email].link} label={`Accept link for ${row.email}`} />
                <p className="text-xs text-muted-foreground">New link, expires {formatExpiry(fresh[row.email].expiresAt)}. The previous one no longer works.{fresh[row.email].skipped > 0 && ` ${fresh[row.email].skipped} deleted drive(s) were left out.`}</p>
              </div>
            )}
            {errors[row.id] && <p role="alert" className="text-xs text-destructive">{errors[row.id]}</p>}
          </li>
        ))}
      </ul>
    )
  }

  return (
    <section aria-label="Pending invites" className="space-y-2">
      <h2 className="text-sm font-medium">Pending invites</h2>
      {body}
    </section>
  )
}
