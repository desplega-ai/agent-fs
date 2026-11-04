import { useState, type FormEvent } from "react"
import { KeyRound, Plus, Trash2 } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { useApiKeyMutations, useApiKeys } from "@/hooks/use-api-keys"
import { useDocumentTitle } from "@/hooks/use-document-title"
import { CopyLinkField } from "@/components/CopyLinkField"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toast } from "@/stores/toast"
import type { ApiError } from "@/api/client"
import type { ApiKeyInfo, CreatedApiKey } from "@/api/types"

const LABEL_MAX = 100

function errorMessage(err: unknown): string {
  const e = err as Partial<ApiError> | null
  if (e?.status === 403) return "This browser signs in with an org-limited key, which cannot manage keys. Sign in with your primary key."
  return e?.message || "Something went wrong"
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

/**
 * The signed-in account's API keys: list, create (the plaintext shows once)
 * and delete. The key this browser signs in with cannot be deleted here, so
 * the page never locks its own session out.
 */
export function ApiKeysPage() {
  useDocumentTitle("API keys")
  const keys = useApiKeys()
  const { create, revoke } = useApiKeyMutations()
  const [created, setCreated] = useState<CreatedApiKey | null>(null)
  const [deleting, setDeleting] = useState<ApiKeyInfo | null>(null)

  let body: React.ReactNode
  if (keys.isPending) {
    body = <div className="flex justify-center py-10"><Spinner /></div>
  } else if (keys.error) {
    body = <p role="alert" className="text-sm text-destructive">{errorMessage(keys.error)}</p>
  } else {
    body = (
      <ul aria-label="API keys" className="divide-y divide-border rounded-lg border border-border">
        {keys.data.keys.map((k) => (
          <KeyRow key={k.id} apiKey={k} busy={revoke.isPending} onDelete={() => setDeleting(k)} />
        ))}
      </ul>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-6">
        <header className="space-y-1">
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" />
            <h1 className="text-lg font-semibold">API keys</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Keys that sign in as you from the CLI, MCP clients and scripts. Each one works until you delete it.
          </p>
        </header>

        {created ? (
          <NewKeyPanel created={created} onDone={() => setCreated(null)} />
        ) : (
          <CreateKeyForm
            busy={create.isPending}
            onCreate={(label, done) =>
              create.mutate(label, {
                onSuccess: (res) => {
                  setCreated(res)
                  done(null)
                },
                onError: (err) => done(errorMessage(err)),
              })
            }
          />
        )}

        {body}
      </div>

      {deleting && (
        <DeleteKeyDialog
          apiKey={deleting}
          busy={revoke.isPending}
          error={revoke.error ? errorMessage(revoke.error) : null}
          onCancel={() => {
            setDeleting(null)
            revoke.reset()
          }}
          onConfirm={() =>
            revoke.mutate(deleting.id, {
              onSuccess: () => {
                toast.success(`Deleted key ${deleting.label}`)
                setDeleting(null)
              },
            })
          }
        />
      )}
    </div>
  )
}

function CreateKeyForm({
  busy,
  onCreate,
}: {
  busy: boolean
  onCreate: (label: string, done: (error: string | null) => void) => void
}) {
  const [label, setLabel] = useState("")
  const [error, setError] = useState<string | null>(null)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    // The server wants a label; an empty field gets a dated default.
    const value = label.trim() || `Key created ${new Date().toLocaleDateString(undefined, { dateStyle: "medium" })}`
    onCreate(value, (err) => {
      setError(err)
      if (!err) setLabel("")
    })
  }

  return (
    <form onSubmit={submit} aria-label="Create API key" className="space-y-2 rounded-lg border border-border p-3">
      <div className="text-sm font-medium">New key</div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          aria-label="Label"
          placeholder="Label (optional), e.g. laptop CLI"
          maxLength={LABEL_MAX}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          aria-invalid={error ? true : undefined}
          className="sm:flex-1"
        />
        <Button type="submit" disabled={busy}>
          {busy ? <Spinner size="sm" /> : <Plus />}
          Create key
        </Button>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </form>
  )
}

function NewKeyPanel({ created, onDone }: { created: CreatedApiKey; onDone: () => void }) {
  return (
    <section
      role="status"
      aria-label="New API key"
      className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3"
    >
      <div className="text-sm font-medium">
        Key <span className="font-semibold">{created.label}</span> created
      </div>
      <CopyLinkField link={created.apiKey} label="New API key" />
      <p className="text-xs text-muted-foreground">
        Copy it now. You won't see this key again; if you lose it, delete it and create another.
      </p>
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={onDone}>Done</Button>
      </div>
    </section>
  )
}

function KeyRow({ apiKey: k, busy, onDelete }: { apiKey: ApiKeyInfo; busy: boolean; onDelete: () => void }) {
  const { orgs, user } = useAuth()
  const orgName = k.orgId ? (orgs.find((o) => o.id === k.orgId)?.name ?? k.orgId.slice(0, 8)) : null
  const byAdmin = !!user && k.createdByUserId !== user.userId

  const meta: string[] = []
  meta.push(k.createdAt ? `Created ${formatWhen(k.createdAt)}` : "Created at sign-up or last reset")
  if (!k.primary) meta.push(k.lastUsedAt ? `Last used ${formatWhen(k.lastUsedAt)}` : "Never used")
  if (byAdmin) meta.push("Created by an org admin")

  return (
    <li data-key-id={k.id} className="space-y-1 px-3 py-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">{k.label}</span>
            {k.primary && <Badge variant="secondary">Primary</Badge>}
            {k.current && <Badge variant="outline">This browser</Badge>}
            {orgName && <Badge variant="outline">Only {orgName}</Badge>}
          </div>
          <div className="truncate text-xs text-muted-foreground">{meta.join(" · ")}</div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete key ${k.label}`}
          disabled={k.current || busy}
          title={k.current ? "This browser signs in with this key. Sign in with another key to delete it." : undefined}
          onClick={onDelete}
        >
          <Trash2 />
        </Button>
      </div>
      {k.current && (
        <p className="text-xs text-muted-foreground">
          This browser signs in with this key, so it can't be deleted here. Sign in with another key first.
        </p>
      )}
    </li>
  )
}

function DeleteKeyDialog({
  apiKey,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  apiKey: ApiKeyInfo
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete API key</DialogTitle>
          <DialogDescription>
            Delete <span className="font-medium text-foreground">{apiKey.label}</span>? Anything using it stops
            working at once. This can't be undone.
            {apiKey.primary && " Deleting the primary key leaves you with your other keys; reset-key mints a new primary."}
          </DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={onConfirm} disabled={busy}>
            {busy ? "Deleting..." : "Delete key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
