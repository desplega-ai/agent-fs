import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Copy,
  Eye,
  EyeOff,
  Check,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
} from "lucide-react"
import { AgentFsClient } from "@/api/client"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { saveCredential, type Credential } from "@/stores/credentials"
import { maskApiKey } from "@/lib/mask-key"
import type { MeResponse } from "@/api/types"

interface CredentialDetailsDialogProps {
  credential: Credential | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onCredentialUpdated: () => void
}

interface ServerDetails {
  me: MeResponse
  orgCount: number
  driveCount: number | null
}

export function CredentialDetailsDialog({
  credential,
  open,
  onOpenChange,
  onCredentialUpdated,
}: CredentialDetailsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {credential ? (
          <DetailsBody
            credential={credential}
            onCredentialUpdated={onCredentialUpdated}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function DetailsBody({
  credential,
  onCredentialUpdated,
}: {
  credential: Credential
  onCredentialUpdated: () => void
}) {
  const queryClient = useQueryClient()
  const [showKey, setShowKey] = useState(false)
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle")
  const [copyHint, setCopyHint] = useState<string | null>(null)
  const [replaceOpen, setReplaceOpen] = useState(false)

  const detailsQuery = useQuery<ServerDetails>({
    queryKey: ["credential-details", credential.id],
    queryFn: async () => {
      const client = new AgentFsClient({
        endpoint: credential.endpoint,
        apiKey: credential.apiKey,
      })
      const me = await client.getMe()
      const orgsRes = await client.getOrgs()
      let driveCount: number | null = null
      if (me.defaultOrgId) {
        const drivesRes = await client.getDrives(me.defaultOrgId)
        driveCount = drivesRes.drives.length
      }
      return {
        me,
        orgCount: orgsRes.orgs.length,
        driveCount,
      }
    },
    retry: false,
  })

  const handleCopy = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API not available")
      }
      await navigator.clipboard.writeText(credential.apiKey)
      setCopyState("copied")
      setCopyHint(null)
      setTimeout(() => setCopyState("idle"), 1500)
    } catch {
      setCopyState("error")
      setCopyHint("Copy unavailable on insecure origin")
      setTimeout(() => {
        setCopyState("idle")
        setCopyHint(null)
      }, 3000)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Credential details</DialogTitle>
        <DialogDescription>
          Local fields, server-side identity, and key management for this
          credential.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-5 max-h-[70vh] overflow-y-auto">
        {/* Local section */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">
            Local
          </h3>
          <DetailRow label="Name" value={credential.name} />
          <DetailRow label="Endpoint" value={credential.endpoint} mono />
          <div>
            <p className="text-xs text-muted-foreground mb-1">API key</p>
            <div className="flex items-center gap-1.5">
              <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                {showKey ? credential.apiKey : maskApiKey(credential.apiKey)}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? "Hide API key" : "Show API key"}
                className="text-muted-foreground"
              >
                {showKey ? <EyeOff /> : <Eye />}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={handleCopy}
                aria-label="Copy API key"
                className="text-muted-foreground"
              >
                {copyState === "copied" ? <Check /> : <Copy />}
              </Button>
            </div>
            {copyHint && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {copyHint}
              </p>
            )}
          </div>
          <DetailRow label="ID" value={credential.id} mono />
        </section>

        {/* Server section */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">
            Server
          </h3>
          {detailsQuery.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Spinner size="sm" />
              <span>Loading server details...</span>
            </div>
          ) : detailsQuery.isError ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-sm text-destructive">
              <AlertTriangle className="size-4 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="font-medium">Server unreachable</p>
                <p className="text-xs opacity-80 break-words">
                  {(detailsQuery.error as Error)?.message ||
                    "Could not contact the endpoint."}
                </p>
              </div>
            </div>
          ) : detailsQuery.data ? (
            <>
              <DetailRow label="Email" value={detailsQuery.data.me.email} />
              <DetailRow
                label="User ID"
                value={detailsQuery.data.me.userId}
                mono
              />
              <DetailRow
                label="Default org"
                value={detailsQuery.data.me.defaultOrgId ?? "—"}
                mono
              />
              <DetailRow
                label="Default drive"
                value={detailsQuery.data.me.defaultDriveId ?? "—"}
                mono
              />
              <DetailRow
                label="Orgs"
                value={String(detailsQuery.data.orgCount)}
              />
              <DetailRow
                label="Drives in default org"
                value={
                  detailsQuery.data.driveCount === null
                    ? "—"
                    : String(detailsQuery.data.driveCount)
                }
              />
            </>
          ) : null}
        </section>

        {/* Replace key section */}
        <section className="space-y-2">
          <button
            type="button"
            onClick={() => setReplaceOpen((v) => !v)}
            className="flex items-center gap-1 text-xs font-semibold uppercase text-muted-foreground tracking-wide hover:text-foreground"
          >
            {replaceOpen ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
            Replace key
          </button>
          {replaceOpen && (
            <ReplaceKeyForm
              credential={credential}
              currentEmail={detailsQuery.data?.me.email ?? null}
              onReplaced={() => {
                queryClient.invalidateQueries({
                  queryKey: ["credential-details", credential.id],
                })
                onCredentialUpdated()
                setReplaceOpen(false)
              }}
            />
          )}
        </section>
      </div>
    </>
  )
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={
          mono
            ? "font-mono text-xs break-all"
            : "text-sm break-words"
        }
      >
        {value}
      </p>
    </div>
  )
}

interface ReplaceKeyFormProps {
  credential: Credential
  currentEmail: string | null
  onReplaced: () => void
}

function ReplaceKeyForm({
  credential,
  currentEmail,
  onReplaced,
}: ReplaceKeyFormProps) {
  const [newKey, setNewKey] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingConfirm, setPendingConfirm] = useState<{
    newEmail: string
  } | null>(null)

  const persist = (apiKey: string) => {
    saveCredential({ ...credential, apiKey })
    onReplaced()
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!newKey.trim()) {
      setError("Enter a key to save.")
      return
    }

    setSaving(true)
    try {
      const client = new AgentFsClient({
        endpoint: credential.endpoint,
        apiKey: newKey.trim(),
      })
      const me = await client.getMe()

      // Cross-user safety: if the new key belongs to a different account, confirm.
      if (currentEmail && me.email && me.email !== currentEmail) {
        setPendingConfirm({ newEmail: me.email })
        return
      }

      persist(newKey.trim())
    } catch (err) {
      const e = err as Error
      setError(e.message || "Could not validate the key.")
    } finally {
      setSaving(false)
    }
  }

  if (pendingConfirm) {
    return (
      <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="size-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-sm">
            This key belongs to a different account (
            <code className="font-mono text-xs">{pendingConfirm.newEmail}</code>
            ). Replace anyway?
          </p>
        </div>
        <div className="flex gap-2 justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setPendingConfirm(null)
              setNewKey("")
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => persist(newKey.trim())}
          >
            Replace anyway
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={handleSave} className="space-y-2">
      <div className="relative">
        <Input
          type={showKey ? "text" : "password"}
          placeholder="af_..."
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          className="pr-10 font-mono text-xs"
          aria-label="New API key"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => setShowKey((v) => !v)}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          aria-label={showKey ? "Hide new key" : "Show new key"}
        >
          {showKey ? <EyeOff /> : <Eye />}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Validating..." : "Save"}
        </Button>
      </div>
    </form>
  )
}
