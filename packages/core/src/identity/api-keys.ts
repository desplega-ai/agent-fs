import { and, asc, eq, isNull } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { generateApiKey, hashApiKey } from "./users.js";

/**
 * Multiple API keys per user.
 *
 * The legacy key in `users.api_key_hash` stays the user's primary key: it is
 * what register and reset-key hand out, and it is listed here with id
 * `primary`. Every other key lives in `user_api_keys`. Revoking the primary
 * key replaces its hash with a value no key can hash to, so it stops matching
 * until reset-key mints a new one.
 */

export const PRIMARY_API_KEY_ID = "primary";
const REVOKED_PRIMARY_PREFIX = "revoked:";
export const API_KEY_LABEL_MAX = 100;

export interface ApiKeyInfo {
  id: string;
  label: string;
  /** Null for the primary key: reset-key rotations are not timestamped. */
  createdAt: Date | null;
  /** Null for the primary key, which is not tracked. */
  lastUsedAt: Date | null;
  primary: boolean;
}

export interface CreatedApiKey {
  id: string;
  label: string;
  createdAt: Date;
  /** Plaintext. Returned once, never stored. */
  apiKey: string;
}

export function parseApiKeyLabel(input: unknown): string {
  const label = typeof input === "string" ? input.trim() : "";
  if (!label || label.length > API_KEY_LABEL_MAX) {
    throw new ValidationError(`label must be 1–${API_KEY_LABEL_MAX} characters`, {
      field: "label",
    });
  }
  return label;
}

/**
 * Mint an additional key for `userId`. When `orgId` is given, records an
 * `api_key_created` audit event in that org (method `self` or `admin`).
 */
export function createUserApiKey(
  db: DB,
  params: { userId: string; label: unknown; actorId: string; orgId?: string }
): CreatedApiKey {
  const label = parseApiKeyLabel(params.label);
  const user = db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, params.userId))
    .get();
  if (!user) throw new NotFoundError("User not found", { suggestion: "Check the user id" });

  const id = crypto.randomUUID();
  const apiKey = generateApiKey();
  const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000);

  db.transaction((tx) => {
    tx.insert(schema.userApiKeys)
      .values({
        id,
        userId: params.userId,
        keyHash: hashApiKey(apiKey),
        label,
        createdAt,
        createdByUserId: params.actorId,
      })
      .run();
    if (params.orgId) {
      tx.insert(schema.events)
        .values({
          id: crypto.randomUUID(),
          orgId: params.orgId,
          type: "api_key_created",
          resourceType: "user",
          resourceId: params.userId,
          actor: params.actorId,
          target: params.userId,
          status: "created",
          metadata: JSON.stringify({
            method: params.actorId === params.userId ? "self" : "admin",
            keyId: id,
            label,
          }),
          createdAt,
        })
        .run();
    }
  });

  return { id, label, createdAt, apiKey };
}

/** Active keys of `userId`, primary first. Never returns hashes or plaintext. */
export function listUserApiKeys(db: DB, userId: string): ApiKeyInfo[] {
  const user = db
    .select({ apiKeyHash: schema.users.apiKeyHash })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  if (!user) throw new NotFoundError("User not found");

  const keys: ApiKeyInfo[] = [];
  if (!user.apiKeyHash.startsWith(REVOKED_PRIMARY_PREFIX)) {
    keys.push({ id: PRIMARY_API_KEY_ID, label: "primary", createdAt: null, lastUsedAt: null, primary: true });
  }
  const rows = db
    .select({
      id: schema.userApiKeys.id,
      label: schema.userApiKeys.label,
      createdAt: schema.userApiKeys.createdAt,
      lastUsedAt: schema.userApiKeys.lastUsedAt,
    })
    .from(schema.userApiKeys)
    .where(and(eq(schema.userApiKeys.userId, userId), isNull(schema.userApiKeys.revokedAt)))
    .orderBy(asc(schema.userApiKeys.createdAt), asc(schema.userApiKeys.id))
    .all();
  for (const r of rows) keys.push({ ...r, primary: false });
  return keys;
}

/**
 * Revoke one of `userId`'s keys. Any key may be revoked, including the last
 * one and the one making the request; a user with no keys left needs an org
 * admin to run reset-key. When `orgId` is given, records an `api_key_revoked`
 * audit event. Unknown, foreign or already-revoked ids are NotFound.
 */
export function revokeUserApiKey(
  db: DB,
  params: { userId: string; keyId: string; actorId: string; orgId?: string }
): void {
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  db.transaction((tx) => {
    let changed: number;
    if (params.keyId === PRIMARY_API_KEY_ID) {
      const user = tx
        .select({ apiKeyHash: schema.users.apiKeyHash })
        .from(schema.users)
        .where(eq(schema.users.id, params.userId))
        .get();
      changed = 0;
      if (user && !user.apiKeyHash.startsWith(REVOKED_PRIMARY_PREFIX)) {
        tx.update(schema.users)
          .set({ apiKeyHash: `${REVOKED_PRIMARY_PREFIX}${crypto.randomUUID()}` })
          .where(eq(schema.users.id, params.userId))
          .run();
        changed = 1;
      }
    } else {
      changed = tx
        .update(schema.userApiKeys)
        .set({ revokedAt: now })
        .where(
          and(
            eq(schema.userApiKeys.id, params.keyId),
            eq(schema.userApiKeys.userId, params.userId),
            isNull(schema.userApiKeys.revokedAt)
          )
        )
        .returning({ id: schema.userApiKeys.id })
        .all().length;
    }
    if (changed === 0) {
      throw new NotFoundError(`API key not found: ${params.keyId}`, {
        suggestion: "List your keys with GET /auth/keys",
      });
    }
    if (params.orgId) {
      tx.insert(schema.events)
        .values({
          id: crypto.randomUUID(),
          orgId: params.orgId,
          type: "api_key_revoked",
          resourceType: "user",
          resourceId: params.userId,
          actor: params.actorId,
          target: params.userId,
          status: "created",
          metadata: JSON.stringify({ keyId: params.keyId }),
          createdAt: now,
        })
        .run();
    }
  });
}
