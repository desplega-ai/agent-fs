// webhook-create / -list / -update / -delete / -test / -deliveries /
// -redeliver.
//
// RBAC: the dispatcher maps these ops to "viewer" (drive membership). Each
// handler then enforces drive admin (drive hooks; an org admin passes too) or
// org admin (org hooks) through authorizeWebhookScope / getScopedSubscription
// (getScopedDelivery for a delivery, on its hook's scope).

import { and, asc, count, desc, eq, isNull, lt, lte, ne, or } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import { EditConflictError, ValidationError } from "../errors.js";
import { getUserOrgRole, requireDriveAdmin } from "../identity/rbac.js";
import type { OpContext } from "./types.js";
import { assertPathInsideDrive, normalizePrefix } from "./paths.js";
import { decryptSecret, encryptSecret } from "../webhooks/crypto/secrets-cipher.js";
import { getWebhookSecretKey } from "../webhooks/crypto/key.js";
import {
  DEFAULT_DELIVERIES_LIMIT,
  decodeDeliveriesCursor,
  encodeDeliveriesCursor,
  getScopedDelivery,
  toPublicDelivery,
  type PublicDelivery,
  type WebhookDeliveryStatus,
} from "../webhooks/deliveries.js";
import { assertWebhookUrl } from "../webhooks/egress.js";
import { MAX_SUBSCRIPTIONS_PER_ORG, type WebhookEventType } from "../webhooks/events.js";
import { notifyWebhooksEnqueued, type WebhookEnvelope } from "../webhooks/outbox.js";
import { sendWebhook, type SendWebhookInput } from "../webhooks/sender.js";
import { generateWebhookSecret } from "../webhooks/signature.js";
import {
  authorizeWebhookScope,
  disableSubscription,
  getScopedSubscription,
  toPublic,
  type PublicWebhook,
  type WebhookScope,
  type WebhookSubscriptionRow,
} from "../webhooks/subscriptions.js";

export interface WebhookCreateParams {
  scope?: WebhookScope;
  url: string;
  eventTypes: WebhookEventType[];
  description?: string;
  /** Limit `file.changed` to paths under this directory. "/" means all. */
  pathPrefix?: string;
}

export interface WebhookListParams {
  scope?: WebhookScope | "all";
}

export interface WebhookUpdateParams {
  id: string;
  url?: string;
  eventTypes?: WebhookEventType[];
  /** An empty string clears the description. */
  description?: string;
  /** An empty string or "/" clears the prefix. */
  pathPrefix?: string;
  enabled?: boolean;
  rotateSecret?: boolean;
}

export interface WebhookIdParams {
  id: string;
}

export interface WebhookDeliveriesParams {
  id: string;
  status?: WebhookDeliveryStatus;
  limit?: number;
  cursor?: string;
  includePayload?: boolean;
}

export interface WebhookRedeliverParams {
  deliveryId: string;
}

/** Data of the `ping` envelope `webhook-test` sends. */
export interface WebhookPingData {
  subscriptionId: string;
  orgId: string;
  driveId: string | null;
}

export interface WebhookTestResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
  durationMs: number;
  webhookId: string;
}

const subs = schema.webhookSubscriptions;

function getRow(db: DB, id: string): WebhookSubscriptionRow {
  return db.select().from(subs).where(eq(subs.id, id)).get()!;
}

function normalizeDescription(description: string | undefined): string | null {
  const trimmed = description?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Store a path prefix as a normalized "/dir/" or null. "/" and "" mean every
 * path. A "." or ".." segment is refused, since no stored path matches it.
 */
function normalizeWebhookPathPrefix(pathPrefix: string | undefined): string | null {
  const trimmed = pathPrefix?.trim();
  if (!trimmed) return null;
  try {
    assertPathInsideDrive(trimmed);
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new ValidationError(err.message.replace(/^Path/, "pathPrefix"), {
        field: "pathPrefix",
        suggestion: "Give a directory inside the drive, e.g. /docs/",
      });
    }
    throw err;
  }
  const prefix = normalizePrefix(trimmed);
  return prefix === "/" ? null : prefix;
}

function encodeEventTypes(eventTypes: WebhookEventType[]): string {
  return JSON.stringify([...new Set(eventTypes)]);
}

export async function webhookCreate(
  ctx: OpContext,
  params: WebhookCreateParams
): Promise<PublicWebhook & { secret: string }> {
  const scope = params.scope ?? "drive";
  authorizeWebhookScope(ctx, scope);
  await assertWebhookUrl(params.url);
  const pathPrefix = normalizeWebhookPathPrefix(params.pathPrefix);

  const secret = generateWebhookSecret();
  // Resolve the key before inserting: with no rows yet it may auto-generate.
  const secretCiphertext = encryptSecret(secret, getWebhookSecretKey(ctx.db));
  const id = crypto.randomUUID();
  const now = new Date();

  ctx.db.transaction((tx) => {
    const existing = tx.select({ n: count() }).from(subs).where(eq(subs.orgId, ctx.orgId)).get()?.n ?? 0;
    if (existing >= MAX_SUBSCRIPTIONS_PER_ORG) {
      throw new ValidationError(
        `This org already has ${existing} webhooks; the limit is ${MAX_SUBSCRIPTIONS_PER_ORG}`,
        { suggestion: "Delete an unused webhook with webhook-delete first" }
      );
    }
    tx.insert(subs)
      .values({
        id,
        orgId: ctx.orgId,
        driveId: scope === "drive" ? ctx.driveId : null,
        url: params.url,
        description: normalizeDescription(params.description),
        eventTypes: encodeEventTypes(params.eventTypes),
        pathPrefix,
        secretCiphertext,
        enabled: true,
        createdBy: ctx.userId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });

  return { ...toPublic(getRow(ctx.db, id)), secret };
}

export async function webhookList(
  ctx: OpContext,
  params: WebhookListParams
): Promise<{ webhooks: PublicWebhook[] }> {
  const scope = params.scope ?? "all";
  let includeDrive = false;
  let includeOrg = false;
  if (scope === "drive" || scope === "org") {
    authorizeWebhookScope(ctx, scope);
    includeDrive = scope === "drive";
    includeOrg = scope === "org";
  } else {
    // A drive admin sees this drive's hooks; an org admin (who always passes
    // the drive check too) also sees the org's.
    requireDriveAdmin(ctx.db, { userId: ctx.userId, driveId: ctx.driveId });
    includeDrive = true;
    includeOrg = getUserOrgRole(ctx.db, ctx.userId, ctx.orgId) === "admin";
  }

  const rows: WebhookSubscriptionRow[] = [];
  if (includeOrg) {
    rows.push(
      ...ctx.db.select().from(subs)
        .where(and(eq(subs.orgId, ctx.orgId), isNull(subs.driveId)))
        .orderBy(asc(subs.createdAt), asc(subs.id))
        .all()
    );
  }
  if (includeDrive) {
    rows.push(
      ...ctx.db.select().from(subs)
        .where(and(eq(subs.orgId, ctx.orgId), eq(subs.driveId, ctx.driveId)))
        .orderBy(asc(subs.createdAt), asc(subs.id))
        .all()
    );
  }
  return { webhooks: rows.map((row) => toPublic(row)) };
}

export async function webhookUpdate(
  ctx: OpContext,
  params: WebhookUpdateParams
): Promise<PublicWebhook & { secret?: string }> {
  const row = getScopedSubscription(ctx, params.id);
  if (params.url !== undefined) await assertWebhookUrl(params.url);
  const pathPrefix =
    params.pathPrefix !== undefined ? normalizeWebhookPathPrefix(params.pathPrefix) : undefined;

  let secret: string | undefined;
  let secretCiphertext: string | undefined;
  if (params.rotateSecret) {
    secret = generateWebhookSecret();
    secretCiphertext = encryptSecret(secret, getWebhookSecretKey(ctx.db));
  }

  const now = new Date();
  ctx.db.transaction((tx) => {
    const set: Partial<typeof subs.$inferInsert> = { updatedAt: now };
    if (params.url !== undefined) set.url = params.url;
    if (params.eventTypes !== undefined) set.eventTypes = encodeEventTypes(params.eventTypes);
    if (params.description !== undefined) set.description = normalizeDescription(params.description);
    if (pathPrefix !== undefined) set.pathPrefix = pathPrefix;
    if (secretCiphertext !== undefined) set.secretCiphertext = secretCiphertext;
    if (params.enabled === true) {
      Object.assign(set, {
        enabled: true,
        disabledReason: null,
        disabledAt: null,
        consecutiveFailures: 0,
        failingSince: null,
      });
    }
    tx.update(subs).set(set).where(eq(subs.id, row.id)).run();
    // Disabling an already disabled hook keeps its original reason.
    if (params.enabled === false && row.enabled) {
      disableSubscription(tx as unknown as DB, row.id, "manual", now);
    }
  });

  const updated = toPublic(getRow(ctx.db, row.id));
  return secret !== undefined ? { ...updated, secret } : updated;
}

export async function webhookDelete(
  ctx: OpContext,
  params: WebhookIdParams
): Promise<{ deleted: true }> {
  const row = getScopedSubscription(ctx, params.id);
  // Deliveries go with it (ON DELETE CASCADE).
  ctx.db.delete(subs).where(eq(subs.id, row.id)).run();
  return { deleted: true };
}

/**
 * Send a signed `ping` to the hook now, inline. Touches no failure counter and
 * writes no delivery row, so it works with the worker off and on a disabled
 * hook (useful while setting a receiver up).
 */
export async function webhookTest(
  ctx: OpContext,
  params: WebhookIdParams,
  opts: { fetchImpl?: SendWebhookInput["fetchImpl"]; timeoutMs?: number } = {}
): Promise<WebhookTestResult> {
  const row = getScopedSubscription(ctx, params.id);
  const secret = decryptSecret(row.secretCiphertext, getWebhookSecretKey(ctx.db));
  const webhookId = `ping_${crypto.randomUUID()}`;
  const envelope: WebhookEnvelope<WebhookPingData> = {
    type: "ping",
    timestamp: new Date().toISOString(),
    data: { subscriptionId: row.id, orgId: row.orgId, driveId: row.driveId ?? null },
  };
  const result = await sendWebhook({
    url: row.url,
    secret,
    webhookId,
    body: JSON.stringify(envelope),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return { ...result, webhookId };
}

/**
 * A hook's deliveries, newest first, without the payload unless
 * `includePayload` is set. Page with `nextCursor` (null on the last page).
 */
export async function webhookDeliveries(
  ctx: OpContext,
  params: WebhookDeliveriesParams
): Promise<{ deliveries: PublicDelivery[]; nextCursor: string | null }> {
  const sub = getScopedSubscription(ctx, params.id);
  const d = schema.webhookDeliveries;
  const limit = params.limit ?? DEFAULT_DELIVERIES_LIMIT;
  const conditions = [eq(d.subscriptionId, sub.id)];
  if (params.status) conditions.push(eq(d.status, params.status));
  if (params.cursor !== undefined) {
    const after = decodeDeliveriesCursor(params.cursor);
    const at = new Date(after.createdAt);
    conditions.push(or(lt(d.createdAt, at), and(eq(d.createdAt, at), lt(d.id, after.id)))!);
  }
  // One extra row tells whether another page exists.
  const rows = ctx.db
    .select()
    .from(d)
    .where(and(...conditions))
    .orderBy(desc(d.createdAt), desc(d.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    deliveries: page.map((row) => toPublicDelivery(row, params.includePayload ?? false)),
    nextCursor: rows.length > limit && last ? encodeDeliveriesCursor(last) : null,
  };
}

/**
 * Queue a delivery to be sent again now: status 'pending', next_attempt_at
 * now, lease cleared. `attempts` is kept as history, so a row past the retry
 * schedule gets this one attempt and no further retries. Refused while the
 * hook is disabled (re-enable it first) and while the row is being sent.
 */
export async function webhookRedeliver(
  ctx: OpContext,
  params: WebhookRedeliverParams
): Promise<PublicDelivery> {
  const d = schema.webhookDeliveries;
  // One transaction: a disable or a worker claim cannot land between the
  // checks and the write.
  const row = ctx.db.transaction(() => {
    const { delivery, subscription } = getScopedDelivery(ctx, params.deliveryId);
    if (!subscription.enabled) {
      throw new ValidationError(
        `Webhook ${subscription.id} is disabled (${subscription.disabledReason ?? "manual"}); its deliveries cannot be redelivered`,
        {
          field: "deliveryId",
          suggestion: `Re-enable it first: webhook update ${subscription.id} --enable`,
        }
      );
    }
    const now = new Date();
    const [updated] = ctx.db
      .update(d)
      .set({ status: "pending", nextAttemptAt: now, leaseUntil: null })
      .where(
        and(
          eq(d.id, delivery.id),
          // A pending row under a live lease is being sent right now.
          or(ne(d.status, "pending"), isNull(d.leaseUntil), lte(d.leaseUntil, now))
        )
      )
      .returning()
      .all();
    if (!updated) {
      throw new EditConflictError(`Webhook delivery ${delivery.id} is being sent right now`, {
        suggestion: "Wait for the attempt to finish, then check webhook-deliveries",
      });
    }
    return updated;
  });
  notifyWebhooksEnqueued();
  return toPublicDelivery(row);
}
