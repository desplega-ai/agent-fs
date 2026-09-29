import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import type { OpContext } from "./types.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getS3Key } from "./versioning.js";
import { assertPathInsideDrive, normalizePath } from "./paths.js";
import { NotFoundError, PermissionDeniedError, ValidationError } from "../errors.js";
import { getUserDriveRole, getUserOrgRole } from "../identity/rbac.js";

/** Default lifetime of a share link: 24 hours. */
export const SHARE_DEFAULT_TTL_SECONDS = 86_400;
/** Longest a share link may live: 7 days. */
export const SHARE_MAX_TTL_SECONDS = 604_800;
/**
 * How long a view-limited link's file bytes (`/share/:token/raw`, `/download`)
 * stay reachable for the page view that was counted. The page has to be able
 * to load its embed and Download button after it spent the view, but the
 * credential for that is issued with the view, so a spent token cannot fetch
 * bytes on its own. Capped to the share's own remaining lifetime.
 */
export const SHARE_VIEW_GRANT_TTL_SECONDS = 3_600;

/** 32 random bytes → 256 bits of entropy, base64url → 43 chars. */
const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function generateShareToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Cheap shape check so junk paths never reach the database. */
export function isWellFormedShareToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/** SHA-256 hex of the token. This is the only form that is ever stored. */
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Accept a bare token or a full share URL (`https://host/share/<token>?x=1`)
 * and return the token, or null when the input is not a well-formed token.
 */
export function extractShareToken(input: string): string | null {
  const trimmed = input.trim();
  const match = /\/share\/([^/?#]+)/.exec(trimmed);
  const candidate = match ? match[1] : trimmed;
  return isWellFormedShareToken(candidate) ? candidate : null;
}

export interface ShareRecord {
  id: string;
  orgId: string;
  driveId: string;
  path: string;
  expiresAt: Date;
  maxViews: number | null;
  views: number;
  lastViewedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export type ShareState = "active" | "revoked" | "expired" | "exhausted";

function toRecord(row: typeof schema.shares.$inferSelect): ShareRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    driveId: row.driveId,
    path: row.path,
    expiresAt: row.expiresAt,
    maxViews: row.maxViews,
    views: row.views,
    lastViewedAt: row.lastViewedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}

export function findShareByToken(db: DB, token: string): ShareRecord | null {
  if (!isWellFormedShareToken(token)) return null;
  const row = db
    .select()
    .from(schema.shares)
    .where(eq(schema.shares.tokenHash, hashShareToken(token)))
    .get();
  return row ? toRecord(row) : null;
}

/** Why a share can or cannot be opened right now. Read-only; never counts a view. */
export function getShareState(share: ShareRecord, now: Date = new Date()): ShareState {
  if (share.revokedAt) return "revoked";
  if (share.expiresAt.getTime() <= now.getTime()) return "expired";
  if (share.maxViews !== null && share.views >= share.maxViews) return "exhausted";
  return "active";
}

/**
 * Atomically spend one view. The revoked / expired / view-limit guards live in
 * the same UPDATE as the increment, so two concurrent requests can never both
 * take the last view and a revoke can never lose a race against a view.
 *
 * Note `max_views IS NULL OR views < max_views`: an unlimited link has a NULL
 * limit, and `views < NULL` is never true.
 *
 * `now` must be the time of THIS call, not one captured before an await: the
 * `expires_at > now` guard is only as fresh as the value passed in.
 *
 * Returns the share with its updated counters, or null when the link cannot be
 * opened (unknown, revoked, expired or used up).
 */
export function consumeShareView(
  db: DB | Tx,
  token: string,
  now: Date = new Date()
): ShareRecord | null {
  if (!isWellFormedShareToken(token)) return null;
  const row = db
    .update(schema.shares)
    .set({ views: sql`${schema.shares.views} + 1`, lastViewedAt: now })
    .where(
      and(
        eq(schema.shares.tokenHash, hashShareToken(token)),
        isNull(schema.shares.revokedAt),
        gt(schema.shares.expiresAt, now),
        or(
          isNull(schema.shares.maxViews),
          lt(schema.shares.views, schema.shares.maxViews)
        )
      )
    )
    .returning()
    .get();
  return row ? toRecord(row) : null;
}

/** A drizzle transaction handle: the same query builder as {@link DB}. */
type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

export interface ShareViewGrant {
  /** Bearer credential for the byte routes. Shown once; only its hash is stored. */
  token: string;
  expiresAt: Date;
}

export interface OpenedShareView {
  share: ShareRecord;
  /** Set for view-limited links only; unlimited links need no grant. */
  grant: ShareViewGrant | null;
}

/**
 * Spend one view and, for a view-limited link, mint the grant that this view's
 * page uses to fetch the file bytes. Both happen in one transaction, so a
 * counted view always has its grant and a refused view never has one.
 *
 * The grant expires at the earlier of `SHARE_VIEW_GRANT_TTL_SECONDS` from now
 * and the share's own expiry. Expired grants are purged here, so the table
 * stays bounded by the views handed out in the last hour.
 */
export function openShareView(
  db: DB,
  token: string,
  now: Date = new Date()
): OpenedShareView | null {
  return db.transaction((tx) => {
    const share = consumeShareView(tx, token, now);
    if (!share) return null;

    tx.delete(schema.shareViewGrants).where(lte(schema.shareViewGrants.expiresAt, now)).run();
    if (share.maxViews === null) return { share, grant: null };

    // Second precision, like every timestamp column here. Rounding down can only
    // shorten the grant.
    const nowSeconds = Math.floor(now.getTime() / 1000) * 1000;
    const expiresAt = new Date(
      Math.min(nowSeconds + SHARE_VIEW_GRANT_TTL_SECONDS * 1000, share.expiresAt.getTime())
    );
    const grantToken = generateShareToken();
    tx.insert(schema.shareViewGrants)
      .values({
        grantHash: hashShareToken(grantToken),
        shareId: share.id,
        expiresAt,
        createdAt: now,
      })
      .run();
    return { share, grant: { token: grantToken, expiresAt } };
  });
}

export type ShareByteAccess =
  | { ok: true; share: ShareRecord }
  | { ok: false; reason: "not_found" | "gone" | "grant_required" };

/**
 * May the file bytes of this share be fetched right now? Read-only.
 *
 * - unlimited link: the token is enough while the link is active. It already
 *   opens the page as often as its holder likes, so bytes add no new exposure.
 * - view-limited link: the token is NOT enough. The request must carry the
 *   grant issued with a counted view of this very share, unexpired. A used-up
 *   link therefore never serves bytes to anyone who only holds the token, and
 *   an unspent one serves them only to a client that opened a view.
 *
 * A revoked or expired share refuses everything, grant or not. `now` must be
 * the time of this call.
 */
export function authorizeShareBytes(
  db: DB,
  token: string,
  grant: string | null | undefined,
  now: Date = new Date()
): ShareByteAccess {
  const share = findShareByToken(db, token);
  if (!share) return { ok: false, reason: "not_found" };

  const state = getShareState(share, now);
  if (state === "revoked" || state === "expired") return { ok: false, reason: "gone" };
  if (share.maxViews === null) return { ok: true, share };

  const denied = state === "exhausted" ? "gone" : "grant_required";
  if (!grant || !isWellFormedShareToken(grant)) return { ok: false, reason: denied };

  const row = db
    .select({ shareId: schema.shareViewGrants.shareId })
    .from(schema.shareViewGrants)
    .where(
      and(
        eq(schema.shareViewGrants.grantHash, hashShareToken(grant)),
        eq(schema.shareViewGrants.shareId, share.id),
        gt(schema.shareViewGrants.expiresAt, now)
      )
    )
    .get();
  return row ? { ok: true, share } : { ok: false, reason: denied };
}

/**
 * How many seconds a presigned URL for this share may live: `capSeconds`, or
 * what is left of the share, whichever is shorter. No floor above the
 * remaining time, so a URL never outlives the link it was issued for. Returns
 * null once less than a second is left: nothing should be issued then.
 *
 * `at` must be the moment of issuing, not a timestamp taken before an await.
 */
export function capUrlTtlSeconds(
  share: ShareRecord,
  capSeconds: number,
  at: Date = new Date()
): number | null {
  const remaining = Math.floor((share.expiresAt.getTime() - at.getTime()) / 1000);
  const ttl = Math.min(capSeconds, remaining);
  return ttl >= 1 ? ttl : null;
}

/**
 * When a SigV4 presigned URL stops working: the signing time plus the lifetime,
 * both read off its query. Null when the URL carries either in a form that
 * cannot be read, so the deadline cannot be proven.
 */
export function presignedUrlDeadline(url: string): Date | null {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return null;
  }
  const signed = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(params.get("X-Amz-Date") ?? "");
  const lifetime = params.get("X-Amz-Expires");
  if (!signed || lifetime === null || !/^\d+$/.test(lifetime)) return null;
  const [year, month, day, hour, minute, second] = signed.slice(1).map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) + Number(lifetime) * 1000);
}

/**
 * Presign a share's file so the URL cannot outlive the share. Signing is
 * asynchronous and a signer stamps the URL with the time it gets to it, so a
 * TTL sized from the clock before the await can run past the share by however
 * long signing took. One reading of the clock therefore fixes both the TTL and
 * the signing timestamp handed to the signer: the URL then dies at
 * `signedAt + ttl <= expiresAt`, whatever the latency.
 *
 * The deadline is then read back off the URL and the URL is withheld unless it
 * is provably within the share's expiry, so a signer that ignores the pinned
 * timestamp fails closed. Null means nothing may be released: no time left, or
 * no proof. The caller still has to authorize again after this returns, since
 * a revoke can land while signing.
 */
export async function presignShareUrl(
  storage: StorageAdapter,
  share: ShareRecord,
  key: string,
  opts: { capSeconds: number; contentType?: string; disposition?: string }
): Promise<string | null> {
  const signedAt = new Date();
  const ttl = capUrlTtlSeconds(share, opts.capSeconds, signedAt);
  if (ttl === null) return null;
  const url = await storage.getPresignedUrl(key, ttl, opts.contentType, opts.disposition, signedAt);
  const deadline = presignedUrlDeadline(url);
  if (!deadline || deadline.getTime() > share.expiresAt.getTime()) return null;
  return url;
}

/**
 * Storage key of a share's file, or null when the stored path is not one the
 * share op would have accepted. The public routes build every key through
 * this, so a row that got in some other way can never be turned into a read
 * outside the drive it names.
 */
export function shareStorageKey(share: ShareRecord): string | null {
  try {
    assertPathInsideDrive(share.path);
  } catch {
    return null;
  }
  return getS3Key(share.orgId, share.driveId, share.path);
}

/**
 * Audit trail: one `share_viewed` event per counted view. The viewer is
 * anonymous, so the event is attributed to the user who minted the link and
 * flagged `anonymous`. Best effort: a failure here must never block the view.
 */
export function recordShareViewed(db: DB, share: ShareRecord): void {
  try {
    db.insert(schema.events)
      .values({
        id: crypto.randomUUID(),
        orgId: share.orgId,
        type: "share_viewed",
        resourceType: "share",
        resourceId: share.id,
        actor: share.createdBy,
        target: null,
        status: "created",
        metadata: JSON.stringify({
          anonymous: true,
          path: share.path,
          driveId: share.driveId,
          viewNumber: share.views,
        }),
        createdAt: new Date(),
      })
      .run();
  } catch (err) {
    console.warn("share_viewed event not recorded:", err);
  }
}

// --- share-create ---

export interface ShareCreateParams {
  path: string;
  expiresIn?: number;
  maxViews?: number;
}

export interface ShareCreateResult {
  id: string;
  /**
   * Public link. Absolute when the server knows its own public address
   * (`AGENT_FS_PUBLIC_URL`, or derived from the request), otherwise the same
   * as `sharePath` and the client must resolve it against the API endpoint.
   */
  url: string;
  /** Host-relative link, always `/share/<token>`. */
  sharePath: string;
  path: string;
  expiresIn: number;
  expiresAt: string;
  /** `null` = unlimited; `1` = one-off. */
  maxViews: number | null;
}

export async function shareCreate(
  ctx: OpContext,
  params: ShareCreateParams
): Promise<ShareCreateResult> {
  const normalizedPath = normalizePath(params.path);
  // Before storage is touched and before anything is stored: a public link must
  // not be able to name a file outside the drive the caller is authorized for.
  assertPathInsideDrive(normalizedPath);
  const key = getS3Key(ctx.orgId, ctx.driveId, normalizedPath);

  // Only mint links for files that exist right now.
  try {
    await ctx.s3.headObject(key);
  } catch (err: any) {
    if (err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
      throw new NotFoundError(`File not found: ${normalizedPath}`, { path: normalizedPath });
    }
    throw err;
  }

  const expiresIn = params.expiresIn ?? SHARE_DEFAULT_TTL_SECONDS;
  const token = generateShareToken();
  const now = new Date();
  // Stored at second precision, so build the response from the same value.
  const expiresAt = new Date(Math.floor(now.getTime() / 1000) * 1000 + expiresIn * 1000);
  const id = crypto.randomUUID();

  // Org, drive and path are pinned here and never re-resolved from the request
  // when the link is opened.
  ctx.db
    .insert(schema.shares)
    .values({
      id,
      orgId: ctx.orgId,
      driveId: ctx.driveId,
      path: normalizedPath,
      tokenHash: hashShareToken(token),
      expiresAt,
      maxViews: params.maxViews ?? null,
      views: 0,
      createdBy: ctx.userId,
      createdAt: now,
    })
    .run();

  const sharePath = `/share/${token}`;
  return {
    id,
    url: ctx.apiUrl ? `${ctx.apiUrl.replace(/\/+$/, "")}${sharePath}` : sharePath,
    sharePath,
    path: normalizedPath,
    expiresIn,
    expiresAt: expiresAt.toISOString(),
    maxViews: params.maxViews ?? null,
  };
}

// --- share-revoke ---

export interface ShareRevokeParams {
  id?: string;
  token?: string;
  path?: string;
}

export interface ShareRevokeResult {
  revoked: number;
  ids: string[];
}

export async function shareRevoke(
  ctx: OpContext,
  params: ShareRevokeParams
): Promise<ShareRevokeResult> {
  const given = [params.id, params.token, params.path].filter((v) => v !== undefined);
  if (given.length !== 1) {
    throw new ValidationError("Provide exactly one of: id, token (or the share URL), path", {
      suggestion: "Use the id or url returned by share-create, or a file path to revoke all of its links",
    });
  }

  let rows: Array<typeof schema.shares.$inferSelect>;
  if (params.id !== undefined) {
    rows = ctx.db.select().from(schema.shares)
      .where(and(eq(schema.shares.id, params.id), eq(schema.shares.driveId, ctx.driveId)))
      .all();
  } else if (params.token !== undefined) {
    const token = extractShareToken(params.token);
    if (!token) {
      throw new ValidationError("Not a valid share token or share URL", { field: "token" });
    }
    rows = ctx.db.select().from(schema.shares)
      .where(and(eq(schema.shares.tokenHash, hashShareToken(token)), eq(schema.shares.driveId, ctx.driveId)))
      .all();
  } else {
    rows = ctx.db.select().from(schema.shares)
      .where(and(eq(schema.shares.path, normalizePath(params.path!)), eq(schema.shares.driveId, ctx.driveId)))
      .all();
  }

  // A share of another drive is indistinguishable from one that does not exist.
  if (rows.length === 0) {
    throw new NotFoundError("Share link not found");
  }

  // The creator can always revoke their own links; drive and org admins can
  // revoke any link in the drive.
  const isAdmin =
    getUserDriveRole(ctx.db, ctx.userId, ctx.driveId) === "admin" ||
    getUserOrgRole(ctx.db, ctx.userId, ctx.orgId) === "admin";
  const allowed = rows.filter((r) => isAdmin || r.createdBy === ctx.userId);
  if (allowed.length === 0) {
    throw new PermissionDeniedError(
      "Only the person who created a share link, or a drive admin, can revoke it",
      { suggestion: "Ask the link's creator or a drive admin to revoke it" }
    );
  }

  const ids: string[] = [];
  const now = new Date();
  for (const row of allowed) {
    if (row.revokedAt) continue;
    // Re-check `revoked_at IS NULL` so a concurrent revoke is not counted twice.
    const updated = ctx.db
      .update(schema.shares)
      .set({ revokedAt: now })
      .where(and(eq(schema.shares.id, row.id), isNull(schema.shares.revokedAt)))
      .returning({ id: schema.shares.id })
      .get();
    if (updated) ids.push(updated.id);
  }

  return { revoked: ids.length, ids };
}
