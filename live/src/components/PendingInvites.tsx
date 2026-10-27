import { useState } from "react"
import { Link2, Trash2 } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { useInviteMutations, usePendingInvites } from "@/hooks/use-org-members"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { CopyLinkField } from "@/components/CopyLinkField"
import { buildAcceptLink, describeTimeLeft, formatExpiry } from "@/lib/invites"
import { toast } from "@/stores/toast"
import type { ApiError } from "@/api/client"
import type { ManageableDrive, PendingInvite } from "@/api/types"

function errorMessage(err: unknown): string {
  return (err as Partial<ApiError> | null)?.message || "Something went wrong"
}

type FreshLink = { link: string; expiresAt: string }

/**
 * Invites that were sent and not yet accepted, for org admins. A link is shown
 * only once, when it is made, so "Copy link" issues a new one and the old one
 * stops working.
 */
export function PendingInvites({ orgId, drives }: { orgId: string; drives: ManageableDrive[] | undefined }) {
  const { credential } = useAuth()
  const invites = usePendingInvites(orgId, true)
  const { invite, revoke } = useInviteMutations(orgId)
  const [fresh, setFresh] = useState<Record<string, FreshLink>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  const setError = (id: string, message: string | null) =>
    setErrors((prev) => {
      const next = { ...prev }
      if (message) next[id] = message
      else delete next[id]
      return next
    })

  const reissue = async (row: PendingInvite) => {
    setError(row.id, null)
    // A drive deleted since the invite was sent would make the server refuse the whole invite.
    const known = new Set((drives ?? []).map((d) => d.id))
    try {
      const result = await invite.mutateAsync({
        email: row.email,
        role: row.orgRole,
        drives: row.drives.filter((g) => known.has(g.driveId)),
      })
      if (result.status === "added") {
        toast.success(`${result.email} has an account now and was added`)
        return
      }
      const link = buildAcceptLink({ token: result.token, endpoint: credential.endpoint, acceptUrl: result.acceptUrl })
      setFresh((prev) => ({ ...prev, [row.email]: { link, expiresAt: result.expiresAt } }))
      void navigator.clipboard?.writeText(link).catch(() => {})
    } catch (err) {
      setError(row.id, errorMessage(err))
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
    const names = row.drives.map((g) => `${drives?.find((d) => d.id === g.driveId)?.name ?? "deleted drive"} (${g.role})`)
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
                disabled={invite.isPending}
                title="Makes a new link. The old one stops working."
                aria-label={`Copy link for ${row.email}`}
                onClick={() => void reissue(row)}
              >
                <Link2 />
                Copy link
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
            {fresh[row.email] && (
              <div className="space-y-1 pl-0.5">
                <CopyLinkField link={fresh[row.email].link} label={`Accept link for ${row.email}`} />
                <p className="text-xs text-muted-foreground">New link, expires {formatExpiry(fresh[row.email].expiresAt)}. The previous one no longer works.</p>
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
