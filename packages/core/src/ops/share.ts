import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import type { OpContext } from "./types.js";
import { getS3Key } from "./versioning.js";
import { normalizePath } from "./paths.js";
import { NotFoundError, PermissionDeniedError, ValidationError } from "../errors.js";
import { getUserDriveRole, getUserOrgRole } from "../identity/rbac.js";

/** Default lifetime of a share link: 24 hours. */
export const SHARE_DEFAULT_TTL_SECONDS = 86_400;
/** Longest a share link may live: 7 days. */
export const SHARE_MAX_TTL_SECONDS = 604_800;
/**
 * How long the file bytes (`/share/:token/raw`, `/download`) stay reachable
 * after the last counted page view of a view-limited link. The page has to be
 * able to load its embed and Download button after it consumed the view, but a
 * one-off link must not keep serving the bytes until it expires.
 */
export const SHARE_ASSET_GRACE_SECONDS = 3_600;

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
 * Can the file bytes be fetched for this share? Same as an active share, with
 * one difference for view-limited links: the page view has already been spent
 * (so `exhausted` is fine) but the bytes are only served for a short grace
 * window after it, so a one-off link cannot be used as a permanent raw URL.
 */
export function canServeShareAssets(share: ShareRecord, now: Date = new Date()): boolean {
  if (share.revokedAt) return false;
  if (share.expiresAt.getTime() <= now.getTime()) return false;
  if (share.maxViews === null) return true;
  if (!share.lastViewedAt) return false;
  return now.getTime() - share.lastViewedAt.getTime() <= SHARE_ASSET_GRACE_SECONDS * 1000;
}

/**
 * Atomically spend one view. The revoked / expired / view-limit guards live in
 * the same UPDATE as the increment, so two concurrent requests can never both
 * take the last view and a revoke can never lose a race against a view.
 *
 * Note `max_views IS NULL OR views < max_views`: an unlimited link has a NULL
 * limit, and `views < NULL` is never true.
 *
 * Returns the share with its updated counters, or null when the link cannot be
 * opened (unknown, revoked, expired or used up).
 */
export function consumeShareView(
  db: DB,
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
