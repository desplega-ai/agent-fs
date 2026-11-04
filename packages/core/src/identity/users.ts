import { eq, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import { createOrg } from "./orgs.js";
import { PRIMARY_API_KEY_ID, revokeGrantedKeys } from "./api-keys.js";
import { z } from "zod";
import { ValidationError, NotFoundError } from "../errors.js";

export function hashApiKey(key: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(key);
  return hasher.digest("hex");
}

export function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `af_${hex}`;
}

function generateId(): string {
  return crypto.randomUUID();
}

export interface CreateUserResult {
  user: { id: string; email: string };
  apiKey: string; // Only returned on creation
}

export function createUser(
  db: DB,
  params: { email: string }
): CreateUserResult {
  const id = generateId();
  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);
  const now = new Date();

  db.insert(schema.users)
    .values({ id, email: params.email, apiKeyHash, createdAt: now })
    .run();

  // Auto-create personal org with default drive
  createOrg(db, {
    name: params.email.split("@")[0],
    userId: id,
    isPersonal: true,
  });

  return { user: { id, email: params.email }, apiKey };
}

export interface ResetApiKeyResult {
  user: { id: string; email: string };
  apiKey: string; // Only returned on reset
}

export function resetApiKey(
  db: DB,
  params: { userId: string; actorId: string; orgId: string }
): ResetApiKeyResult {
  const existing = db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, params.userId))
    .get();

  if (!existing) {
    throw new NotFoundError("User not found", { suggestion: "Check the user id" });
  }

  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);
  const now = new Date();

  db.transaction((tx) => {
    tx.update(schema.users)
      .set({ apiKeyHash })
      .where(eq(schema.users.id, params.userId))
      .run();

    // A self reset is the user's recovery path: it also cuts off every
    // org-scoped (admin-minted) key. Keys from POST /auth/keys stay.
    if (params.actorId === params.userId) {
      revokeGrantedKeys(tx, { reason: "selfReset", userId: params.userId });
    }

    tx.insert(schema.events)
      .values({
        id: crypto.randomUUID(),
        orgId: params.orgId,
        type: "api_key_reset",
        resourceType: "user",
        resourceId: params.userId,
        actor: params.actorId,
        target: params.userId,
        status: "created",
        metadata: JSON.stringify({
          method: params.actorId === params.userId ? "self" : "admin",
        }),
        createdAt: now,
      })
      .run();
  });

  return { user: { id: existing.id, email: existing.email }, apiKey };
}

/**
 * Fallback for the impossible-in-practice case of a user with no orgs
 * (every user gets an auto-created personal org on registration, and the
 * last admin can never be removed from a personal org — see
 * `removeOrgMember`). Wrapped in a transaction to match `resetApiKey`'s
 * atomicity guarantee. Cannot record an `api_key_reset` event like the
 * org-scoped path does: `events.orgId` is a NOT NULL foreign key to `orgs`,
 * and there is no orgId to attach an event to here.
 */
export function resetApiKeyOrgless(db: DB, userId: string): { apiKey: string } {
  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);
  db.transaction((tx) => {
    tx.update(schema.users).set({ apiKeyHash }).where(eq(schema.users.id, userId)).run();
    revokeGrantedKeys(tx, { reason: "selfReset", userId });
  });
  return { apiKey };
}

/** `last_used_at` is written at most once per this many seconds per key. */
export const API_KEY_LAST_USED_THROTTLE_SECONDS = 60;

/**
 * Resolve an API key to its user. Accepts the primary key
 * (`users.api_key_hash`) and any non-revoked key in `user_api_keys`. One
 * statement, two indexed probes. For a `user_api_keys` hit, `last_used_at` is
 * refreshed only when it is older than API_KEY_LAST_USED_THROTTLE_SECONDS, so
 * the hot path stays read-only.
 *
 * `scopeOrgId` is set for an org-scoped key (minted by an org admin): such a
 * key may only act inside that org, and every caller must enforce it (the HTTP
 * middleware limits it to `/orgs/<scopeOrgId>/...`; IPC refuses it).
 * `keyId` names the key that matched (`primary` for the legacy key), so
 * `GET /auth/keys` can mark the one the caller is using.
 */
export function getUserByApiKey(
  db: DB,
  apiKey: string
): { id: string; email: string; scopeOrgId: string | null; keyId: string } | null {
  const hash = hashApiKey(apiKey);
  // `values` returns positional rows; drizzle's raw `get` does not map
  // column names for compound selects.
  const [row] = db.values<[string, string, string | null, number | null, string | null]>(sql`
    SELECT id, email, NULL AS key_id, NULL AS last_used_at, NULL AS org_id
      FROM users WHERE api_key_hash = ${hash}
    UNION ALL
    SELECT u.id, u.email, k.id, k.last_used_at, k.org_id
      FROM user_api_keys k JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = ${hash} AND k.revoked_at IS NULL
    LIMIT 1
  `);

  if (!row) return null;
  const [id, email, keyId, lastUsedAt, scopeOrgId] = row;
  if (keyId) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (lastUsedAt == null || nowSec - lastUsedAt >= API_KEY_LAST_USED_THROTTLE_SECONDS) {
      db.update(schema.userApiKeys)
        .set({ lastUsedAt: new Date(nowSec * 1000) })
        .where(eq(schema.userApiKeys.id, keyId))
        .run();
    }
  }
  return { id, email, scopeOrgId: scopeOrgId ?? null, keyId: keyId ?? PRIMARY_API_KEY_ID };
}

export function getUserByEmail(
  db: DB,
  email: string
): { id: string; email: string } | null {
  const user = db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .get();

  if (!user) return null;
  return { id: user.id, email: user.email };
}

// Shared validation for HTTP and MCP. No target user ID is accepted from input.
export const profileUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(100).nullable(),
}).strict();

export function getProfile(db: DB, userId: string) {
  const user = db.select({ userId: schema.users.id, email: schema.users.email,
    displayName: schema.users.displayName }).from(schema.users)
    .where(eq(schema.users.id, userId)).get();
  if (!user) throw new NotFoundError("User not found");
  return user;
}

export function updateProfile(db: DB, userId: string, input: unknown) {
  const parsed = profileUpdateSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("displayName must be 1–100 characters or null; no other fields are allowed");
  db.update(schema.users).set(parsed.data).where(eq(schema.users.id, userId)).run();
  return getProfile(db, userId);
}

export type EmailUser = { id: string; email: string };

/**
 * Resolve an email to one account. `users.email` is unique only
 * case-sensitively, so an exact match (after trimming) wins; otherwise a
 * case-insensitive match counts only when it is the sole candidate. Several
 * case-variant candidates come back as `ambiguous` so callers never pick one.
 */
export function resolveUserByEmail(
  db: DB,
  email: string
):
  | { kind: "found"; user: EmailUser }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: EmailUser[] } {
  const trimmed = email.trim();
  const fields = { id: schema.users.id, email: schema.users.email };
  const exact = db.select(fields).from(schema.users).where(eq(schema.users.email, trimmed)).get();
  if (exact) return { kind: "found", user: exact };

  const candidates = db
    .select(fields)
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = lower(${trimmed})`)
    .all();
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "found", user: candidates[0] };
  return { kind: "ambiguous", candidates };
}

export function ambiguousEmailError(email: string, count: number): ValidationError {
  return new ValidationError(
    `${count} accounts match ${email.trim()} when letter case is ignored`,
    { field: "email", suggestion: "Use the account's exact email, including letter case" }
  );
}
