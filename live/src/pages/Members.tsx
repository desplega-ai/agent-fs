import { useMemo, useState, type FormEvent } from "react"
import { useNavigate, useParams } from "react-router"
import { Check, ChevronDown, HardDrive, Trash2, Users } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import {
  useDriveMemberMutations,
  useDriveMembersAdmin,
  useDriveMembersOf,
  useManageableDrives,
  useOrgMembers,
} from "@/hooks/use-org-members"
import { useDocumentTitle } from "@/hooks/use-document-title"
import { UserAvatar } from "@/components/UserAvatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { toast } from "@/stores/toast"
import { cn } from "@/lib/utils"
import type { ApiError } from "@/api/client"
import type { DriveMemberWithRole, MemberRole } from "@/api/types"

const ROLES: { value: MemberRole; label: string }[] = [
  { value: "viewer", label: "Viewer" },
  { value: "editor", label: "Editor" },
  { value: "admin", label: "Admin" },
]

const selectClass =
  "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"

function errorMessage(err: unknown): string {
  const e = err as Partial<ApiError> | null
  return e?.message || "Something went wrong"
}

/** A change to your own row that costs you access, waiting for a second click. */
type PendingSelfChange = { kind: "remove" } | { kind: "demote"; role: MemberRole }

/**
 * Members of one drive. Drive admins and org admins add existing org members,
 * change roles and remove people; everyone else gets a read-only list. The
 * admin endpoint's 403 decides which view renders.
 */
export function MembersPage() {
  const params = useParams()
  const orgId = params.orgId ?? null
  const driveId = params.driveId ?? null
  const { drives } = useAuth()
  const { data: manageable } = useManageableDrives(orgId)
  const admin = useDriveMembersAdmin(orgId, driveId)
  const directory = useDriveMembersOf(orgId, driveId)

  const driveName =
    manageable?.drives.find((d) => d.id === driveId)?.name ??
    drives.find((d) => d.id === driveId)?.name ??
    driveId?.slice(0, 8) ??
    ""
  useDocumentTitle(driveName ? `Members · ${driveName}` : "Members")

  const forbidden = (admin.error as Partial<ApiError> | null)?.status === 403

  let body: React.ReactNode
  if (!orgId || !driveId) {
    body = null
  } else if (admin.isPending) {
    body = <div className="flex justify-center py-10"><Spinner /></div>
  } else if (forbidden) {
    // Checked before cached data: after you drop your own admin role the
    // refetch 403s while the old admin list is still cached.
    body = <ReadOnlyMembers members={directory.data?.members} loading={directory.isPending} error={directory.error} />
  } else if (admin.data) {
    body = (
      <AdminMembers
        // A fresh instance per drive, so pending confirmations and row errors
        // never carry over to another drive.
        key={`${orgId}/${driveId}`}
        orgId={orgId}
        driveId={driveId}
        driveName={driveName}
        members={admin.data.members}
        names={directory.data?.members}
      />
    )
  } else {
    body = <p role="alert" className="text-sm text-destructive">{errorMessage(admin.error)}</p>
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-6">
        <header className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Users className="size-4 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Members</h1>
            <DrivePickerMenu orgId={orgId} driveId={driveId} driveName={driveName} drives={manageable?.drives} />
          </div>
          <p className="text-sm text-muted-foreground">People who can open files on this drive, and their role.</p>
        </header>
        {body}
      </div>
    </div>
  )
}

/** Lets an admin hop between the drives they manage. A plain label otherwise. */
function DrivePickerMenu({
  orgId,
  driveId,
  driveName,
  drives,
}: {
  orgId: string | null
  driveId: string | null
  driveName: string
  drives: { id: string; name: string }[] | undefined
}) {
  const navigate = useNavigate()
  const label = (
    <>
      <HardDrive className="size-3.5 shrink-0" />
      <span className="max-w-60 truncate">{driveName}</span>
    </>
  )
  if (!drives || drives.length <= 1) {
    return <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">{label}</span>
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="sm" className="gap-1 text-muted-foreground" aria-label={`Drive: ${driveName}`}>
            {label}
            <ChevronDown className="size-3" />
          </Button>
        }
      />
      <DropdownMenuContent align="start">
        {drives.map((d) => (
          <DropdownMenuItem key={d.id} onClick={() => navigate(`/members/~/${orgId}/${d.id}`)}>
            <HardDrive className="size-3 text-muted-foreground" />
            <span className="flex-1 truncate">{d.name}</span>
            {d.id === driveId && <Check className="ml-auto size-3 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ReadOnlyMembers({
  members,
  loading,
  error,
}: {
  members: { userId: string; email: string; displayName: string | null }[] | undefined
  loading: boolean
  error: unknown
}) {
  if (loading) return <div className="flex justify-center py-10"><Spinner /></div>
  if (error) return <p role="alert" className="text-sm text-destructive">{errorMessage(error)}</p>
  return (
    <section className="space-y-3">
      <p className="text-sm text-muted-foreground">Only drive admins and org admins can change who is on this drive.</p>
      <ul aria-label="Drive members" className="divide-y divide-border rounded-lg border border-border">
        {(members ?? []).map((m) => (
          <li key={m.userId} className="flex items-center gap-3 px-3 py-2">
            <UserAvatar userId={m.userId} displayName={m.displayName ?? m.email} className="size-7 text-xs" />
            <PersonLabel name={m.displayName} email={m.email} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function PersonLabel({ name, email, you }: { name: string | null | undefined; email: string; you?: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-medium">
        {name || email}
        {you && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}
      </div>
      {name && <div className="truncate text-xs text-muted-foreground">{email}</div>}
    </div>
  )
}

function AdminMembers({
  orgId,
  driveId,
  driveName,
  members,
  names,
}: {
  orgId: string
  driveId: string
  driveName: string
  members: DriveMemberWithRole[]
  names: { userId: string; displayName: string | null }[] | undefined
}) {
  const navigate = useNavigate()
  const { user, drives, driveId: activeDriveId, setDriveId } = useAuth()
  const orgMembers = useOrgMembers()
  const { add, updateRole, remove } = useDriveMemberMutations(orgId, driveId)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<PendingSelfChange | null>(null)

  const displayNames = useMemo(
    () => new Map((names ?? []).map((n) => [n.userId, n.displayName])),
    [names],
  )
  const adminCount = members.filter((m) => m.role === "admin").length
  // The org list is admin-only, so it loading at all means the caller is an org admin.
  const isOrgAdmin = !!orgMembers.data
  const candidates = useMemo(() => {
    const onDrive = new Set(members.map((m) => m.userId))
    return (orgMembers.data?.members ?? []).filter((m) => !onDrive.has(m.userId))
  }, [orgMembers.data, members])
  const sorted = useMemo(
    () => [...members].sort((a, b) => a.email.localeCompare(b.email)),
    [members],
  )

  const setRowError = (userId: string, message: string | null) =>
    setRowErrors((prev) => {
      const next = { ...prev }
      if (message) next[userId] = message
      else delete next[userId]
      return next
    })

  const changeRole = (member: DriveMemberWithRole, role: MemberRole) => {
    setRowError(member.userId, null)
    updateRole.mutate(
      { userId: member.userId, role },
      {
        onSuccess: () => toast.success(`${member.email} is now ${role} on ${driveName}`),
        onError: (err) => setRowError(member.userId, errorMessage(err)),
      },
    )
  }

  const removeMember = (member: DriveMemberWithRole, self: boolean) => {
    setRowError(member.userId, null)
    remove.mutate(member.userId, {
      onSuccess: () => {
        toast.success(self ? `You left ${driveName}` : `Removed ${member.email} from ${driveName}`)
        // Leaving the drive you are browsing: move to one you can still open.
        if (self && driveId === activeDriveId) {
          const next = drives.find((d) => d.id !== driveId)
          if (next) {
            setDriveId(next.id)
            navigate(`/file/~/${orgId}/${next.id}/`)
          } else {
            navigate("/files")
          }
        }
      },
      onError: (err) => setRowError(member.userId, errorMessage(err)),
    })
  }

  return (
    <div className="space-y-6">
      <AddMemberForm
        isOrgAdmin={isOrgAdmin}
        candidates={candidates}
        busy={add.isPending}
        onAdd={(email, role, done) => {
          // The add endpoint upserts. Role changes for people already on the
          // drive go through their row, which holds the last-admin and
          // self-demotion guards.
          const existing = members.find((m) => m.email.toLowerCase() === email.toLowerCase())
          if (existing) {
            done(`${existing.email} is already on this drive as ${existing.role}. Change their role in the list below.`)
            return
          }
          add.mutate(
            { email, role },
            {
              onSuccess: (res) => {
                toast.success(
                  res.created ? `Added ${res.email} to ${driveName} as ${res.role}` : `${res.email} is now ${res.role} on ${driveName}`,
                )
                done(null)
              },
              onError: (err) => done(errorMessage(err)),
            },
          )
        }}
      />

      <ul aria-label="Drive members" className="divide-y divide-border rounded-lg border border-border">
        {sorted.map((m) => {
          const self = m.userId === user?.userId
          const lastAdmin = m.role === "admin" && adminCount === 1
          const confirming = self && pending
          const error = rowErrors[m.userId]
          return (
            <li key={m.userId} data-member-email={m.email} className="space-y-2 px-3 py-2">
              <div className="flex items-center gap-3">
                <UserAvatar userId={m.userId} displayName={displayNames.get(m.userId) ?? m.email} className="size-7 text-xs" />
                <PersonLabel name={displayNames.get(m.userId)} email={m.email} you={self} />
                <select
                  aria-label={`Role for ${m.email}`}
                  className={selectClass}
                  value={m.role}
                  disabled={lastAdmin || updateRole.isPending}
                  title={lastAdmin ? "The only admin of this drive. Make someone else admin first." : undefined}
                  onChange={(e) => {
                    const role = e.target.value as MemberRole
                    // Dropping your own admin role ends your access to this page
                    // unless you are an org admin: ask once more.
                    if (self && m.role === "admin" && !isOrgAdmin) setPending({ kind: "demote", role })
                    else changeRole(m, role)
                  }}
                >
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${m.email}`}
                  disabled={lastAdmin || remove.isPending}
                  title={lastAdmin ? "The only admin of this drive. Make someone else admin first." : undefined}
                  onClick={() => (self ? setPending({ kind: "remove" }) : removeMember(m, false))}
                >
                  <Trash2 />
                </Button>
              </div>
              {lastAdmin && (
                <p className="pl-10 text-xs text-muted-foreground">Only admin of this drive. Make someone else admin before changing this role or removing them.</p>
              )}
              {confirming && (
                <div role="alert" className="ml-10 flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-xs">
                  <span className="flex-1">
                    {pending.kind === "remove"
                      ? isOrgAdmin
                        ? "Remove yourself? You lose access to this drive's files; as org admin you can still manage its members."
                        : "Remove yourself? You lose access to this drive and its files."
                      : `Change your role to ${pending.role}? You will no longer manage this drive's members.`}
                  </span>
                  <Button
                    size="xs"
                    variant="destructive"
                    onClick={() => {
                      const action = pending
                      setPending(null)
                      if (action.kind === "remove") removeMember(m, true)
                      else changeRole(m, action.role)
                    }}
                  >
                    {pending.kind === "remove" ? "Remove me" : "Change my role"}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
                </div>
              )}
              {error && (
                <p role="alert" className="pl-10 text-xs text-destructive">{error}</p>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function AddMemberForm({
  isOrgAdmin,
  candidates,
  busy,
  onAdd,
}: {
  isOrgAdmin: boolean
  candidates: { userId: string; email: string; role: string }[]
  busy: boolean
  onAdd: (email: string, role: MemberRole, done: (error: string | null) => void) => void
}) {
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<MemberRole>("viewer")
  const [error, setError] = useState<string | null>(null)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const value = email.trim()
    if (!value) return
    setError(null)
    onAdd(value, role, (err) => {
      setError(err)
      if (!err) {
        setEmail("")
        setRole("viewer")
      }
    })
  }

  return (
    <form onSubmit={submit} aria-label="Add member" className="space-y-2 rounded-lg border border-border p-3">
      <div className="text-sm font-medium">Add member</div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          type="email"
          aria-label="Email"
          list={isOrgAdmin ? "org-member-options" : undefined}
          placeholder={isOrgAdmin ? "Pick an org member or type their email" : "Email of an org member"}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={error ? true : undefined}
          className="sm:flex-1"
        />
        {isOrgAdmin && (
          <datalist id="org-member-options">
            {candidates.map((c) => (
              <option key={c.userId} value={c.email}>{`org ${c.role}`}</option>
            ))}
          </datalist>
        )}
        <select aria-label="Role" className={selectClass} value={role} onChange={(e) => setRole(e.target.value as MemberRole)}>
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
        <Button type="submit" disabled={busy || !email.trim()}>
          {busy ? <Spinner size="sm" /> : null}
          Add
        </Button>
      </div>
      <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")} role={error ? "alert" : undefined}>
        {error ??
          (isOrgAdmin
            ? candidates.length
              ? `${candidates.length} org ${candidates.length === 1 ? "member is" : "members are"} not on this drive yet.`
              : "Every org member is already on this drive. Invite new people from the org."
            : "They must already be in the org. Ask an org admin to invite someone new.")}
      </p>
    </form>
  )
}
