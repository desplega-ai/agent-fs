import { useState } from "react"
import { useNavigate } from "react-router"
import { Eye, EyeOff, Trash2, LogIn, Plus } from "lucide-react"
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

export function CredentialsPage() {
  const navigate = useNavigate()
  const [endpoint, setEndpoint] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [name, setName] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [credentials, setCredentials] = useState(getCredentials)

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
      navigate("/files", { replace: true })
    } catch (err) {
      setError((err as Error).message || "Connection failed")
    } finally {
      setConnecting(false)
    }
  }

  const handleQuickConnect = (cred: Credential) => {
    setActiveCredential(cred.id)
    navigate("/files", { replace: true })
  }

  const handleRemove = (id: string) => {
    removeCredential(id)
    setCredentials(getCredentials())
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Connect to agent-fs</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Enter your API endpoint and key to get started.
          </p>
        </div>

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

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

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
