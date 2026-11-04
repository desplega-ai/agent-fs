import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The guest of a writable share: a self-reported name and email, remembered
 * in a cookie signed with that share's `guest_secret`. Nothing is looked up by
 * email: a guest is never a user. Revoking the share clears the secret, so
 * every cookie of it stops verifying.
 */
export const GUEST_COOKIE = "afs_guest";
export const GUEST_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
/**
 * Largest cookie issued or accepted. Every name and email `parseGuest` accepts
 * fits: 80 four-byte characters and a 254-character email, base64url-encoded.
 */
export const GUEST_COOKIE_MAX_BYTES = 2048;
const MAX_NAME = 80;
const MAX_EMAIL = 254;
// Syntax only: one @, no spaces, brackets or quotes, a dot in the domain.
const EMAIL_RE = /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[^\s@<>()[\]",;:\\]+$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export interface Guest {
  name: string;
  email: string;
}

export interface GuestClaims extends Guest {
  v: 1;
  /** Random id that correlates one browser's writes. */
  gid: string;
  /** Id of the share the cookie was issued for. */
  share: string;
  /** Unix seconds. */
  iat: number;
  exp: number;
}

interface CookieShare {
  id: string;
  guestSecret: string | null;
}

/** The trimmed name and email, or the reason they are refused. */
export function parseGuest(body: unknown): Guest | string {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const email = typeof b.email === "string" ? b.email.trim() : "";
  const chars = (v: string) => [...v].length;
  if (chars(name) < 1 || chars(name) > MAX_NAME || CONTROL_RE.test(name)) return `Name must be 1 to ${MAX_NAME} characters`;
  if (chars(email) > MAX_EMAIL || CONTROL_RE.test(email) || !EMAIL_RE.test(email)) return "Enter a valid email address";
  return { name, email };
}

const sign = (payload: string, secret: string) => createHmac("sha256", secret).update(payload).digest();

/** A signed cookie for `guest`, or null when it would be longer than verification accepts. */
export function issueGuestCookie(share: CookieShare, guest: Guest, now = Date.now()): { value: string; claims: GuestClaims } | null {
  if (!share.guestSecret) throw new Error("share has no guest secret");
  const iat = Math.floor(now / 1000);
  const claims: GuestClaims = {
    v: 1,
    gid: randomBytes(16).toString("base64url"),
    name: guest.name,
    email: guest.email,
    share: share.id,
    iat,
    exp: iat + GUEST_COOKIE_MAX_AGE_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const value = `${payload}.${sign(payload, share.guestSecret).toString("base64url")}`;
  return value.length > GUEST_COOKIE_MAX_BYTES ? null : { value, claims };
}

/** The claims of a cookie this share issued and that has not expired, else null. */
export function verifyGuestCookie(value: string | undefined, share: CookieShare, now = Date.now()): GuestClaims | null {
  if (!value || !share.guestSecret || value.length > GUEST_COOKIE_MAX_BYTES) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const expected = sign(payload, share.guestSecret);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let c: Record<string, unknown>;
  try {
    c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const { v, gid, name, email, share: shareId, iat, exp } = c;
  if (v !== 1 || typeof gid !== "string" || typeof shareId !== "string") return null;
  if (typeof name !== "string" || typeof email !== "string") return null;
  if (typeof iat !== "number" || typeof exp !== "number" || !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return null;
  if (shareId !== share.id || exp * 1000 <= now) return null;
  return { v, gid, name, email, share: shareId, iat, exp };
}
