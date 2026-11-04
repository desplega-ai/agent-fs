import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router"
import { useQuery } from "@tanstack/react-query"
import { Eye, EyeOff, Trash2, LogIn, Info, ArrowRight, ChevronDown, Server } from "lucide-react"
import { AgentFsClient } from "@/api/client"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  getActiveCredential,
  getCredentials,
  saveCredential,
  removeCredential,
  setActiveCredential,
  type Credential,
} from "@/stores/credentials"
import { CredentialDetailsDialog } from "@/components/credentials/CredentialDetailsDialog"
import { toast } from "@/stores/toast"
import { useDocumentTitle } from "@/hooks/use-document-title"
import { cn } from "@/lib/utils"
import { isInviteReturnPath } from "@/lib/invites"
import {
  type ContinueLink,
  continueWithSwarmLink,
  isAppReturnPath,
  newHandoffNonce,
  normalizeEndpoint,
  orgIdFromAppPath,
  rememberHandoffNonce,
} from "@/lib/key-handoff"

type Mode = "connect" | "register"

export function CredentialsPage() {
  useDocumentTitle("Credentials")
  const navigate = useNavigate()
  const initialParams = useMemo(() => new URLSearchParams(window.location.search), [])
  const [mode, setMode] = useState<Mode>(() => {
    const v = initialParams.get("variant")
    return v === "register" ? "register" : "connect"
  })
  const [endpoint, setEndpoint] = useState(() => initialParams.get("apiUrl") ?? "")
  const [apiKey, setApiKey] = useState(() => initialParams.get("apiKey") ?? "")
  const [email, setEmail] = useState(() => initialParams.get("email") ?? "")
  const [name, setName] = useState(() => initialParams.get("name") ?? "")
  const [showKey, setShowKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [credentials, setCredentials] = useState(getCredentials)
  const [detailsCred, setDetailsCred] = useState<Credential | null>(null)

  const successTarget = useMemo(() => {
    // Only the invite accept page may send people here and take them back.
    const next = initialParams.get("next")
    if (next && (isInviteReturnPath(next) || isAppReturnPath(next))) return next
    const orgId = initialParams.get("orgId")
    const driveId = initialParams.get("driveId")
    if (orgId && driveId) return `/file/~/${orgId}/${driveId}/`
    if (orgId) return `/orgs/${orgId}/files/`
    return "/files"
  }, [initialParams])

  // "Continue with <swarm>": a deep link into an org whose agent-swarm
  // dashboard is known. The API address comes from `?apiUrl=` or the saved
  // account; the swarm sends the browser back to the deep link with a key.
  const continueHref = useContinueWithSwarm(initialParams)
  // Display only: when Continue is on offer, the key forms sit behind a
  // disclosure. It starts open when the URL already fills a key form.
  const [keyFormOpen, setKeyFormOpen] = useState(
    () => initialParams.has("apiKey") || initialParams.get("variant") === "register",
  )

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setConnecting(true)

    try {
      const client = new AgentFsClient({ endpoint, apiKey })
      await client.getMe()

      const id = crypto.randomUUID()
      const cred: Credential = {
        id,
        name: name || `api-${id.slice(0, 4)}`,
        endpoint: endpoint.replace(/\/+$/, ""),
        apiKey,
      }
      saveCredential(cred)
      setActiveCredential(id)
      navigate(successTarget, { replace: true })
    } catch (err) {
      setError((err as Error).message || "Connection failed")
    } finally {
      setConnecting(false)
    }
  }

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setConnecting(true)

    try {
      const result = await AgentFsClient.register({ endpoint, email })

      const id = crypto.randomUUID()
      const cred: Credential = {
        id,
        name: name || email || `api-${id.slice(0, 4)}`,
        endpoint: endpoint.replace(/\/+$/, ""),
        apiKey: result.apiKey,
      }
      saveCredential(cred)
      setActiveCredential(id)
      navigate(successTarget, { replace: true })
    } catch (err) {
      const e = err as Error & { error?: string }
      if (e.error === "CONFLICT") {
        setError(
          "Account exists. Switch to Connect and paste your key, or use a different email.",
        )
      } else {
        setError(e.message || "Registration failed")
      }
    } finally {
      setConnecting(false)
    }
  }

  const handleQuickConnect = (cred: Credential) => {
    setActiveCredential(cred.id)
    navigate(successTarget, { replace: true })
  }

  const autoSubmittedRef = useRef(false)
  useEffect(() => {
    if (autoSubmittedRef.current) return
    if (mode !== "connect") return
    if (!endpoint || !apiKey) return
    if (!initialParams.get("apiUrl") || !initialParams.get("apiKey")) return
    autoSubmittedRef.current = true
    void handleConnect({ preventDefault: () => {} } as React.FormEvent)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleRemove = (id: string) => {
    removeCredential(id)
    setCredentials(getCredentials())
    toast.success("Credential removed")
  }

  const switchMode = (next: Mode) => {
    if (next === mode) return
    setMode(next)
    setError(null)
  }

  const heading = continueHref
    ? "Sign in"
    : mode === "register"
      ? "Create an account"
      : "Connect your server"
  const subheading = continueHref ? (
    "Your swarm signs you in and brings you back to this page."
  ) : mode === "register" ? (
    "Enter your server endpoint and email to get a new API key."
  ) : (
    <>
      Paste the endpoint and API key of your <span className="whitespace-nowrap">agent-fs</span> server.
    </>
  )

  // With "Continue with <swarm>" on offer, the key forms are the quieter path.
  const secondary = !!continueHref

  const keyForms = (
    <div className="space-y-5">
      <div
        role="tablist"
        aria-label="Authentication mode"
        className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 dark:bg-muted/60"
      >
        <Button
          type="button"
          role="tab"
          id="credentials-tab-connect"
          aria-controls="credentials-panel"
          aria-selected={mode === "connect"}
          variant="ghost"
          size="sm"
          onClick={() => switchMode("connect")}
          className={TAB}
        >
          Connect existing key
        </Button>
        <Button
          type="button"
          role="tab"
          id="credentials-tab-register"
          aria-controls="credentials-panel"
          aria-selected={mode === "register"}
          variant="ghost"
          size="sm"
          onClick={() => switchMode("register")}
          className={TAB}
        >
          Register new account
        </Button>
      </div>

      <div role="tabpanel" id="credentials-panel" aria-labelledby={`credentials-tab-${mode}`}>
        {mode === "connect" ? (
          <form onSubmit={handleConnect} className="space-y-4">
            <div className="space-y-1.5">
              <label className={LABEL} htmlFor="endpoint">
                Endpoint URL
              </label>
              <Input
                id="endpoint"
                type="url"
                required
                placeholder="https://your-instance.fly.dev"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                className={FIELD}
              />
            </div>

            <div className="space-y-1.5">
              <label className={LABEL} htmlFor="apiKey">
                API key
              </label>
              <div className="relative">
                <Input
                  id="apiKey"
                  type={showKey ? "text" : "password"}
                  required
                  placeholder="sk-..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className={cn(FIELD, "pr-10 font-mono")}
                />
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setShowKey(!showKey)}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                        aria-label={showKey ? "Hide API key" : "Show API key"}
                      >
                        {showKey ? <EyeOff /> : <Eye />}
                      </Button>
                    }
                  />
                  <TooltipContent>{showKey ? "Hide" : "Show"}</TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className={LABEL} htmlFor="name">
                Name <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <Input
                id="name"
                type="text"
                placeholder="My instance"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={FIELD}
              />
            </div>

            {error && <FormError message={error} />}

            <Button
              type="submit"
              disabled={connecting}
              variant={secondary ? "outline" : "default"}
              size="lg"
              className={SUBMIT}
            >
              {connecting ? "Connecting…" : "Connect"}
            </Button>
          </form>
        ) : (
          <form onSubmit={handleRegister} className="space-y-4">
            <div className="space-y-1.5">
              <label className={LABEL} htmlFor="endpoint">
                Endpoint URL
              </label>
              <Input
                id="endpoint"
                type="url"
                required
                placeholder="https://your-instance.fly.dev"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                className={FIELD}
              />
            </div>

            <div className="space-y-1.5">
              <label className={LABEL} htmlFor="email">
                Email
              </label>
              <Input
                id="email"
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={FIELD}
              />
            </div>

            <div className="space-y-1.5">
              <label className={LABEL} htmlFor="name">
                Name <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <Input
                id="name"
                type="text"
                placeholder="My instance"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={FIELD}
              />
            </div>

            {error && <FormError message={error} />}

            <Button
              type="submit"
              disabled={connecting}
              variant={secondary ? "outline" : "default"}
              size="lg"
              className={SUBMIT}
            >
              {connecting ? "Registering…" : "Register"}
            </Button>
          </form>
        )}
      </div>
    </div>
  )

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-12 sm:py-20">
      <div className="w-full max-w-[25rem]">
        <header className="mb-8 text-center">
          <p className="font-mono text-xs tracking-[0.08em] text-muted-foreground">
            <span aria-hidden>/ </span>
            <span className="text-primary">agent-fs</span>
          </p>
          <h1 className="mt-3 text-[1.75rem] leading-[1.1] font-medium tracking-[-0.03em] text-balance">
            {heading}
          </h1>
          <p className="mx-auto mt-3 max-w-[36ch] text-[0.9375rem] leading-relaxed text-pretty text-muted-foreground">
            {subheading}
          </p>
        </header>

        {continueHref ? (
          <>
            <section aria-label="Sign in with your swarm" className={CARD}>
              <a
                href={continueHref.href}
                onClick={continueHref.remember}
                onAuxClick={continueHref.remember}
                onContextMenu={continueHref.remember}
                className={buttonVariants({ size: "lg", className: "h-11 w-full text-[0.9375rem]" })}
              >
                <span className="truncate">Continue with {continueHref.host}</span>
                <ArrowRight />
              </a>
              {continueHref.apiHost && (
                <p className="mt-4 flex min-w-0 items-center justify-center gap-1.5 text-xs text-muted-foreground">
                  <Server aria-hidden className="size-3.5 shrink-0" />
                  <span className="shrink-0">agent-fs server</span>
                  <span className="truncate font-mono text-foreground/80" title={continueHref.apiHost}>
                    {continueHref.apiHost}
                  </span>
                </p>
              )}
            </section>

            <div className="mt-6">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={keyFormOpen}
                aria-controls="credentials-key-form"
                onClick={() => setKeyFormOpen((open) => !open)}
                className="mx-auto flex text-muted-foreground"
              >
                Use an API key instead
                <ChevronDown
                  aria-hidden
                  className={cn("transition-transform duration-150 motion-reduce:transition-none", keyFormOpen && "rotate-180")}
                />
              </Button>
              {keyFormOpen && (
                <section
                  id="credentials-key-form"
                  aria-label="Connect with an API key"
                  className={cn(
                    CARD,
                    "mt-3 animate-in fade-in-0 slide-in-from-top-1 duration-200 motion-reduce:slide-in-from-top-0",
                  )}
                >
                  {keyForms}
                </section>
              )}
            </div>
          </>
        ) : (
          <section aria-label="Connect with an API key" className={CARD}>
            {keyForms}
          </section>
        )}

        <CredentialDetailsDialog
          credential={detailsCred}
          open={!!detailsCred}
          onOpenChange={(o) => !o && setDetailsCred(null)}
          onCredentialUpdated={() => setCredentials(getCredentials())}
        />

        {credentials.length > 0 && (
          <section aria-labelledby="saved-accounts-heading" className="mt-10">
            <h2
              id="saved-accounts-heading"
              className="mb-2 px-1 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-muted-foreground"
            >
              Saved accounts
            </h2>
            <ul className="divide-y divide-border rounded-xl border border-border bg-card">
              {credentials.map((cred) => (
                <li key={cred.id} className="flex items-center gap-2 py-2.5 pr-2 pl-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{cred.name}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">{cred.endpoint}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => handleQuickConnect(cred)}
                    >
                      <LogIn />
                      Connect
                    </Button>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => setDetailsCred(cred)}
                            className="text-muted-foreground"
                            aria-label="Credential details"
                          >
                            <Info />
                          </Button>
                        }
                      />
                      <TooltipContent>Details</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => handleRemove(cred.id)}
                            className="text-muted-foreground hover:text-destructive"
                            aria-label="Remove credential"
                          >
                            <Trash2 />
                          </Button>
                        }
                      />
                      <TooltipContent>Remove</TooltipContent>
                    </Tooltip>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  )
}

/** A bordered surface, the same in every state of the page. */
const CARD = "rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6"
const LABEL = "block text-sm font-medium"
const FIELD = "h-9"
const SUBMIT = "mt-2 h-10 w-full"
/** One segment of the connect / register switch: the selected one is a raised chip. */
const TAB =
  "h-8 rounded-md text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent aria-selected:bg-card aria-selected:text-foreground aria-selected:shadow-xs dark:aria-selected:bg-secondary"

function FormError({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive dark:border-destructive/40 dark:bg-destructive/10 dark:text-red-300"
    >
      {message}
    </p>
  )
}

/**
 * The "Continue with <swarm host>" link for the deep link in `?next=`, or null
 * while unknown. Showing the link stores the nonce it carries with the agent-fs
 * server it names, so a new tab opened from the link finds it too; `remember`
 * (on click, middle click and context menu) restarts its 10 minutes. The return
 * is accepted only with that nonce and server (see takeKeyHandoff).
 */
function useContinueWithSwarm(params: URLSearchParams): (ContinueLink & { remember: () => void }) | null {
  const next = params.get("next")
  const target = next && isAppReturnPath(next) ? next : null
  const orgId = target ? orgIdFromAppPath(target) : null
  const endpoint = normalizeEndpoint(params.get("apiUrl")) ?? normalizeEndpoint(getActiveCredential()?.endpoint)
  const [nonce] = useState(newHandoffNonce)

  const { data: swarmUrl } = useQuery({
    queryKey: ["org-swarm-url", endpoint, orgId],
    queryFn: () => AgentFsClient.getOrgSwarmUrl({ endpoint: endpoint!, orgId: orgId! }),
    enabled: !!endpoint && !!orgId,
    retry: false,
    staleTime: Infinity,
  })

  const endpointSaved = !!endpoint && getCredentials().some((c) => normalizeEndpoint(c.endpoint) === endpoint)
  const link =
    target && endpoint
      ? continueWithSwarmLink({ swarmUrl, target, origin: window.location.origin, nonce, endpoint, endpointSaved })
      : null

  const href = link?.href
  useEffect(() => {
    if (href && endpoint) rememberHandoffNonce(window, nonce, endpoint)
  }, [href, nonce, endpoint])

  return link && endpoint ? { ...link, remember: () => rememberHandoffNonce(window, nonce, endpoint) } : null
}
