import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { decryptSecret, encryptSecret, IV_BYTES, TAG_BYTES } from "../crypto/secrets-cipher.js";
import {
  __resetEncryptionKeyForTests,
  getWebhookSecretKey,
  resolveEncryptionKey,
} from "../crypto/key.js";
import { createTestContext } from "../../test-utils.js";

// Every test runs with AGENT_FS_HOME pointed at a fresh temp dir and the key
// env vars cleared, so nothing here can write a key into the real home.
const ENV_NAMES = ["AGENT_FS_HOME", "AGENT_FS_SECRETS_KEY", "AGENT_FS_SECRETS_KEY_FILE"] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const name of ENV_NAMES) savedEnv[name] = process.env[name];

const realHomeKey = join(homedir(), ".agent-fs", ".secrets-key");
const realHomeKeyExisted = existsSync(realHomeKey);

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-fs-secrets-"));
  process.env.AGENT_FS_HOME = home;
  delete process.env.AGENT_FS_SECRETS_KEY;
  delete process.env.AGENT_FS_SECRETS_KEY_FILE;
  __resetEncryptionKeyForTests();
});

afterEach(() => {
  __resetEncryptionKeyForTests();
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  rmSync(home, { recursive: true, force: true });
});

afterAll(() => {
  __resetEncryptionKeyForTests();
  expect(existsSync(realHomeKey)).toBe(realHomeKeyExisted);
});

/** Flip one bit of the byte at `index` of the decoded payload. */
function tamperByte(encoded: string, index: number): string {
  const buf = Buffer.from(encoded, "base64");
  buf[index] ^= 0x01;
  return buf.toString("base64");
}

describe("secrets cipher", () => {
  const key = randomBytes(32);
  const secret = "whsec_" + randomBytes(32).toString("base64");

  test("encrypt/decrypt round-trips, with a fresh IV each time", () => {
    const a = encryptSecret(secret, key);
    const b = encryptSecret(secret, key);
    expect(a).not.toBe(b);
    expect(a).not.toContain(secret);
    expect(decryptSecret(a, key)).toBe(secret);
    expect(decryptSecret(b, key)).toBe(secret);
    expect(decryptSecret(encryptSecret("", key), key)).toBe("");
  });

  test("a tampered middle byte of the ciphertext fails", () => {
    const enc = encryptSecret(secret, key);
    const len = Buffer.from(enc, "base64").length;
    const middle = IV_BYTES + Math.floor((len - IV_BYTES - TAG_BYTES) / 2);
    expect(() => decryptSecret(tamperByte(enc, middle), key)).toThrow(/auth tag/);
  });

  test("a tampered IV byte or auth-tag byte fails", () => {
    const enc = encryptSecret(secret, key);
    const len = Buffer.from(enc, "base64").length;
    expect(() => decryptSecret(tamperByte(enc, Math.floor(IV_BYTES / 2)), key)).toThrow();
    expect(() => decryptSecret(tamperByte(enc, len - Math.floor(TAG_BYTES / 2)), key)).toThrow();
  });

  test("the wrong key fails, and a short payload or key is refused", () => {
    const enc = encryptSecret(secret, key);
    expect(() => decryptSecret(enc, randomBytes(32))).toThrow();
    expect(() => decryptSecret(Buffer.alloc(10).toString("base64"), key)).toThrow(/too short/);
    expect(() => encryptSecret(secret, randomBytes(16))).toThrow(/32 bytes/);
  });
});

describe("key resolution", () => {
  test("AGENT_FS_SECRETS_KEY (base64 or hex) wins", () => {
    const k = randomBytes(32);
    process.env.AGENT_FS_SECRETS_KEY = k.toString("base64");
    expect(resolveEncryptionKey(join(home, "agent-fs.db")).equals(k)).toBe(true);

    __resetEncryptionKeyForTests();
    process.env.AGENT_FS_SECRETS_KEY = k.toString("hex");
    expect(resolveEncryptionKey(":memory:").equals(k)).toBe(true);
    expect(existsSync(join(home, ".secrets-key"))).toBe(false);
  });

  test("AGENT_FS_SECRETS_KEY_FILE is read", () => {
    const k = randomBytes(32);
    const file = join(home, "custom.key");
    writeFileSync(file, k.toString("base64") + "\n");
    process.env.AGENT_FS_SECRETS_KEY_FILE = file;
    expect(resolveEncryptionKey(join(home, "agent-fs.db")).equals(k)).toBe(true);

    __resetEncryptionKeyForTests();
    process.env.AGENT_FS_SECRETS_KEY_FILE = join(home, "missing.key");
    expect(() => resolveEncryptionKey(join(home, "agent-fs.db"))).toThrow(/does not exist/);
  });

  test("a malformed key throws instead of falling through to auto-generate", () => {
    process.env.AGENT_FS_SECRETS_KEY = randomBytes(39).toString("base64");
    expect(() => resolveEncryptionKey(join(home, "agent-fs.db"))).toThrow(/expected 32 bytes/);
    expect(existsSync(join(home, ".secrets-key"))).toBe(false);
  });

  test("an existing $AGENT_FS_HOME/.secrets-key is read", () => {
    const k = randomBytes(32);
    writeFileSync(join(home, ".secrets-key"), k.toString("base64"));
    const { db } = createTestContext();
    expect(getWebhookSecretKey(db).equals(k)).toBe(true);
  });

  test("auto-generates $AGENT_FS_HOME/.secrets-key with mode 0600 and caches it", () => {
    const { db } = createTestContext();
    const k = getWebhookSecretKey(db);
    const file = join(home, ".secrets-key");
    expect(k.length).toBe(32);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(Buffer.from(readFileSync(file, "utf8"), "base64").equals(k)).toBe(true);
    // Cached: deleting the file does not change the key in this process.
    rmSync(file);
    expect(getWebhookSecretKey(db).equals(k)).toBe(true);
    // After a reset, the same file content resolves to the same key.
    __resetEncryptionKeyForTests();
    writeFileSync(file, k.toString("base64"));
    expect(getWebhookSecretKey(db).equals(k)).toBe(true);
  });

  test("refuses to generate a key when subscription rows already exist", () => {
    const { db, userId, orgId } = createTestContext();
    const now = Date.now();
    db.$client
      .prepare(
        "INSERT INTO webhook_subscriptions (id, org_id, url, event_types, secret_ciphertext, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
      )
      .run("s1", orgId, "https://hooks.example.com", '["comment.created"]', "ct", userId, now, now);

    expect(() => getWebhookSecretKey(db)).toThrow(/Refusing to auto-generate/);
    expect(existsSync(join(home, ".secrets-key"))).toBe(false);
  });

  test("an in-memory DB path requires an explicit env key", () => {
    expect(() => resolveEncryptionKey(":memory:")).toThrow(/In-memory database requires/);
  });
});
