// Outbound webhook event types and delivery constants.

/** The event types a subscription may list. `ping` (webhook-test only) is not one. */
export const WEBHOOK_EVENT_TYPES = [
  "comment.created",
  "comment.mentioned",
  "comment.updated",
  "comment.resolved",
  "comment.reopened",
  "comment.deleted",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/**
 * Internal `events.type` to webhook type. Internal types missing here
 * (e.g. `comment_notification`) never produce a webhook.
 */
export const INTERNAL_TO_WEBHOOK: Readonly<Record<string, WebhookEventType>> = {
  comment_created: "comment.created",
  comment_mention: "comment.mentioned",
  comment_updated: "comment.updated",
  comment_resolved: "comment.resolved",
  comment_reopened: "comment.reopened",
  comment_deleted: "comment.deleted",
};

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Delay before each retry, in ms: 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h.
 * The first attempt plus 7 retries makes 8 attempts in total. The worker
 * applies ±20% jitter to each delay.
 */
export const RETRY_SCHEDULE_MS: readonly number[] = [
  5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000,
];

/** A subscription failing continuously for this long is disabled ("failing"). */
export const AUTO_DISABLE_AFTER_MS = 5 * 86_400_000;
/** Per-request timeout for one delivery attempt. */
export const SEND_TIMEOUT_MS = 15_000;
/** How long a claimed delivery stays leased before another tick may re-claim it. */
export const LEASE_MS = 60_000;
/** `comment.body` in the payload is cut to this many characters. */
export const BODY_MAX_CHARS = 8_000;
/** Webhook subscriptions per org, drive and org scope combined. */
export const MAX_SUBSCRIPTIONS_PER_ORG = 25;
/** Delivered and failed rows older than this are pruned; pending rows never are. */
export const DELIVERY_RETENTION_MS = 30 * 86_400_000;
/** How often the worker prunes the delivery log. */
export const PRUNE_INTERVAL_MS = 3_600_000;

/**
 * The retry schedule in effect. `AGENT_FS_WEBHOOK_RETRY_SCHEDULE_MS` (a comma
 * separated list of ms, testing only) overrides the constant; an empty or
 * malformed value falls back to it. Read per call so tests can set the env.
 */
export function retryScheduleMs(env: NodeJS.ProcessEnv = process.env): readonly number[] {
  const raw = env.AGENT_FS_WEBHOOK_RETRY_SCHEDULE_MS?.trim();
  if (!raw) return RETRY_SCHEDULE_MS;
  const parts = raw.split(",").map((p) => p.trim());
  const parsed = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (parsed.length === 0 || parsed.some((n) => !Number.isSafeInteger(n))) {
    return RETRY_SCHEDULE_MS;
  }
  return parsed;
}
