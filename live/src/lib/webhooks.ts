import type { Webhook, WebhookDelivery, WebhookEventType, WebhookWithSecret } from "@/api/types"

/** Every event type a webhook can subscribe to, in the order the form lists them. */
export const WEBHOOK_EVENT_TYPES: { value: WebhookEventType; label: string }[] = [
  { value: "comment.created", label: "Comment created" },
  { value: "comment.mentioned", label: "Someone mentioned" },
  { value: "comment.updated", label: "Comment edited" },
  { value: "comment.resolved", label: "Thread resolved" },
  { value: "comment.reopened", label: "Thread reopened" },
  { value: "comment.deleted", label: "Comment deleted" },
]

/**
 * Split a create or rotate response into the webhook (safe to cache and
 * render) and its signing secret (hold it in dialog state only, and drop it
 * when the dialog closes).
 */
export function splitSecret(res: WebhookWithSecret): { webhook: Webhook; secret: string } {
  const { secret, ...webhook } = res
  return { webhook, secret }
}

/** One short line on why a webhook is off, or null while it is on. */
export function disabledLabel(hook: Pick<Webhook, "enabled" | "disabledReason">): string | null {
  if (hook.enabled) return null
  switch (hook.disabledReason) {
    case "gone":
      return "Disabled: the receiver answered 410 Gone"
    case "failing":
      return "Disabled after repeated failures"
    default:
      return "Disabled"
  }
}

/** The outcome column of a delivery row: status code, error, or what is next. */
export function deliveryOutcome(d: Pick<WebhookDelivery, "status" | "lastStatusCode" | "lastError" | "attempts">): string {
  const parts: string[] = []
  if (d.lastStatusCode != null) parts.push(`HTTP ${d.lastStatusCode}`)
  if (d.lastError) parts.push(d.lastError)
  if (parts.length === 0) parts.push(d.status === "pending" ? (d.attempts === 0 ? "Not sent yet" : "Retrying") : "No response")
  return parts.join(" · ")
}
