// Webhook subscription lookup, authorization and public shape.
//
// The dispatcher only requires drive membership (the five ops map to
// "viewer" in OP_ROLES). These helpers enforce the real rule: a drive hook
// needs drive admin (an org admin passes too), an org hook needs org admin.

import { and, eq, isNull, or } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import { NotFoundError } from "../errors.js";
import { requireDriveAdmin, requireOrgRole } from "../identity/rbac.js";
import type { OpContext } from "../ops/types.js";
import { isWebhookEventType, type WebhookEventType } from "./events.js";

export type WebhookScope = "drive" | "org";
export type WebhookDisabledReason = "gone" | "failing" | "manual";
export type WebhookSubscriptionRow = typeof schema.webhookSubscriptions.$inferSelect;

/** A subscription as ops return it. Never carries the secret. */
export interface PublicWebhook {
  id: string;
  scope: WebhookScope;
  driveId: string | null;
  url: string;
  description: string | null;
  eventTypes: WebhookEventType[];
  enabled: boolean;
  disabledReason: WebhookDisabledReason | null;
  disabledAt: string | null;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** False when this server delivers nothing (AGENT_FS_WEBHOOK_WORKER unset). */
  workerEnabled: boolean;
}

/** `AGENT_FS_WEBHOOK_WORKER` is `true` or `1`. */
export function isWebhookWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.AGENT_FS_WEBHOOK_WORKER?.trim().toLowerCase();
  return value === "true" || value === "1";
}

/**
 * Throw PermissionDeniedError unless the caller may manage hooks of `scope`:
 * drive admin or org admin for `"drive"`, org admin for `"org"`.
 */
export function authorizeWebhookScope(ctx: OpContext, scope: WebhookScope): void {
  if (scope === "drive") {
    requireDriveAdmin(ctx.db, { userId: ctx.userId, driveId: ctx.driveId });
  } else {
    requireOrgRole(ctx.db, { userId: ctx.userId, orgId: ctx.orgId, requiredRole: "admin" });
  }
}

export function scopeOf(row: Pick<WebhookSubscriptionRow, "driveId">): WebhookScope {
  return row.driveId ? "drive" : "org";
}

/**
 * Load a subscription visible from the caller's org and drive, then authorize
 * on its scope. An org hook must belong to `ctx.orgId`; a drive hook must also
 * belong to `ctx.driveId`. Anything else is NotFoundError, the same as a
 * missing id, so ids are no cross-tenant oracle.
 */
export function getScopedSubscription(ctx: OpContext, id: string): WebhookSubscriptionRow {
  const s = schema.webhookSubscriptions;
  const row = ctx.db
    .select()
    .from(s)
    .where(
      and(eq(s.id, id), eq(s.orgId, ctx.orgId), or(isNull(s.driveId), eq(s.driveId, ctx.driveId)))
    )
    .get();
  if (!row) {
    throw new NotFoundError(`Webhook not found: ${id}`, {
      suggestion: "Run webhook-list to see the hooks of this drive and org",
    });
  }
  authorizeWebhookScope(ctx, scopeOf(row));
  return row;
}

/** Stored `event_types`, tolerating a damaged value (it lists nothing). */
export function parseStoredEventTypes(raw: string): WebhookEventType[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is WebhookEventType => typeof t === "string" && isWebhookEventType(t));
  } catch {
    return [];
  }
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function toPublic(
  row: WebhookSubscriptionRow,
  env: NodeJS.ProcessEnv = process.env
): PublicWebhook {
  return {
    id: row.id,
    scope: scopeOf(row),
    driveId: row.driveId ?? null,
    url: row.url,
    description: row.description ?? null,
    eventTypes: parseStoredEventTypes(row.eventTypes),
    enabled: row.enabled,
    disabledReason: row.disabledReason ?? null,
    disabledAt: iso(row.disabledAt),
    consecutiveFailures: row.consecutiveFailures,
    lastSuccessAt: iso(row.lastSuccessAt),
    lastFailureAt: iso(row.lastFailureAt),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    workerEnabled: isWebhookWorkerEnabled(env),
  };
}

/**
 * Disable a subscription and fail its pending deliveries (`last_error =
 * 'subscription disabled'`), so no row stays pending forever. Runs in its own
 * transaction, or a savepoint when `db` is already a transaction.
 */
export function disableSubscription(
  db: DB,
  id: string,
  reason: WebhookDisabledReason,
  now: Date = new Date()
): void {
  db.transaction((tx) => {
    tx.update(schema.webhookSubscriptions)
      .set({ enabled: false, disabledReason: reason, disabledAt: now, updatedAt: now })
      .where(eq(schema.webhookSubscriptions.id, id))
      .run();
    tx.update(schema.webhookDeliveries)
      .set({ status: "failed", lastError: "subscription disabled", leaseUntil: null })
      .where(
        and(
          eq(schema.webhookDeliveries.subscriptionId, id),
          eq(schema.webhookDeliveries.status, "pending")
        )
      )
      .run();
  });
}
