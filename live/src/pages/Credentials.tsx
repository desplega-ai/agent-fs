import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router"
import { Eye, EyeOff, Trash2, LogIn, Plus, UserPlus, Info } from "lucide-react"
import { AgentFsClient } from "@/api/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  getCredentials,
  saveCredential,
  removeCredential,
  setActiveCredential,
  type Credential,
} from "@/stores/credentials"
import { CredentialDetailsDialog } from "@/components/credentials/CredentialDetailsDialog"
import { toast } from "@/stores/toast"
import { useDocumentTitle } from "@/hooks/use-document-title"

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
    const orgId = initialParams.get("orgId")
    const driveId = initialParams.get("driveId")
    if (orgId && driveId) return `/file/~/${orgId}/${driveId}/`
    if (orgId) return `/orgs/${orgId}/files/`
    return "/files"
  }, [initialParams])

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
          "Account exists — switch to Connect and paste your key, or use a different email.",
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

  const heading =
    mode === "register" ? "Create your agent-fs account" : "Connect to agent-fs"
  const subheading =
    mode === "register"
      ? "Enter your endpoint and email to get a new API key."
      : "Enter your API endpoint and key to get started."

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{heading}</h1>
          <p className="text-sm text-muted-foreground mt-1">{subheading}</p>
        </div>

        <div
          role="tablist"
          aria-label="Authentication mode"
          className="inline-flex w-full rounded-md border border-border bg-background p-0.5"
        >
          <Button
            type="button"
            role="tab"
            aria-selected={mode === "connect"}
            variant={mode === "connect" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => switchMode("connect")}
            className="flex-1"
          >
            Connect existing key
          </Button>
          <Button
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            variant={mode === "register" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => switchMode("register")}
            className="flex-1"
          >
            Register new account
          </Button>
        </div>

        {mode === "connect" ? (
          <form onSubmit={handleConnect} className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium" htmlFor="endpoint">
                Endpoint URL
              </label>
              <Input
                id="endpoint"
                type="url"
                required
                placeholder="https://your-instance.fly.dev"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-sm font-medium" htmlFor="apiKey">
                API Key
              </label>
              <div className="relative">
                <Input
                  id="apiKey"
                  type={showKey ? "text" : "password"}
                  required
                  placeholder="sk-..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="pr-10"
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
              <label className="block text-sm font-medium" htmlFor="name">
                Name <span className="text-muted-foreground">(optional)</span>
              </label>
              <Input
                id="name"
                type="text"
                placeholder="My instance"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button
              type="submit"
              disabled={connecting}
              className="w-full"
              size="lg"
            >
              <Plus />
              {connecting ? "Connecting..." : "Connect"}
            </Button>
          </form>
        ) : (
          <form onSubmit={handleRegister} className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium" htmlFor="endpoint">
                Endpoint URL
              </label>
              <Input
                id="endpoint"
                type="url"
                required
                placeholder="https://your-instance.fly.dev"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-sm font-medium" htmlFor="email">
                Email
              </label>
              <Input
                id="email"
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-sm font-medium" htmlFor="name">
                Name <span className="text-muted-foreground">(optional)</span>
              </label>
              <Input
                id="name"
                type="text"
                placeholder="My instance"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button
              type="submit"
              disabled={connecting}
              className="w-full"
              size="lg"
            >
              <UserPlus />
              {connecting ? "Registering..." : "Register"}
            </Button>
          </form>
        )}

        <CredentialDetailsDialog
          credential={detailsCred}
          open={!!detailsCred}
          onOpenChange={(o) => !o && setDetailsCred(null)}
          onCredentialUpdated={() => setCredentials(getCredentials())}
        />

        {credentials.length > 0 && (
          <div>
            <h2 className="text-sm font-medium text-muted-foreground mb-3">Saved accounts</h2>
            <div className="space-y-2">
              {credentials.map((cred) => (
                <div
                  key={cred.id}
                  className="flex items-center justify-between rounded-lg border border-border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{cred.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{cred.endpoint}</p>
                  </div>
                  <div className="flex items-center gap-1 ml-2">
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
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
