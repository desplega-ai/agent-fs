// Adapted from desplega-ai/agent-swarm src/be/crypto/key-bootstrap.ts @ 2858e0940.
// Changes: env vars renamed to AGENT_FS_SECRETS_KEY / AGENT_FS_SECRETS_KEY_FILE,
// key file renamed to `.secrets-key`, and getWebhookSecretKey() added, which
// refuses to auto-generate once webhook subscriptions (encrypted rows) exist.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getDbPath } from "../../config.js";
import type { DB } from "../../db/index.js";
import { webhookSubscriptions } from "../../db/schema.js";
import { AES_KEY_BYTES } from "./secrets-cipher.js";

/**
 * Encryption key bootstrap.
 *
 * Resolution order (first match wins):
 *   1. `AGENT_FS_SECRETS_KEY` env var   — base64 string, must decode to 32 bytes
 *   2. `AGENT_FS_SECRETS_KEY_FILE` env var — path to file containing base64
 *   3. `<dirname(dbPath)>/.secrets-key` — on-disk file ($AGENT_FS_HOME/.secrets-key)
 *   4. Auto-generate 32 random bytes, write to path from step 3 with mode 0600
 *      only when generation is allowed for the current DB state
 *
 * Special cases:
 *   - `dbPath === ":memory:"`: steps 3-4 are skipped; an explicit env-var key is required.
 *   - Malformed key at any source: throw immediately (do NOT fall through to
 *     auto-generation, which would silently clobber a broken-but-present key).
 *   - Callers can disable auto-generation for existing DBs via `allowGenerate=false`.
 */

let cachedKey: Buffer | null = null;

export const SECRETS_KEY_ENV = "AGENT_FS_SECRETS_KEY";
export const SECRETS_KEY_FILE_ENV = "AGENT_FS_SECRETS_KEY_FILE";
export const SECRETS_KEY_FILENAME = ".secrets-key";

const ENV_KEY = SECRETS_KEY_ENV;
const ENV_KEY_FILE = SECRETS_KEY_FILE_ENV;
const KEY_FILENAME = SECRETS_KEY_FILENAME;

const HEX_32_BYTE_RE = /^[0-9a-fA-F]{64}$/;

function keyGenerationHelp(): string {
  return [
    "",
    "How to generate a valid key:",
    "  openssl rand -base64 32   # 43-char base64 (recommended)",
    "  openssl rand -hex 32      # 64-char hex (also accepted)",
    "",
    "Common mistake: `openssl rand -base64 39` produces a 52-char string that",
    "decodes to 39 bytes — the number passed to `openssl rand` is the decoded",
    "byte count, and AES-256 requires exactly 32.",
  ].join("\n");
}

function decodeAndValidate(source: string, content: string): Buffer {
  const trimmed = content.trim();

  // Hex path: a 64-char string of [0-9a-fA-F] is unambiguously hex — it would
  // decode to 48 bytes as base64, never 32, so there is no overlap with the
  // base64 happy path.
  if (HEX_32_BYTE_RE.test(trimmed)) {
    const decoded = Buffer.from(trimmed, "hex");
    if (decoded.length === AES_KEY_BYTES) return decoded;
  }

  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === AES_KEY_BYTES) return decoded;

  throw new Error(
    `Invalid encryption key at ${source}: expected ${AES_KEY_BYTES} bytes, ` +
      `got ${decoded.length} bytes after base64 decode.\n${keyGenerationHelp()}`,
  );
}

type ResolveEncryptionKeyOptions = {
  allowGenerate?: boolean;
};

/**
 * Resolve the encryption key according to the order documented above. Idempotent:
 * the first successful call caches the key, and subsequent calls return it without
 * re-reading env vars or disk.
 */
export function resolveEncryptionKey(
  dbPath: string,
  options: ResolveEncryptionKeyOptions = {},
): Buffer {
  if (cachedKey) return cachedKey;

  const allowGenerate = options.allowGenerate ?? true;

  // 1. AGENT_FS_SECRETS_KEY env var
  const envKey = process.env[ENV_KEY];
  if (envKey && envKey.length > 0) {
    cachedKey = decodeAndValidate(`env:${ENV_KEY}`, envKey);
    return cachedKey;
  }

  // 2. AGENT_FS_SECRETS_KEY_FILE env var
  const envKeyFile = process.env[ENV_KEY_FILE];
  if (envKeyFile && envKeyFile.length > 0) {
    if (!existsSync(envKeyFile)) {
      throw new Error(
        `Invalid encryption key at env:${ENV_KEY_FILE} (${envKeyFile}): file does not exist`,
      );
    }
    const content = readFileSync(envKeyFile, "utf8");
    cachedKey = decodeAndValidate(`env:${ENV_KEY_FILE} (${envKeyFile})`, content);
    return cachedKey;
  }

  // In-memory databases must not auto-generate a key in CWD — fail fast.
  if (dbPath === ":memory:") {
    throw new Error(
      `In-memory database requires ${ENV_KEY} or ${ENV_KEY_FILE} to be set explicitly`,
    );
  }

  const keyFilePath = path.join(path.dirname(dbPath), KEY_FILENAME);

  // 3. On-disk .secrets-key file
  if (existsSync(keyFilePath)) {
    const content = readFileSync(keyFilePath, "utf8");
    cachedKey = decodeAndValidate(`file:${keyFilePath}`, content);
    return cachedKey;
  }

  if (!allowGenerate) {
    throw new Error(
      `Refusing to auto-generate ${KEY_FILENAME} for an existing database with encrypted webhook secrets. Restore ${ENV_KEY}, ${ENV_KEY_FILE}, or ${keyFilePath} before booting.`,
    );
  }

  // 4. Auto-generate. Use `wx` flag for TOCTOU safety — fail if file reappeared
  // between existsSync and write (another process won the race).
  const generated = randomBytes(AES_KEY_BYTES);
  const encoded = generated.toString("base64");
  try {
    writeFileSync(keyFilePath, encoded, { flag: "wx", mode: 0o600 });
    console.warn(
      `[secrets] Generated new encryption key at ${keyFilePath}. BACK THIS FILE UP. Losing it means rotating every webhook secret.`,
    );
    cachedKey = generated;
    return cachedKey;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      // Another process won the race — re-read its file.
      const content = readFileSync(keyFilePath, "utf8");
      cachedKey = decodeAndValidate(`file:${keyFilePath}`, content);
      return cachedKey;
    }
    throw err;
  }
}

/**
 * Return the cached encryption key. Throws if `resolveEncryptionKey` has not
 * been called yet (or has been reset via the test hook).
 */
export function getEncryptionKey(): Buffer {
  if (!cachedKey) {
    throw new Error("Encryption key not resolved yet — call resolveEncryptionKey(dbPath) first");
  }
  return cachedKey;
}

/**
 * Test-only: clear the module-level cache so the next `resolveEncryptionKey`
 * call re-reads env vars / disk. Used by integration tests that simulate
 * rotation, missing-key, or wrong-key scenarios.
 */
export function __resetEncryptionKeyForTests(): void {
  cachedKey = null;
}

/** True once any webhook subscription (and so any encrypted secret) exists. */
function hasEncryptedRows(db: DB): boolean {
  return (
    db
      .select({ id: webhookSubscriptions.id })
      .from(webhookSubscriptions)
      .limit(1)
      .get() !== undefined
  );
}

/**
 * The key that encrypts webhook signing secrets. Auto-generates
 * `$AGENT_FS_HOME/.secrets-key` only while no subscription exists: once rows
 * hold ciphertext, a missing key is an error, never a silent new key that
 * could not decrypt them. `dbPath` defaults to the daemon's database path.
 */
export function getWebhookSecretKey(db: DB, dbPath: string = getDbPath()): Buffer {
  if (cachedKey) return cachedKey;
  return resolveEncryptionKey(dbPath, { allowGenerate: !hasEncryptedRows(db) });
}
