// Standard Webhooks (https://www.standardwebhooks.com/) symmetric signing.
//
// decodeWebhookSecret and verifyWebhookSignature are copied from
// desplega-ai/agent-swarm src/workflows/triggers.ts @ 2858e0940
// (decodeStandardWebhookSecret, verifyStandardWebhookSignature), renamed only.
// signWebhook is the sender-side mirror of that verifier.

import crypto from "node:crypto";

export const WEBHOOK_SECRET_PREFIX = "whsec_";
const STANDARD_WEBHOOK_SECRET_PREFIX = WEBHOOK_SECRET_PREFIX;

/** A new signing secret: `whsec_` + base64 of 32 random bytes. */
export function generateWebhookSecret(): string {
  return WEBHOOK_SECRET_PREFIX + crypto.randomBytes(32).toString("base64");
}

/**
 * Decode a Standard Webhooks signing secret: strip an optional `whsec_` prefix,
 * then base64-decode. Returns null when the remainder is not valid, non-empty
 * base64 — a misconfigured secret must fail closed, not sign with garbage bytes.
 */
export function decodeWebhookSecret(secret: string): Buffer | null {
  const encoded = secret.startsWith(STANDARD_WEBHOOK_SECRET_PREFIX)
    ? secret.slice(STANDARD_WEBHOOK_SECRET_PREFIX.length)
    : secret;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    return null;
  }
  const key = Buffer.from(encoded, "base64");
  return key.length > 0 ? key : null;
}

/**
 * Sign one delivery. Returns the `webhook-signature` header value,
 * `v1,<base64 HMAC-SHA256(key, "{id}.{timestampSec}.{body}")>`, where `key` is
 * the base64-decoded secret after `whsec_`. Throws on an undecodable secret.
 */
export function signWebhook(
  secret: string,
  id: string,
  timestampSec: number,
  body: string,
): string {
  const key = decodeWebhookSecret(secret);
  if (!key) {
    throw new Error("signWebhook: secret is not a valid whsec_<base64> value");
  }
  if (!Number.isSafeInteger(timestampSec) || timestampSec < 0) {
    throw new Error("signWebhook: timestampSec must be a non-negative integer (unix seconds)");
  }
  const digest = crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestampSec}.${body}`)
    .digest("base64");
  return `v1,${digest}`;
}

/**
 * Verify a Standard Webhooks (https://www.standardwebhooks.com/) symmetric
 * signature. Signed content is `{webhook-id}.{webhook-timestamp}.{raw body}`,
 * HMAC-SHA256 keyed with the decoded secret. `webhook-signature` is a
 * space-delimited list of `<version>,<base64>` entries; any matching `v1` entry
 * passes (secret rotation), other versions (e.g. asymmetric `v1a`) are skipped.
 */
export function verifyWebhookSignature(
  key: Buffer,
  body: string,
  headers: { id: string; timestamp: string; signature: string },
  opts: { toleranceSeconds?: number } = {},
  nowMs = Date.now(),
): boolean {
  const toleranceSeconds = opts.toleranceSeconds ?? 300;
  if (!/^\d+$/.test(headers.timestamp)) {
    return false;
  }
  const timestampSeconds = Number(headers.timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) {
    return false;
  }
  if (Math.abs(nowMs / 1000 - timestampSeconds) > toleranceSeconds) {
    return false;
  }

  const expected = Buffer.from(
    crypto
      .createHmac("sha256", key)
      .update(`${headers.id}.${headers.timestamp}.${body}`)
      .digest("base64"),
  );

  return headers.signature.split(" ").some((entry) => {
    const separatorIndex = entry.indexOf(",");
    if (separatorIndex <= 0 || entry.slice(0, separatorIndex) !== "v1") return false;
    const provided = Buffer.from(entry.slice(separatorIndex + 1));
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  });
}
