import { useState, type FormEvent } from "react"
import { useParams } from "react-router"
import { useQueryClient } from "@tanstack/react-query"
import { HardDrive, KeyRound, Plus, RotateCw, Send, Trash2, Webhook as WebhookIcon } from "lucide-react"
import { useAuth } from "@/contexts/auth"
import { useIsOrgAdmin, useManageableDrives } from "@/hooks/use-org-members"
import {
  createWebhook,
  rotateWebhookSecret,
  useRedeliver,
  useWebhookDeliveries,
  useWebhookMutations,
  useWebhooks,
  useWebhookTest,
} from "@/hooks/use-webhooks"
import { useDocumentTitle } from "@/hooks/use-document-title"
import { CopyLinkField } from "@/components/CopyLinkField"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toast } from "@/stores/toast"
import { cn } from "@/lib/utils"
import { selectClass } from "@/lib/member-roles"
import { WEBHOOK_EVENT_TYPES, deliveryOutcome, disabledLabel } from "@/lib/webhooks"
import type { ApiError } from "@/api/client"
import type { Webhook, WebhookDeliveryStatus, WebhookEventType } from "@/api/types"

function errorMessage(err: unknown): string {
  const e = err as Partial<ApiError> | null
  return e?.message || "Something went wrong"
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

const eventLabel = (type: string) => WEBHOOK_EVENT_TYPES.find((e) => e.value === type)?.label ?? type

/**
 * Outbound webhooks of one drive: list, create, test, enable/disable, rotate
 * the signing secret, delete, and each hook's delivery log. Only drive admins
 * and org admins get past the gate; org hooks come back from the server only
 * for org admins. The server enforces both, so the gate here only spares
 * everyone else a request that would 403.
 *
 * A signing secret exists only in the create and rotate responses. It lives
 * in the state of the dialog that shows it and goes away when that closes.
 */
export function WebhooksPage() {
  const params = useParams()
  const orgId = params.orgId ?? null
  const driveId = params.driveId ?? null
  const { drives } = useAuth()
  const manageable = useManageableDrives(orgId)
  const isOrgAdmin = useIsOrgAdmin()
  // Unknown while the drive list loads. If that list fails, ask the webhook
  // endpoint and let its 403 decide.
  const canManage: boolean | undefined = manageable.data
    ? manageable.data.drives.some((d) => d.id === driveId)
    : manageable.isError
      ? true
      : undefined
  const list = useWebhooks(orgId, driveId, canManage === true)
  const [creating, setCreating] = useState(false)

  const driveName =
    manageable.data?.drives.find((d) => d.id === driveId)?.name ??
    drives.find((d) => d.id === driveId)?.name ??
    driveId?.slice(0, 8) ??
    ""
  useDocumentTitle(driveName ? `Webhooks · ${driveName}` : "Webhooks")

  const forbidden = canManage === false || (list.error as Partial<ApiError> | null)?.status === 403

  let body: React.ReactNode
  if (!orgId || !driveId) {
    body = null
  } else if (forbidden) {
    // Checked before cached data, so a role lost mid-session hides the list.
    body = (
      <p data-webhooks-forbidden className="rounded-lg border border-border px-3 py-4 text-sm text-muted-foreground">
        Only drive admins and org admins manage this drive's webhooks.
      </p>
    )
  } else if (canManage === undefined || list.isPending) {
    body = <div className="flex justify-center py-10"><Spinner /></div>
  } else if (list.data) {
    body = (
      <WebhookList
        key={`${orgId}/${driveId}`}
        orgId={orgId}
        driveId={driveId}
        hooks={list.data.webhooks}
      />
    )
  } else {
    body = <p role="alert" className="text-sm text-destructive">{errorMessage(list.error)}</p>
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-6">
        <header className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <WebhookIcon className="size-4 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Webhooks</h1>
            <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
              <HardDrive className="size-3.5 shrink-0" />
              <span className="max-w-60 truncate">{driveName}</span>
            </span>
            {list.data && !forbidden && (
              <Button size="sm" className="ml-auto" onClick={() => setCreating(true)}>
                <Plus />
                New webhook
              </Button>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Signed POSTs to your endpoints when comments are created, mentioned, edited, resolved, reopened or deleted.
          </p>
        </header>
        {body}
      </div>
      {creating && orgId && driveId && (
        <CreateWebhookDialog orgId={orgId} driveId={driveId} isOrgAdmin={isOrgAdmin} onClose={() => setCreating(false)} />
      )}
    </div>
  )
}

function WebhookList({ orgId, driveId, hooks }: { orgId: string; driveId: string; hooks: Webhook[] }) {
  const [rotating, setRotating] = useState<Webhook | null>(null)
  const [deleting, setDeleting] = useState<Webhook | null>(null)
  const workerOff = hooks.some((h) => !h.workerEnabled)

  return (
    <div className="space-y-3">
      {workerOff && (
        <p role="status" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          This server does not deliver events yet (AGENT_FS_WEBHOOK_WORKER is off). Test still sends a ping.
        </p>
      )}
      {hooks.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          No webhooks yet.
        </p>
      ) : (
        <ul aria-label="Webhooks" className="divide-y divide-border rounded-lg border border-border">
          {hooks.map((h) => (
            <WebhookRow
              key={h.id}
              orgId={orgId}
              driveId={driveId}
              hook={h}
              onRotate={() => setRotating(h)}
              onDelete={() => setDeleting(h)}
            />
          ))}
        </ul>
      )}
      {rotating && (
        <RotateSecretDialog orgId={orgId} driveId={driveId} hook={rotating} onClose={() => setRotating(null)} />
      )}
      {deleting && (
        <DeleteWebhookDialog orgId={orgId} driveId={driveId} hook={deleting} onClose={() => setDeleting(null)} />
      )}
    </div>
  )
}

function WebhookRow({
  orgId,
  driveId,
  hook,
  onRotate,
  onDelete,
}: {
  orgId: string
  driveId: string
  hook: Webhook
  onRotate: () => void
  onDelete: () => void
}) {
  const { setEnabled } = useWebhookMutations(orgId, driveId)
  const test = useWebhookTest(orgId, driveId)
  const [showLog, setShowLog] = useState(false)
  const off = disabledLabel(hook)

  const meta: string[] = []
  if (hook.lastSuccessAt) meta.push(`Last delivered ${formatWhen(hook.lastSuccessAt)}`)
  if (hook.lastFailureAt) meta.push(`Last failed ${formatWhen(hook.lastFailureAt)}`)
  if (hook.consecutiveFailures > 0) meta.push(`${hook.consecutiveFailures} failed in a row`)
  if (meta.length === 0) meta.push(`Created ${formatWhen(hook.createdAt)}`)

  return (
    <li data-webhook-url={hook.url} className="space-y-2 px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-mono text-sm" title={hook.url}>{hook.url}</span>
            {hook.scope === "org" && <Badge variant="outline">Every drive in the org</Badge>}
            {off && <Badge variant="destructive">{off}</Badge>}
          </div>
          {hook.description && <div className="truncate text-sm">{hook.description}</div>}
          <div className="text-xs text-muted-foreground">{hook.eventTypes.map(eventLabel).join(", ")}</div>
          <div className="text-xs text-muted-foreground">{meta.join(" · ")}</div>
        </div>
        <label className="flex shrink-0 items-center gap-1.5 pt-0.5 text-xs text-muted-foreground">
          <Switch
            size="sm"
            aria-label={`Enabled: ${hook.url}`}
            checked={hook.enabled}
            disabled={setEnabled.isPending}
            onCheckedChange={(enabled) =>
              setEnabled.mutate(
                { id: hook.id, enabled },
                { onSuccess: () => toast.success(enabled ? "Webhook enabled" : "Webhook disabled") },
              )
            }
          />
          {hook.enabled ? "On" : "Off"}
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="xs" variant="outline" disabled={test.isPending} onClick={() => test.mutate(hook.id)}>
          {test.isPending ? <Spinner size="sm" /> : <Send />}
          Test
        </Button>
        <Button size="xs" variant="outline" aria-expanded={showLog} onClick={() => setShowLog((v) => !v)}>
          Deliveries
        </Button>
        <Button size="xs" variant="ghost" onClick={onRotate}>
          <KeyRound />
          Rotate secret
        </Button>
        <Button size="xs" variant="ghost" className="ml-auto text-destructive" aria-label={`Delete ${hook.url}`} onClick={onDelete}>
          <Trash2 />
          Delete
        </Button>
      </div>
      {test.data && (
        <p
          data-webhook-test-result
          role="status"
          className={cn("text-xs", test.data.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}
        >
          {test.data.ok ? "Ping delivered" : "Ping failed"}
          {test.data.statusCode != null && `: HTTP ${test.data.statusCode}`}
          {test.data.error && ` · ${test.data.error}`}
          {` · ${test.data.durationMs} ms`}
        </p>
      )}
      {test.error && <p role="alert" className="text-xs text-destructive">{errorMessage(test.error)}</p>}
      {setEnabled.error && <p role="alert" className="text-xs text-destructive">{errorMessage(setEnabled.error)}</p>}
      {showLog && <DeliveryLog orgId={orgId} driveId={driveId} hook={hook} />}
    </li>
  )
}

const STATUS_FILTERS: { value: WebhookDeliveryStatus | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "delivered", label: "Delivered" },
  { value: "failed", label: "Failed" },
]

function DeliveryLog({ orgId, driveId, hook }: { orgId: string; driveId: string; hook: Webhook }) {
  const [status, setStatus] = useState<WebhookDeliveryStatus | "">("")
  const log = useWebhookDeliveries(orgId, driveId, hook.id, status || null)
  const redeliver = useRedeliver(orgId, driveId, hook.id)
  const rows = log.data?.pages.flatMap((p) => p.deliveries) ?? []

  return (
    <section aria-label={`Deliveries of ${hook.url}`} className="space-y-2 rounded-md border border-border bg-muted/20 p-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">Delivery log</span>
        <select
          aria-label="Delivery status"
          className={cn(selectClass, "ml-auto h-7 text-xs")}
          value={status}
          onChange={(e) => setStatus(e.target.value as WebhookDeliveryStatus | "")}
        >
          {STATUS_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
      </div>
      {!hook.enabled && (
        <p className="text-xs text-muted-foreground">Turn the webhook on to redeliver.</p>
      )}
      {log.isPending ? (
        <div className="flex justify-center py-3"><Spinner size="sm" /></div>
      ) : log.error ? (
        <p role="alert" className="text-xs text-destructive">{errorMessage(log.error)}</p>
      ) : rows.length === 0 ? (
        <p className="py-2 text-center text-xs text-muted-foreground">No deliveries{status ? ` with status ${status}` : ""}. Deliveries older than 30 days are pruned.</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((d) => (
            <li key={d.id} data-delivery-id={d.id} className="flex items-center gap-2 py-1.5 text-xs">
              <Badge variant={d.status === "failed" ? "destructive" : d.status === "delivered" ? "secondary" : "outline"}>
                {d.status}
              </Badge>
              <div className="min-w-0 flex-1">
                <div className="truncate">
                  <span className="font-medium">{eventLabel(d.eventType)}</span>
                  <span className="text-muted-foreground"> · {deliveryOutcome(d)}</span>
                </div>
                <div className="truncate text-muted-foreground">
                  {formatWhen(d.createdAt)} · {d.attempts} {d.attempts === 1 ? "attempt" : "attempts"}
                  {d.nextAttemptAt && ` · next ${formatWhen(d.nextAttemptAt)}`}
                </div>
              </div>
              <Button
                size="xs"
                variant="ghost"
                disabled={!hook.enabled || redeliver.isPending}
                title={hook.enabled ? undefined : "Turn the webhook on to redeliver"}
                onClick={() =>
                  redeliver.mutate(d.id, { onSuccess: () => toast.success("Delivery queued again") })
                }
              >
                <RotateCw />
                Redeliver
              </Button>
            </li>
          ))}
        </ul>
      )}
      {redeliver.error && <p role="alert" className="text-xs text-destructive">{errorMessage(redeliver.error)}</p>}
      {log.hasNextPage && (
        <Button size="xs" variant="ghost" className="w-full" disabled={log.isFetchingNextPage} onClick={() => log.fetchNextPage()}>
          {log.isFetchingNextPage ? <Spinner size="sm" /> : null}
          Load older
        </Button>
      )}
    </section>
  )
}

/** The secret, once, with copy. Rendered only from dialog state. */
function SecretPanel({ secret, rotated }: { secret: string; rotated?: boolean }) {
  return (
    <div className="space-y-2" data-webhook-secret-panel>
      <CopyLinkField link={secret} label="Signing secret" />
      <p className="text-xs text-muted-foreground">
        Copy it now and store it with your receiver. You won't see it again; if you lose it, rotate the secret.
        {rotated && " The old secret has already stopped working."}
      </p>
    </div>
  )
}

function CreateWebhookDialog({
  orgId,
  driveId,
  isOrgAdmin,
  onClose,
}: {
  orgId: string
  driveId: string
  isOrgAdmin: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const { client, credential } = useAuth()
  const [url, setUrl] = useState("")
  const [description, setDescription] = useState("")
  const [events, setEvents] = useState<WebhookEventType[]>(WEBHOOK_EVENT_TYPES.map((e) => e.value))
  const [scope, setScope] = useState<"drive" | "org">("drive")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The one place the secret lives. This component unmounts when the dialog closes.
  const [secret, setSecret] = useState<string | null>(null)

  const toggle = (value: WebhookEventType) =>
    setEvents((prev) => (prev.includes(value) ? prev.filter((e) => e !== value) : [...prev, value]))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!url.trim() || events.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const res = await createWebhook(queryClient, client, credential.id, orgId, driveId, {
        scope,
        url: url.trim(),
        eventTypes: events,
        ...(description.trim() ? { description: description.trim() } : {}),
      })
      setSecret(res.secret)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{secret ? "Webhook created" : "New webhook"}</DialogTitle>
          <DialogDescription>
            {secret
              ? "Verify each request's webhook-signature header with this signing secret."
              : "agent-fs POSTs a signed JSON event to this URL. It must be public https."}
          </DialogDescription>
        </DialogHeader>
        {secret ? (
          <>
            <SecretPanel secret={secret} />
            <DialogFooter>
              <Button size="sm" onClick={onClose}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} aria-label="New webhook" className="space-y-3">
            <Input
              type="url"
              aria-label="Endpoint URL"
              placeholder="https://example.com/agent-fs/webhook"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-invalid={error ? true : undefined}
            />
            <Input
              aria-label="Description"
              placeholder="Description (optional)"
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <fieldset className="space-y-1.5">
              <legend className="text-xs font-medium">Events</legend>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {WEBHOOK_EVENT_TYPES.map((ev) => (
                  <label key={ev.value} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 shrink-0 accent-primary"
                      checked={events.includes(ev.value)}
                      onChange={() => toggle(ev.value)}
                    />
                    {ev.label}
                  </label>
                ))}
              </div>
            </fieldset>
            {isOrgAdmin && (
              <label className="flex items-center gap-2 text-sm">
                <span className="text-xs font-medium">Covers</span>
                <select
                  aria-label="Scope"
                  className={selectClass}
                  value={scope}
                  onChange={(e) => setScope(e.target.value as "drive" | "org")}
                >
                  <option value="drive">This drive</option>
                  <option value="org">Every drive in the org</option>
                </select>
              </label>
            )}
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button type="submit" size="sm" disabled={busy || !url.trim() || events.length === 0}>
                {busy ? <Spinner size="sm" /> : null}
                Create webhook
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function RotateSecretDialog({
  orgId,
  driveId,
  hook,
  onClose,
}: {
  orgId: string
  driveId: string
  hook: Webhook
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const { client, credential } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The one place the new secret lives. This component unmounts when the dialog closes.
  const [secret, setSecret] = useState<string | null>(null)

  const rotate = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await rotateWebhookSecret(queryClient, client, credential.id, orgId, driveId, hook.id)
      setSecret(res.secret)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{secret ? "New signing secret" : "Rotate signing secret"}</DialogTitle>
          <DialogDescription>
            {secret ? (
              <>Update <span className="font-mono text-foreground">{hook.url}</span> to verify with this secret.</>
            ) : (
              <>
                The current secret of <span className="font-mono text-foreground">{hook.url}</span> stops working at
                once. Requests signed with it fail verification until the receiver has the new one.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {secret && <SecretPanel secret={secret} rotated />}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          {secret ? (
            <Button size="sm" onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button type="button" variant="destructive" size="sm" onClick={rotate} disabled={busy}>
                {busy ? "Rotating..." : "Rotate secret"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeleteWebhookDialog({
  orgId,
  driveId,
  hook,
  onClose,
}: {
  orgId: string
  driveId: string
  hook: Webhook
  onClose: () => void
}) {
  const { remove } = useWebhookMutations(orgId, driveId)
  return (
    <Dialog open onOpenChange={(open) => !open && !remove.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete webhook</DialogTitle>
          <DialogDescription>
            Delete <span className="font-mono text-foreground">{hook.url}</span> and its delivery history? Pending
            deliveries are dropped. This can't be undone.
          </DialogDescription>
        </DialogHeader>
        {remove.error && <p role="alert" className="text-xs text-destructive">{errorMessage(remove.error)}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={remove.isPending}>Cancel</Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(hook.id, {
                onSuccess: () => {
                  toast.success("Webhook deleted")
                  onClose()
                },
              })
            }
          >
            {remove.isPending ? "Deleting..." : "Delete webhook"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
