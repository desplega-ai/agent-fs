import { useState, type FormEvent } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useAuth } from "@/contexts/auth"
import {
  fetchFreshDriveRoles,
  fetchFreshOrgMembers,
  useDriveRolesOf,
  useFreshOrgMembers,
  useInviteMutations,
  useManageableDrives,
} from "@/hooks/use-org-members"
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
import { Spinner } from "@/components/ui/spinner"
import { CopyLinkField } from "@/components/CopyLinkField"
import {
  buildAcceptLink,
  DEFAULT_INVITE_DRIVE_ROLE,
  DEFAULT_INVITE_ORG_ROLE,
  findOrgMember,
  formatExpiry,
  splitDriveGrants,
} from "@/lib/invites"
import { ROLES, selectClass } from "@/lib/member-roles"
import type { ApiError } from "@/api/client"
import type { DriveGrant, ManageableDrive, MemberRole, OrgMember } from "@/api/types"

function errorMessage(err: unknown): string {
  return (err as Partial<ApiError> | null)?.message || "Something went wrong"
}

type Outcome =
  | { kind: "added"; email: string; granted: string[]; kept: string[] }
  | { kind: "pending"; email: string; link: string; expiresAt: string; granted: string[] }

const grantLabel = (drives: ManageableDrive[], grants: DriveGrant[]) =>
  grants.map((g) => `${drives.find((d) => d.id === g.driveId)?.name ?? g.driveId} (${g.role})`)

/**
 * Invite someone: who (an email), where (drives with a role each) and their
 * org role. An email with an account is added on the spot; a new email gets a
 * link to copy and send, because agent-fs sends no mail. Someone already in
 * the org is added to the chosen drives instead of re-invited, since an invite
 * would reset their org role, and drives they already have a role on are left
 * alone, since adding would reset that role too.
 *
 * Both guards read fresh data: the form stays disabled until the member list
 * has loaded, and the lists are read again right before anything is written.
 *
 * Callers mount it only while open, so every opening starts with fresh state.
 */
export function InviteDialog({
  open,
  onOpenChange,
  orgId,
  initialDriveId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: string
  /** Drive the dialog was opened from; pre-checked. */
  initialDriveId?: string | null
}) {
  const { credential, client } = useAuth()
  const queryClient = useQueryClient()
  const manageable = useManageableDrives(orgId)
  const orgMembers = useFreshOrgMembers(orgId)
  const { invite, addToDrive } = useInviteMutations(orgId)

  const [email, setEmail] = useState("")
  const [orgRole, setOrgRole] = useState<MemberRole>(DEFAULT_INVITE_ORG_ROLE)
  const [checked, setChecked] = useState<Set<string>>(() => new Set(initialDriveId ? [initialDriveId] : []))
  const [driveRoles, setDriveRoles] = useState<Record<string, MemberRole>>({})
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  const drives = manageable.data?.drives
  // Only a lookup that succeeded and is not being refreshed says who is in the org.
  const lookupReady = orgMembers.isSuccess && !orgMembers.isFetching
  const existing = lookupReady ? findOrgMember(orgMembers.data.members, email) : undefined
  const { roles, failed } = useDriveRolesOf(orgId, existing ? (drives ?? []).map((d) => d.id) : [], existing?.userId)
  // For someone already in the org, only drives they are not on can be picked.
  const selectable = (driveId: string) => !existing || roles[driveId] === null
  const picked = (drives ?? []).filter((d) => checked.has(d.id) && selectable(d.id))
  const busy = invite.isPending || addToDrive.isPending
  const canSubmit = !!email.trim() && !busy && !!drives && lookupReady && (!existing || picked.length > 0)

  const toggle = (driveId: string) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(driveId)) next.delete(driveId)
      else next.add(driveId)
      return next
    })

  const grants: DriveGrant[] = picked.map((d) => ({ driveId: d.id, role: driveRoles[d.id] ?? DEFAULT_INVITE_DRIVE_ROLE }))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!canSubmit || !drives) return
    setError(null)
    const value = email.trim()

    // The form was built from a list that can be minutes old. Read membership again right before
    // writing: inviting someone who joined meanwhile would reset their org role.
    let nowMember: OrgMember | undefined
    try {
      nowMember = findOrgMember((await fetchFreshOrgMembers(queryClient, client, orgId)).members, value)
    } catch (err) {
      setError(`Couldn't check who is already in the org (${errorMessage(err)}). Nothing was sent.`)
      return
    }
    if (nowMember?.userId !== existing?.userId) {
      setError(`Org membership for ${value} changed while you were filling this in. Nothing was sent. Check the form and submit again.`)
      return
    }

    try {
      if (existing) {
        // The invite endpoint would reset their org role; the drive endpoint only touches drives.
        // It also overwrites a drive role, so drives they have joined since are left as they are.
        let split: ReturnType<typeof splitDriveGrants>
        try {
          split = splitDriveGrants(grants, await fetchFreshDriveRoles(queryClient, client, orgId, grants.map((g) => g.driveId), existing.userId))
        } catch (err) {
          setError(`Couldn't check their current drive roles (${errorMessage(err)}). Nothing was sent.`)
          return
        }
        const added: DriveGrant[] = []
        const failedOn: string[] = []
        for (const grant of split.add) {
          try {
            await addToDrive.mutateAsync({ driveId: grant.driveId, email: existing.email, role: grant.role })
            added.push(grant)
          } catch (err) {
            failedOn.push(`${drives.find((d) => d.id === grant.driveId)?.name ?? grant.driveId}: ${errorMessage(err)}`)
          }
        }
        if (failedOn.length) {
          setError(`${added.length ? `Added to ${grantLabel(drives, added).join(", ")}. ` : ""}Failed on ${failedOn.join("; ")}`)
          // Keep what is left to retry: drop the drives that went through.
          setChecked(new Set(split.add.filter((g) => !added.includes(g)).map((g) => g.driveId)))
          return
        }
        setOutcome({ kind: "added", email: existing.email, granted: grantLabel(drives, added), kept: grantLabel(drives, split.kept) })
        return
      }

      const result = await invite.mutateAsync({ email: value, role: orgRole, drives: grants })
      if (result.status === "added") {
        setOutcome({ kind: "added", email: result.email, granted: grantLabel(drives, result.drives), kept: [] })
      } else {
        setOutcome({
          kind: "pending",
          email: result.email,
          link: buildAcceptLink({ token: result.token, endpoint: credential.endpoint, acceptUrl: result.acceptUrl }),
          expiresAt: result.expiresAt,
          granted: grantLabel(drives, result.drives),
        })
      }
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const reset = () => {
    setOutcome(null)
    setEmail("")
    setError(null)
    setOrgRole(DEFAULT_INVITE_ORG_ROLE)
    setChecked(new Set())
    setDriveRoles({})
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite people</DialogTitle>
          <DialogDescription>Pick who to invite and which drives they can open.</DialogDescription>
        </DialogHeader>

        {outcome ? (
          <ResultView outcome={outcome} onInviteAnother={reset} onDone={() => onOpenChange(false)} />
        ) : (
          <form onSubmit={submit} aria-label="Invite people" className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="invite-email" className="block text-sm font-medium">Who</label>
              <Input
                id="invite-email"
                type="email"
                autoFocus
                placeholder="name@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              {orgMembers.isError ? (
                <div role="alert" className="flex items-center justify-between gap-3 text-sm text-destructive">
                  <span>
                    Couldn't check who is already in the org ({errorMessage(orgMembers.error)}). Inviting is paused so
                    nobody's role gets overwritten.
                  </span>
                  <Button type="button" variant="outline" size="xs" onClick={() => void orgMembers.refetch()}>Retry</Button>
                </div>
              ) : !lookupReady ? (
                <p role="status" className="text-xs text-muted-foreground">Checking who is already in the org...</p>
              ) : existing ? (
                <p role="status" className="text-xs text-muted-foreground">
                  {existing.email} is already in the org as {existing.role}. Choose the drives to add them to; their
                  org role and any role they already have on a drive stay as they are.
                </p>
              ) : null}
            </div>

            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium">Where</legend>
              {manageable.isPending ? (
                <div className="flex justify-center py-4"><Spinner /></div>
              ) : manageable.error ? (
                <p role="alert" className="text-sm text-destructive">{errorMessage(manageable.error)}</p>
              ) : (
                <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                  {(drives ?? []).map((d) => {
                    const on = checked.has(d.id) && selectable(d.id)
                    // Someone already in the org: say why a drive cannot be picked.
                    const current = existing ? roles[d.id] : null
                    const note = !existing || current === null
                      ? null
                      : failed.includes(d.id)
                        ? "Couldn't check"
                        : current === undefined
                          ? "Checking..."
                          : `Already ${current}`
                    return (
                      <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                        <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="size-4 shrink-0 accent-primary"
                            checked={on}
                            disabled={!selectable(d.id)}
                            onChange={() => toggle(d.id)}
                          />
                          <span className="truncate">{d.name}</span>
                        </label>
                        {note ? (
                          <span className="text-xs text-muted-foreground">{note}</span>
                        ) : (
                          <select
                            aria-label={`Role on ${d.name}`}
                            className={selectClass}
                            value={driveRoles[d.id] ?? DEFAULT_INVITE_DRIVE_ROLE}
                            disabled={!on}
                            onChange={(e) => setDriveRoles((prev) => ({ ...prev, [d.id]: e.target.value as MemberRole }))}
                          >
                            {ROLES.map((r) => (
                              <option key={r.value} value={r.value}>{r.label}</option>
                            ))}
                          </select>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
              {!existing && picked.length === 0 && drives && (
                <p className="text-xs text-muted-foreground">No drive picked: they join the org but cannot open any files yet.</p>
              )}
            </fieldset>

            {!existing && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor="invite-org-role" className="text-sm font-medium">Org role</label>
                  <select
                    id="invite-org-role"
                    className={selectClass}
                    value={orgRole}
                    onChange={(e) => setOrgRole(e.target.value as MemberRole)}
                  >
                    {ROLES.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                </div>
                <p className="text-xs text-muted-foreground">The org role does not grant file access by itself. Drive roles do.</p>
              </div>
            )}

            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={!canSubmit}>
                {busy ? <Spinner size="sm" /> : null}
                {existing ? "Add to drives" : "Invite"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ResultView({
  outcome,
  onInviteAnother,
  onDone,
}: {
  outcome: Outcome
  onInviteAnother: () => void
  onDone: () => void
}) {
  const granted = outcome.granted.length ? outcome.granted.join(", ") : "no drives yet"
  const kept = outcome.kind === "added" ? outcome.kept : []
  return (
    <div className="space-y-4">
      {outcome.kind === "added" ? (
        <div role="status" className="space-y-1">
          <p className="text-sm font-medium">
            {kept.length && !outcome.granted.length ? `${outcome.email} is already on those drives` : `Added ${outcome.email}`}
          </p>
          {(outcome.granted.length > 0 || kept.length === 0) && (
            <p className="text-sm text-muted-foreground">Drives: {granted}.</p>
          )}
          {kept.length > 0 && (
            <p className="text-sm text-muted-foreground">Left as they were: {kept.join(", ")}.</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div role="status" className="space-y-1">
            <p className="text-sm font-medium">{outcome.email} has no account yet</p>
            <p className="text-sm text-muted-foreground">
              Send them this link. It gives access to {granted} once they accept, and works once.
            </p>
          </div>
          <CopyLinkField link={outcome.link} label="Accept link" />
          <p className="text-xs text-muted-foreground">Expires {formatExpiry(outcome.expiresAt)}.</p>
        </div>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onInviteAnother}>Invite another</Button>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </div>
  )
}
