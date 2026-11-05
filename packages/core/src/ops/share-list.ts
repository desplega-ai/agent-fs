import { and, count, desc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { schema } from "../db/index.js";
import type { OpContext } from "./types.js";
import { assertPathInsideDrive, normalizePath } from "./paths.js";
import { buildAppUrl } from "./urls.js";
import { getShareState } from "./share.js";
import type { ShareKind, ShareState } from "./share.js";
import { ValidationError } from "../errors.js";
import { getUserDriveRole, getUserOrgRole } from "../identity/rbac.js";
import { listDrivesForUser } from "../identity/drives.js";

export const SHARE_LIST_DEFAULT_LIMIT = 100;
export const SHARE_LIST_MAX_LIMIT = 500;

export interface ShareListParams {
  /** `drive` (default): links in the active drive. `mine`: the caller's links in every drive of the org they are a member of. */
  scope?: "drive" | "mine";
  /** Drive scope only: links on this file or folder, plus folder (site) links that cover it. */
  path?: string;
  /** Include revoked, expired and used-up links. Default: active links only. */
  includeInactive?: boolean;
  limit?: number;
  offset?: number;
}

export interface ShareListItem {
  id: string;
  drive: { id: string; name: string | null };
  /** The shared file, or for kind `site` the shared folder. */
  path: string;
  kind: ShareKind;
  /** Set only when `path` was given: `exact` for a link on that path, `covering` for a link on a parent folder. */
  relation?: "exact" | "covering";
  status: ShareState;
  createdAt: string;
  createdBy: { userId: string; email: string | null; displayName: string | null };
  /** `null` for a link that never expires. */
  expiresAt: string | null;
  views: number;
  maxViews: number | null;
  lastViewedAt: string | null;
  revokedAt: string | null;
  /** Who revoked the link. `null` while active, and for links revoked before revokers were recorded. */
  revokedBy: { userId: string; email: string | null; displayName: string | null } | null;
  /** Whether share-revoke with this id (on `drive.id`) would succeed for the caller. */
  canRevoke: boolean;
  /** Live app link to the shared file or folder, when the server knows the app address. */
  appUrl?: string;
}

export interface ShareListResult {
  shares: ShareListItem[];
  total: number;
  limit: number;
  offset: number;
  scope: "drive" | "mine";
  /** `all`: every member's links (drive admins). `own`: only the caller's links. */
  visibility: "all" | "own";
}

/** Folders above `path`, nearest first, ending with the drive root. */
function coveringFolders(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = parts.length - 1; i > 0; i--) {
    out.push("/" + parts.slice(0, i).join("/"));
  }
  if (path !== "/") out.push("/");
  return out;
}

/**
 * The same predicate `shareRevoke` uses to let someone revoke links they did
 * not create. Keep the two in step: listing follows revoke authority.
 */
function isShareAdmin(ctx: OpContext): boolean {
  return (
    getUserDriveRole(ctx.db, ctx.userId, ctx.driveId) === "admin" ||
    getUserOrgRole(ctx.db, ctx.userId, ctx.orgId) === "admin"
  );
}

/**
 * List share links without ever exposing the link itself. Only the token's
 * hash is stored and it is never selected here, so nothing in the result can
 * rebuild a /share/ or /site/ URL.
 *
 * Who sees what:
 *   - drive scope: drive admins (and org admins who are drive members) see
 *     every link in the drive; other members see only their own.
 *   - mine scope: the caller's own links in every drive of the current org
 *     where they are a member now. It never spans orgs.
 */
export async function shareList(
  ctx: OpContext,
  params: ShareListParams
): Promise<ShareListResult> {
  const scope = params.scope ?? "drive";
  const limit = params.limit ?? SHARE_LIST_DEFAULT_LIMIT;
  const offset = params.offset ?? 0;
  const s = schema.shares;
  const revoker = alias(schema.users, "revoker");

  let path: string | undefined;
  if (params.path !== undefined) {
    if (scope === "mine") {
      throw new ValidationError("path cannot be combined with scope \"mine\"", {
        field: "path",
        suggestion: "Drop path to list all your links, or use the drive scope to list the links on one path",
      });
    }
    path = normalizePath(params.path);
    assertPathInsideDrive(path);
  }

  const filters: SQL[] = [];
  let visibility: "all" | "own";
  let admin = false;

  if (scope === "mine") {
    visibility = "own";
    const driveIds = listDrivesForUser(ctx.db, ctx.orgId, ctx.userId).map((d) => d.id);
    if (driveIds.length === 0) {
      return { shares: [], total: 0, limit, offset, scope, visibility };
    }
    filters.push(eq(s.orgId, ctx.orgId), eq(s.createdBy, ctx.userId), inArray(s.driveId, driveIds));
  } else {
    admin = isShareAdmin(ctx);
    visibility = admin ? "all" : "own";
    filters.push(eq(s.driveId, ctx.driveId));
    if (!admin) filters.push(eq(s.createdBy, ctx.userId));
    if (path !== undefined) {
      const folders = coveringFolders(path);
      filters.push(
        folders.length > 0
          ? or(eq(s.path, path), and(eq(s.kind, "site"), inArray(s.path, folders)))!
          : eq(s.path, path)
      );
    }
  }

  const now = new Date();
  if (!params.includeInactive) {
    // Same conditions as getShareState's "active", done in SQL so limit,
    // offset and total stay exact.
    filters.push(
      isNull(s.revokedAt),
      gt(s.expiresAt, now),
      or(isNull(s.maxViews), lt(s.views, s.maxViews))!
    );
  }
  const where = and(...filters);

  const total = ctx.db.select({ n: count() }).from(s).where(where).get()?.n ?? 0;

  // Explicit projection: never `select()` the whole row, so token_hash (and
  // any column added later) cannot leak into the result.
  const rows = ctx.db
    .select({
      id: s.id,
      orgId: s.orgId,
      driveId: s.driveId,
      driveName: schema.drives.name,
      path: s.path,
      kind: s.kind,
      expiresAt: s.expiresAt,
      neverExpires: s.neverExpires,
      maxViews: s.maxViews,
      views: s.views,
      lastViewedAt: s.lastViewedAt,
      createdBy: s.createdBy,
      creatorEmail: schema.users.email,
      creatorName: schema.users.displayName,
      createdAt: s.createdAt,
      revokedAt: s.revokedAt,
      revokedBy: s.revokedBy,
      revokerEmail: revoker.email,
      revokerName: revoker.displayName,
    })
    .from(s)
    .leftJoin(schema.drives, eq(schema.drives.id, s.driveId))
    .leftJoin(schema.users, eq(schema.users.id, s.createdBy))
    .leftJoin(revoker, eq(revoker.id, s.revokedBy))
    .where(where)
    .orderBy(desc(s.createdAt), desc(s.id))
    .limit(limit)
    .offset(offset)
    .all();

  const shares = rows.map((row): ShareListItem => {
    const kind: ShareKind = row.kind === "site" ? "site" : "file";
    const status = getShareState({ ...row, kind }, now);
    const item: ShareListItem = {
      id: row.id,
      drive: { id: row.driveId, name: row.driveName ?? null },
      path: row.path,
      kind,
      status,
      createdAt: row.createdAt.toISOString(),
      createdBy: {
        userId: row.createdBy,
        email: row.creatorEmail ?? null,
        displayName: row.creatorName ?? null,
      },
      expiresAt: row.neverExpires ? null : row.expiresAt.toISOString(),
      views: row.views,
      maxViews: row.maxViews,
      lastViewedAt: row.lastViewedAt ? row.lastViewedAt.toISOString() : null,
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      revokedBy: row.revokedBy
        ? { userId: row.revokedBy, email: row.revokerEmail ?? null, displayName: row.revokerName ?? null }
        : null,
      // A revoked link has nothing left to revoke.
      canRevoke: status !== "revoked" && (row.createdBy === ctx.userId || admin),
    };
    if (path !== undefined) item.relation = row.path === path ? "exact" : "covering";
    if (ctx.appUrl) item.appUrl = buildAppUrl(ctx.appUrl, ctx.orgId, row.driveId, row.path);
    return item;
  });

  return { shares, total, limit, offset, scope, visibility };
}
