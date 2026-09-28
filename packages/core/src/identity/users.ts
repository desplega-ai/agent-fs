import { eq } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import { createOrg } from "./orgs.js";
import { z } from "zod";
import { ValidationError, NotFoundError } from "../errors.js";

function hashApiKey(key: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(key);
  return hasher.digest("hex");
}

function generateApiKey(): string {
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
  });
  return { apiKey };
}

export function getUserByApiKey(
  db: DB,
  apiKey: string
): { id: string; email: string } | null {
  const hash = hashApiKey(apiKey);
  const user = db
    .select()
    .from(schema.users)
    .where(eq(schema.users.apiKeyHash, hash))
    .get();

  if (!user) return null;
  return { id: user.id, email: user.email };
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
