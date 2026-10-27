import { useMemo, useState, type FormEvent, type ReactNode } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { LogIn, UserPlus } from "lucide-react"
import { AgentFsClient, type ApiError } from "@/api/client"
import { AuthProvider } from "@/contexts/auth"
import { AccountSwitcher } from "@/components/AccountSwitcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { formatExpiry } from "@/lib/invites"
import { getActiveCredential, saveCredential, setActiveCredential, type Credential } from "@/stores/credentials"
import { toast } from "@/stores/toast"
import { useDocumentTitle } from "@/hooks/use-document-title"
import type { AcceptInviteResult, InvitePreview, MeResponse } from "@/api/types"

const trimEndpoint = (endpoint: string) => endpoint.trim().replace(/\/+$/, "")

function errorMessage(err: unknown): string {
  return (err as Partial<ApiError> | null)?.message || "Something went wrong"
}

/** The saved account for `endpoint` that is active in this browser, if any. */
function activeCredentialFor(endpoint: string | null): Credential | null {
  const active = getActiveCredential()
  if (!active || !endpoint) return null
  return trimEndpoint(active.endpoint) === endpoint ? active : null
}

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {children}
      </div>
    </div>
  )
}

/**
 * Where an accept link lands. It works without an account: the link names the
 * API server (`?apiUrl=`), the page previews the invite from the public
 * endpoint, then registers the invited email (locked) or connects an existing
 * account, accepts, and opens the first drive the invite granted.
 */
export function AcceptInvitePage() {
  useDocumentTitle("Accept invite")
  const token = useParams().token ?? ""
  const [search] = useSearchParams()
  const apiUrlParam = search.get("apiUrl")
  const [typedEndpoint, setTypedEndpoint] = useState<string | null>(null)
  // The link names the server; a link without it falls back to what was typed, then to the saved account.
  const savedEndpoint = getActiveCredential()?.endpoint
  const endpoint = apiUrlParam ? trimEndpoint(apiUrlParam) : (typedEndpoint ?? (savedEndpoint ? trimEndpoint(savedEndpoint) : null))

  const preview = useQuery({
    queryKey: ["invite-preview", endpoint, token],
    queryFn: () => AgentFsClient.getInvitePreview({ endpoint: endpoint!, token }),
    enabled: !!endpoint,
    retry: false,
  })

  if (!endpoint) return <EndpointPrompt onSubmit={setTypedEndpoint} />
  if (preview.isPending) {
    return (
      <Frame title="Checking your invite">
        <div className="flex justify-center py-6"><Spinner /></div>
      </Frame>
    )
  }
  if (preview.error || !preview.data) return <InvalidInvite error={preview.error} />
  return <InviteBody key={token} token={token} endpoint={endpoint} invite={preview.data} />
}

/** Links from the CLI carry no server address; ask for it once. */
function EndpointPrompt({ onSubmit }: { onSubmit: (endpoint: string) => void }) {
  const [value, setValue] = useState("")
  return (
    <Frame title="Open your invite">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) onSubmit(trimEndpoint(value))
        }}
        className="space-y-4"
      >
        <p className="text-sm text-muted-foreground">Enter the agent-fs server URL this invite came from.</p>
        <Input
          type="url"
          required
          aria-label="Server URL"
          placeholder="https://your-instance.fly.dev"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button type="submit" className="w-full" size="lg">Continue</Button>
      </form>
    </Frame>
  )
}

/** Unknown, expired, revoked and used links get one message on purpose. */
function InvalidInvite({ error }: { error: unknown }) {
  const status = (error as Partial<ApiError> | null)?.status
  // No status: the request never got an answer. 429 and 5xx say nothing about the link itself.
  const unreachable = status === undefined || status === 429 || status >= 500
  return (
    <Frame title="This invite link doesn't work">
      <p role="alert" className="text-sm text-muted-foreground">
        {unreachable
          ? `Couldn't reach the server (${errorMessage(error)}). Check the link, or try again in a moment.`
          : "Ask the person who invited you for a new link."}
      </p>
    </Frame>
  )
}

function InviteBody({ token, endpoint, invite }: { token: string; endpoint: string; invite: InvitePreview }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  // The active account lives in localStorage; bumping this re-renders so it is read again.
  const [, setSession] = useState(0)
  const credential = activeCredentialFor(endpoint)
  const [accepted, setAccepted] = useState<AcceptInviteResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const me = useQuery({
    queryKey: ["me", credential?.id],
    queryFn: () => new AgentFsClient({ endpoint, apiKey: credential!.apiKey }).getMe(),
    enabled: !!credential,
    retry: false,
  })

  const connectHref = useMemo(() => {
    const next = `/invite/${token}?apiUrl=${encodeURIComponent(endpoint)}`
    return `/credentials?variant=connect&apiUrl=${encodeURIComponent(endpoint)}&next=${encodeURIComponent(next)}`
  }, [token, endpoint])

  const accept = async (client: AgentFsClient, credentialId: string) => {
    setBusy(true)
    setError(null)
    try {
      const result = await client.acceptInvite(token)
      setActiveCredential(credentialId)
      // The account just gained an org and drives; nothing cached about it is current.
      await queryClient.invalidateQueries()
      if (result.skippedDrives.length) {
        toast.error(`${result.skippedDrives.length} drive(s) in this invite no longer exist and were skipped`)
      }
      const first = result.drives[0]
      if (first) navigate(`/file/~/${result.orgId}/${first.driveId}/`, { replace: true })
      else setAccepted(result)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const register = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await AgentFsClient.register({ endpoint, email: invite.email })
      const id = crypto.randomUUID()
      saveCredential({ id, name: invite.email, endpoint, apiKey: result.apiKey })
      setActiveCredential(id)
      setSession((s) => s + 1)
      await accept(new AgentFsClient({ endpoint, apiKey: result.apiKey }), id)
    } catch (err) {
      const e = err as Partial<ApiError>
      setError(
        e.error === "CONFLICT"
          ? `An account for ${invite.email} already exists. Connect to it with its API key instead.`
          : errorMessage(err),
      )
      setBusy(false)
    }
  }

  if (accepted) {
    return (
      <Frame title={`You joined ${invite.orgName}`}>
        <p className="text-sm text-muted-foreground">
          This invite gave you no drive access yet. Ask an org admin to add you to a drive.
        </p>
        <Button className="w-full" size="lg" onClick={() => navigate("/files", { replace: true })}>Open agent-fs</Button>
      </Frame>
    )
  }

  const summary = (
    <div className="space-y-3">
      <p className="text-sm">
        <span className="font-medium">{invite.invitedBy}</span> invited <span className="font-medium">{invite.email}</span> to{" "}
        <span className="font-medium">{invite.orgName}</span>.
      </p>
      {invite.drives.length > 0 && (
        <ul aria-label="Drives in this invite" className="divide-y divide-border rounded-lg border border-border">
          {invite.drives.map((d) => (
            <li key={d.driveId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="truncate">{d.name}</span>
              <span className="text-xs text-muted-foreground">{d.role}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">Link expires {formatExpiry(invite.expiresAt)}.</p>
    </div>
  )

  const signedIn = credential && me.data ? me.data : null
  if (credential && me.isPending) {
    return (
      <Frame title={`Join ${invite.orgName}`}>
        {summary}
        <div className="flex justify-center py-2"><Spinner /></div>
      </Frame>
    )
  }

  if (signedIn) {
    return (
      <SignedIn
        invite={invite}
        me={signedIn}
        summary={summary}
        busy={busy}
        error={error}
        connectHref={connectHref}
        onAccept={() => void accept(new AgentFsClient({ endpoint, apiKey: credential!.apiKey }), credential!.id)}
        onSwitched={() => {
          setError(null)
          setSession((s) => s + 1)
        }}
      />
    )
  }

  return (
    <Frame title={`Join ${invite.orgName}`}>
      {summary}
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          void register()
        }}
        aria-label="Create your account"
        className="space-y-4"
      >
        <div className="space-y-1.5">
          <label htmlFor="invite-email" className="block text-sm font-medium">Your email</label>
          <Input id="invite-email" type="email" value={invite.email} readOnly disabled />
          <p className="text-xs text-muted-foreground">The invite is for this address, so it can't be changed.</p>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" size="lg" disabled={busy}>
          <UserPlus />
          {busy ? "Creating your account..." : "Create account and accept"}
        </Button>
      </form>
      <Button variant="ghost" className="w-full" onClick={() => navigate(connectHref)}>
        <LogIn />
        I already have an account
      </Button>
    </Frame>
  )
}

function SignedIn({
  invite,
  me,
  summary,
  busy,
  error,
  connectHref,
  onAccept,
  onSwitched,
}: {
  invite: InvitePreview
  me: MeResponse
  summary: ReactNode
  busy: boolean
  error: string | null
  connectHref: string
  onAccept: () => void
  onSwitched: () => void
}) {
  const navigate = useNavigate()
  const matches = me.email.toLowerCase() === invite.email.toLowerCase()

  if (matches) {
    return (
      <Frame title={`Join ${invite.orgName}`}>
        {summary}
        <p className="text-sm text-muted-foreground">You're signed in as {me.email}.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button className="w-full" size="lg" onClick={onAccept} disabled={busy}>
          {busy ? "Accepting..." : "Accept"}
        </Button>
      </Frame>
    )
  }

  return (
    <Frame title={`Join ${invite.orgName}`}>
      {summary}
      <div role="alert" className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
        <p>This invite is for {invite.email}, but you're signed in as {me.email}.</p>
        <p className="text-muted-foreground">Switch to the right account to accept it.</p>
      </div>
      {/* The switcher reads the signed-in account, so it needs the auth provider. */}
      <AuthProvider>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
          <span className="text-sm text-muted-foreground">Account</span>
          <AccountSwitcher onSwitched={onSwitched} />
        </div>
      </AuthProvider>
      <Button variant="ghost" className="w-full" onClick={() => navigate(connectHref)}>
        <LogIn />
        Connect with an API key
      </Button>
    </Frame>
  )
}
