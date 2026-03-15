import { eq } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import { createOrg } from "./orgs.js";

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
