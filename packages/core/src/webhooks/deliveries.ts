// Delivery log: public shape, the list cursor, and scoped delivery lookup.
//
// A delivery is visible only through its subscription, so every lookup goes
// through the same org/drive scoping and admin check as the hook itself.

import { and, eq, isNull, or } from "drizzle-orm";
import { schema } from "../db/index.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { OpContext } from "../ops/types.js";
import {
  authorizeWebhookScope,
  scopeOf,
  type WebhookSubscriptionRow,
} from "./subscriptions.js";

export type WebhookDeliveryStatus = "pending" | "delivered" | "failed";
export type WebhookDeliveryRow = typeof schema.webhookDeliveries.$inferSelect;

export const DEFAULT_DELIVERIES_LIMIT = 50;
export const MAX_DELIVERIES_LIMIT = 200;

/** A delivery as ops return it. */
export interface PublicDelivery {
  id: string;
  subscriptionId: string;
  /** The events.id, sent as `webhook-id`. */
  eventId: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  /** Attempts so far. Redelivery keeps the count. */
  attempts: number;
  /** When a pending row is next due; null once it is delivered or failed. */
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  /** The exact JSON body that is signed and sent. Only with `includePayload`. */
  payload?: string;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function toPublicDelivery(row: WebhookDeliveryRow, includePayload = false): PublicDelivery {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    eventId: row.eventId,
    eventType: row.eventType,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.status === "pending" ? iso(row.nextAttemptAt) : null,
    lastAttemptAt: iso(row.lastAttemptAt),
    lastStatusCode: row.lastStatusCode ?? null,
    lastError: row.lastError ?? null,
    deliveredAt: iso(row.deliveredAt),
    createdAt: row.createdAt.toISOString(),
    ...(includePayload ? { payload: row.payload } : {}),
  };
}

/** Position after the last row of a page, newest first: (createdAt, id). */
export interface DeliveriesCursor {
  createdAt: number;
  id: string;
}

export function encodeDeliveriesCursor(row: Pick<WebhookDeliveryRow, "createdAt" | "id">): string {
  return Buffer.from(`${row.createdAt.getTime()}:${row.id}`, "utf8").toString("base64url");
}

export function decodeDeliveriesCursor(cursor: string): DeliveriesCursor {
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = text.indexOf(":");
  const ms = sep > 0 ? text.slice(0, sep) : "";
  const id = sep > 0 ? text.slice(sep + 1) : "";
  if (!/^\d+$/.test(ms) || !id) {
    throw new ValidationError("Invalid deliveries cursor", {
      field: "cursor",
      suggestion: "Pass the nextCursor value from the previous webhook-deliveries call",
    });
  }
  return { createdAt: Number(ms), id };
}

/**
 * Load a delivery whose subscription is visible from the caller's org and
 * drive, then authorize on the subscription's scope (the same rule as the
 * hook). Anything out of scope is NotFoundError, the same as a missing id.
 */
export function getScopedDelivery(
  ctx: OpContext,
  deliveryId: string
): { delivery: WebhookDeliveryRow; subscription: WebhookSubscriptionRow } {
  const d = schema.webhookDeliveries;
  const s = schema.webhookSubscriptions;
  const found = ctx.db
    .select({ delivery: d, subscription: s })
    .from(d)
    .innerJoin(s, eq(s.id, d.subscriptionId))
    .where(
      and(eq(d.id, deliveryId), eq(s.orgId, ctx.orgId), or(isNull(s.driveId), eq(s.driveId, ctx.driveId)))
    )
    .get();
  if (!found) {
    throw new NotFoundError(`Webhook delivery not found: ${deliveryId}`, {
      suggestion: "Run webhook-deliveries <webhook-id> to see a hook's deliveries",
    });
  }
  authorizeWebhookScope(ctx, scopeOf(found.subscription));
  return found;
}
