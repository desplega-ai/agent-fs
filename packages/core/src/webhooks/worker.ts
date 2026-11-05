// Outbound webhook delivery worker: claims due rows from the
// webhook_deliveries outbox, sends them, and records the result.
//
// Tick loop adapted from desplega-ai/agent-swarm
// src/integrations/chat-sdk/relay.ts @ 2858e0940 (the `processing` guard, the
// debounced early tick, and a stop that aborts and awaits the in-flight tick).
// The event-bus wiring is replaced by the outbox's onWebhooksEnqueued callback.
// Retry jitter adapted from desplega-ai/agent-swarm
// src/workflows/retry-poller.ts @ 2858e0940 (calculateDelay), as ±20% on a
// fixed schedule instead of full jitter on an exponential one.
//
// Delivery is at least once. A claim sets a lease and counts the attempt
// before the send, so a process that dies mid-send leaves a row whose lease
// expires and is then sent again with the same webhook-id (the events.id).

import type { Database } from "bun:sqlite";
import type { DB } from "../db/index.js";
import { getWebhookSecretKey } from "./crypto/key.js";
import { decryptSecret } from "./crypto/secrets-cipher.js";
import { webhookEgressConfig, webhookFetch } from "./egress.js";
import { AUTO_DISABLE_AFTER_MS, LEASE_MS, retryScheduleMs } from "./events.js";
import { onWebhooksEnqueued } from "./outbox.js";
import { sendWebhook, type SendWebhookResult } from "./sender.js";
import { disableSubscription } from "./subscriptions.js";

export const WEBHOOK_POLL_MS_ENV = "AGENT_FS_WEBHOOK_POLL_MS";
export const WEBHOOK_AUTO_DISABLE_MS_ENV = "AGENT_FS_WEBHOOK_AUTO_DISABLE_MS";
export const DEFAULT_WEBHOOK_POLL_MS = 2_000;
export const DEFAULT_WEBHOOK_BATCH = 10;
/** Debounce between an enqueue and the early tick it triggers. */
export const EARLY_TICK_DEBOUNCE_MS = 100;

export interface WebhookTickOptions {
  /** Most deliveries claimed (and so sent concurrently) per tick. Default 10. */
  batch?: number;
  /** Defaults to the egress-guarded `webhookFetch()`. */
  fetchImpl?: typeof fetch;
  /** Clock in epoch ms. Defaults to `Date.now`. */
  now?: () => number;
  /** Source of jitter in [0, 1). Defaults to `Math.random`. */
  random?: () => number;
  /** Read for the retry schedule and the auto-disable window. */
  env?: NodeJS.ProcessEnv;
  /** Per-request timeout; defaults to the sender's 15 s. */
  timeoutMs?: number;
  /** Aborted on stop: no new send starts, and in-flight sends are cut. */
  signal?: AbortSignal;
}

export interface WebhookWorkerOptions extends WebhookTickOptions {
  /** Poll interval. Defaults to `AGENT_FS_WEBHOOK_POLL_MS`, else 2 s. */
  pollMs?: number;
}

export interface WebhookTickSummary {
  claimed: number;
  delivered: number;
  /** Failed attempts that will be retried. */
  retrying: number;
  /** Rows that ended `failed` (retries exhausted, 410, or disabled). */
  failed: number;
  /** Sends cut by stop; their lease is released, so the next process resends. */
  released: number;
}

/** A claimed delivery, as `UPDATE … RETURNING` hands it back. */
export interface ClaimedDelivery {
  id: string;
  subscriptionId: string;
  eventId: string;
  payload: string;
  /** Attempts so far, including this one. */
  attempts: number;
  /** The lease this claim set; recording a result requires it to still hold. */
  leaseUntil: number;
}

function rawOf(db: DB): Database {
  return (db as unknown as { $client: Database }).$client;
}

/** `round(d × U[0.8, 1.2))`: ±20% around one scheduled delay. */
export function webhookRetryJitter(delayMs: number, random: () => number = Math.random): number {
  return Math.round(delayMs * (0.8 + 0.4 * random()));
}

function autoDisableAfterMs(env: NodeJS.ProcessEnv): number {
  const raw = env[WEBHOOK_AUTO_DISABLE_MS_ENV]?.trim();
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return AUTO_DISABLE_AFTER_MS;
}

function pollMsFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env[WEBHOOK_POLL_MS_ENV]?.trim();
  if (raw && /^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  return DEFAULT_WEBHOOK_POLL_MS;
}

/**
 * Lease up to `batch` due deliveries of enabled subscriptions: a pending row
 * whose `next_attempt_at` has passed and whose lease is unset or expired. The
 * claim counts the attempt, so a crash mid-send still uses one up.
 */
export function claimDueDeliveries(db: DB, opts: { now: number; batch: number }): ClaimedDelivery[] {
  const leaseUntil = opts.now + LEASE_MS;
  const rows = rawOf(db)
    .query(
      `UPDATE webhook_deliveries
          SET lease_until = $lease, attempts = attempts + 1, last_attempt_at = $now
        WHERE id IN (
          SELECT d.id FROM webhook_deliveries d
            JOIN webhook_subscriptions s ON s.id = d.subscription_id
           WHERE d.status = 'pending' AND d.next_attempt_at <= $now
             AND (d.lease_until IS NULL OR d.lease_until < $now)
             AND s.enabled = 1
           ORDER BY d.next_attempt_at
           LIMIT $batch)
       RETURNING id, subscription_id, event_id, payload, attempts`
    )
    .all({ $lease: leaseUntil, $now: opts.now, $batch: opts.batch }) as Array<{
    id: string;
    subscription_id: string;
    event_id: string;
    payload: string;
    attempts: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    subscriptionId: r.subscription_id,
    eventId: r.event_id,
    payload: r.payload,
    attempts: r.attempts,
    leaseUntil,
  }));
}

/** Enabled subscriptions, for the "worker disabled" boot warning. */
export function countEnabledWebhookSubscriptions(db: DB): number {
  const row = rawOf(db)
    .query("SELECT COUNT(*) AS n FROM webhook_subscriptions WHERE enabled = 1")
    .get() as { n: number } | null;
  return row?.n ?? 0;
}

type Outcome = "delivered" | "retrying" | "failed" | "released";

/**
 * Record one attempt's result in one transaction. Every write is fenced on
 * the lease this tick set: if the row was re-claimed after the lease expired,
 * or failed by a disable meanwhile, this stale result changes nothing.
 */
function recordResult(
  db: DB,
  claim: ClaimedDelivery,
  result: SendWebhookResult,
  ctx: { now: number; schedule: readonly number[]; random: () => number; autoDisableMs: number; stopped: boolean }
): Outcome | null {
  const { now } = ctx;
  const fence = "WHERE id = $id AND status = 'pending' AND lease_until = $lease";
  const fenceParams = { $id: claim.id, $lease: claim.leaseUntil };
  const statusCode = result.statusCode ?? null;
  const error = result.error ?? null;

  return db.transaction((tx) => {
    const raw = rawOf(db);

    if (result.ok) {
      const changed = raw
        .query(
          `UPDATE webhook_deliveries
              SET status = 'delivered', delivered_at = $now, last_status_code = $code,
                  last_error = NULL, lease_until = NULL
            ${fence}`
        )
        .run({ ...fenceParams, $now: now, $code: statusCode }).changes;
      if (changed === 0) return null;
      raw
        .query(
          `UPDATE webhook_subscriptions
              SET consecutive_failures = 0, failing_since = NULL, last_success_at = $now
            WHERE id = $sub`
        )
        .run({ $now: now, $sub: claim.subscriptionId });
      return "delivered";
    }

    // Stop cut the send short: the receiver may or may not have it. Release
    // the lease without blaming the receiver; the next process resends it.
    if (ctx.stopped) {
      const changed = raw
        .query(`UPDATE webhook_deliveries SET lease_until = NULL ${fence}`)
        .run(fenceParams).changes;
      return changed === 0 ? null : "released";
    }

    if (statusCode === 410) {
      const changed = raw
        .query(
          `UPDATE webhook_deliveries
              SET status = 'failed', last_status_code = 410,
                  last_error = '410 Gone: subscription disabled', lease_until = NULL
            ${fence}`
        )
        .run(fenceParams).changes;
      if (changed === 0) return null;
      raw
        .query("UPDATE webhook_subscriptions SET last_failure_at = $now WHERE id = $sub")
        .run({ $now: now, $sub: claim.subscriptionId });
      disableSubscription(tx as unknown as DB, claim.subscriptionId, "gone", new Date(now));
      console.warn(`[webhooks] subscription ${claim.subscriptionId} answered 410 Gone; disabled`);
      return "failed";
    }

    // Any other failure: retry on schedule, or give up after the last one.
    const retryIndex = claim.attempts - 1;
    const outcome: Outcome = retryIndex < ctx.schedule.length ? "retrying" : "failed";
    const changed =
      outcome === "retrying"
        ? raw
            .query(
              `UPDATE webhook_deliveries
                  SET next_attempt_at = $next, lease_until = NULL,
                      last_status_code = $code, last_error = $error
                ${fence}`
            )
            .run({
              ...fenceParams,
              $next: now + webhookRetryJitter(ctx.schedule[retryIndex], ctx.random),
              $code: statusCode,
              $error: error,
            }).changes
        : raw
            .query(
              `UPDATE webhook_deliveries
                  SET status = 'failed', lease_until = NULL,
                      last_status_code = $code, last_error = $error
                ${fence}`
            )
            .run({ ...fenceParams, $code: statusCode, $error: error }).changes;
    if (changed === 0) return null;

    const sub = raw
      .query(
        `UPDATE webhook_subscriptions
            SET consecutive_failures = consecutive_failures + 1,
                failing_since = COALESCE(failing_since, $now), last_failure_at = $now
          WHERE id = $sub
        RETURNING failing_since, enabled`
      )
      .get({ $now: now, $sub: claim.subscriptionId }) as { failing_since: number; enabled: number } | null;
    if (sub && sub.enabled && now - sub.failing_since >= ctx.autoDisableMs) {
      disableSubscription(tx as unknown as DB, claim.subscriptionId, "failing", new Date(now));
      console.warn(
        `[webhooks] subscription ${claim.subscriptionId} failing for ${Math.round((now - sub.failing_since) / 1000)} s; disabled`
      );
      return "failed";
    }
    return outcome;
  });
}

/**
 * One pass: claim due deliveries, send them concurrently, record each
 * result. A bad row is logged and left to its lease; it never stops the pass.
 */
export async function processDueWebhooks(db: DB, opts: WebhookTickOptions = {}): Promise<WebhookTickSummary> {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const env = opts.env ?? process.env;
  const summary: WebhookTickSummary = { claimed: 0, delivered: 0, retrying: 0, failed: 0, released: 0 };
  if (opts.signal?.aborted) return summary;

  const claims = claimDueDeliveries(db, { now: now(), batch: opts.batch ?? DEFAULT_WEBHOOK_BATCH });
  summary.claimed = claims.length;
  if (claims.length === 0) return summary;

  const schedule = retryScheduleMs(env);
  const autoDisableMs = autoDisableAfterMs(env);
  const fetchImpl = opts.fetchImpl ?? webhookFetch({ env });

  // Each subscription's url and secret, decrypted once per tick.
  const subs = new Map<string, { url: string; secret: string } | { error: string }>();
  const raw = rawOf(db);
  for (const subscriptionId of new Set(claims.map((c) => c.subscriptionId))) {
    const row = raw
      .query("SELECT url, secret_ciphertext FROM webhook_subscriptions WHERE id = ?")
      .get(subscriptionId) as { url: string; secret_ciphertext: string } | null;
    if (!row) continue; // Deleted after the claim; its deliveries cascaded away.
    try {
      subs.set(subscriptionId, {
        url: row.url,
        secret: decryptSecret(row.secret_ciphertext, getWebhookSecretKey(db)),
      });
    } catch (err) {
      subs.set(subscriptionId, {
        error: `cannot decrypt the signing secret: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  await Promise.all(
    claims.map(async (claim) => {
      try {
        const sub = subs.get(claim.subscriptionId);
        if (!sub) return;
        let result: SendWebhookResult;
        if ("error" in sub) {
          result = { ok: false, error: sub.error, durationMs: 0 };
        } else if (opts.signal?.aborted) {
          result = { ok: false, error: "aborted", durationMs: 0 };
        } else {
          result = await sendWebhook({
            url: sub.url,
            secret: sub.secret,
            webhookId: claim.eventId,
            body: claim.payload,
            fetchImpl,
            now,
            ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
            ...(opts.signal ? { signal: opts.signal } : {}),
          });
        }
        const outcome = recordResult(db, claim, result, {
          now: now(),
          schedule,
          random,
          autoDisableMs,
          stopped: opts.signal?.aborted ?? false,
        });
        if (outcome) summary[outcome] += 1;
      } catch (err) {
        console.error(
          `[webhooks] delivery ${claim.id} failed to record (lease expires, then it is retried):`,
          err
        );
      }
    })
  );
  return summary;
}

// --- Loop -------------------------------------------------------------------

let interval: ReturnType<typeof setInterval> | undefined;
let earlyTick: ReturnType<typeof setTimeout> | undefined;
let processing: Promise<void> | undefined;
let stopController: AbortController | undefined;
let unregisterEnqueued: (() => void) | undefined;
let workerDb: DB | undefined;
let workerOpts: WebhookWorkerOptions = {};

async function tick(): Promise<void> {
  if (processing || !workerDb) return;
  const db = workerDb;
  let full = false;
  processing = (async () => {
    try {
      const batch = workerOpts.batch ?? DEFAULT_WEBHOOK_BATCH;
      const summary = await processDueWebhooks(db, { ...workerOpts, batch, signal: stopController?.signal });
      // A full batch means a backlog: go again soon instead of a whole poll later.
      full = summary.claimed >= batch;
    } catch (err) {
      console.error("[webhooks] delivery tick failed:", err);
    }
  })();
  try {
    await processing;
  } finally {
    processing = undefined;
  }
  if (full) scheduleEarlyTick();
}

function scheduleEarlyTick(): void {
  if (!interval || earlyTick) return;
  earlyTick = setTimeout(() => {
    earlyTick = undefined;
    void tick();
  }, EARLY_TICK_DEBOUNCE_MS);
}

/**
 * Start delivering. Idempotent. Throws on an invalid
 * `AGENT_FS_WEBHOOK_ALLOWED_HOSTS`, so a misconfigured server fails at boot
 * rather than silently delivering nothing. An enqueue triggers an early tick.
 */
export function startWebhookWorker(db: DB, opts: WebhookWorkerOptions = {}): void {
  if (interval) return;
  const env = opts.env ?? process.env;
  webhookEgressConfig(env);
  workerDb = db;
  workerOpts = opts;
  stopController = new AbortController();
  unregisterEnqueued = onWebhooksEnqueued(scheduleEarlyTick);
  interval = setInterval(() => void tick(), opts.pollMs ?? pollMsFromEnv(env));
  interval.unref?.();
  void tick();
}

/**
 * Stop delivering: no new tick or send starts, in-flight sends are aborted
 * (their leases are released, so a restart resends them), and the returned
 * promise settles when the in-flight tick has recorded its results. Shutdown
 * should still race it with its own deadline.
 */
export async function stopWebhookWorker(): Promise<void> {
  stopController?.abort();
  if (interval) clearInterval(interval);
  interval = undefined;
  if (earlyTick) clearTimeout(earlyTick);
  earlyTick = undefined;
  unregisterEnqueued?.();
  unregisterEnqueued = undefined;
  if (processing) await processing;
  workerDb = undefined;
  workerOpts = {};
}

/** True while the worker loop is started. */
export function isWebhookWorkerRunning(): boolean {
  return interval !== undefined;
}

/** Test hook: one pass with injected clock, fetch and jitter; no timers. */
export function runWebhookTickForTests(db: DB, opts: WebhookTickOptions = {}): Promise<WebhookTickSummary> {
  return processDueWebhooks(db, opts);
}
