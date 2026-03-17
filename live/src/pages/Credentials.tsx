import { useState } from "react"
import { useNavigate } from "react-router"
import { Eye, EyeOff, Trash2, LogIn, Plus } from "lucide-react"
import { AgentFsClient } from "@/api/client"
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
          <h1 className="text-2xl font-bold">Connect to agent-fs</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Enter your API endpoint and key to get started.
          </p>
        </div>

        <form onSubmit={handleConnect} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="endpoint">
              Endpoint URL
            </label>
            <input
              id="endpoint"
              type="url"
              required
              placeholder="https://your-instance.fly.dev"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="apiKey">
              API Key
            </label>
            <div className="relative">
              <input
                id="apiKey"
                type={showKey ? "text" : "password"}
                required
                placeholder="sk-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="name">
              Name <span className="text-muted-foreground">(optional)</span>
            </label>
            <input
              id="name"
              type="text"
              placeholder="My instance"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <button
            type="submit"
            disabled={connecting}
            className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            <Plus className="h-4 w-4" />
            {connecting ? "Connecting..." : "Connect"}
          </button>
        </form>

        {credentials.length > 0 && (
          <div>
            <h2 className="text-sm font-medium text-muted-foreground mb-3">Saved accounts</h2>
            <div className="space-y-2">
              {credentials.map((cred) => (
                <div
                  key={cred.id}
                  className="flex items-center justify-between rounded-md border border-border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{cred.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{cred.endpoint}</p>
                  </div>
                  <div className="flex items-center gap-1 ml-2">
                    <button
                      onClick={() => handleQuickConnect(cred)}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium hover:bg-accent transition-colors"
                    >
                      <LogIn className="h-3 w-3" />
                      Connect
                    </button>
                    <button
                      onClick={() => handleRemove(cred.id)}
                      className="inline-flex items-center rounded-md p-1 text-muted-foreground hover:text-destructive hover:bg-accent transition-colors"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
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
