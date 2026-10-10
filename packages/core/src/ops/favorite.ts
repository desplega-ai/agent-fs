import { and, eq, inArray, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type {
  OpContext,
  Favorite,
  FavoriteAddParams,
  FavoriteAddResult,
  FavoriteListParams,
  FavoriteListResult,
  FavoriteRemoveParams,
  FavoriteRemoveResult,
} from "./types.js";
import { assertPathInsideDrive, normalizePath } from "./paths.js";
import { resolvePathKind } from "./path-kind.js";
import { NotFoundError, ValidationError } from "../errors.js";

/**
 * Favorites are per user: every query here is scoped to `ctx.userId`, which the
 * server takes from the authenticated session. No op accepts a user id.
 *
 * Lifecycle, kept in step by rm and mv (see {@link favoritesAfterRemove} and
 * {@link favoritesAfterMove}):
 *   - moving or renaming a file moves every user's star with it;
 *   - deleting a file drops every user's star on it;
 *   - a folder star is dropped once the folder is gone (its last file was
 *     deleted or moved out). Folders have no move op of their own.
 */

function toFavorite(row: typeof schema.favorites.$inferSelect): Favorite {
  return { path: row.path, kind: row.kind, createdAt: row.createdAt.toISOString() };
}

export async function favoriteAdd(
  ctx: OpContext,
  params: FavoriteAddParams
): Promise<FavoriteAddResult> {
  const path = normalizePath(params.path);
  assertPathInsideDrive(path);
  if (path === "/") {
    throw new ValidationError("The drive root cannot be a favorite", { field: "path" });
  }

  const kind = await resolvePathKind(ctx, path);
  if (!kind) {
    throw new NotFoundError(`File or folder not found: ${path}`, { path });
  }

  // Starring twice keeps the first star (and its createdAt).
  ctx.db
    .insert(schema.favorites)
    .values({ userId: ctx.userId, driveId: ctx.driveId, path, kind, createdAt: new Date() })
    .onConflictDoUpdate({
      target: [schema.favorites.userId, schema.favorites.driveId, schema.favorites.path],
      set: { kind },
    })
    .run();

  const row = ctx.db
    .select()
    .from(schema.favorites)
    .where(
      and(
        eq(schema.favorites.userId, ctx.userId),
        eq(schema.favorites.driveId, ctx.driveId),
        eq(schema.favorites.path, path)
      )
    )
    .get()!;
  return { ...toFavorite(row), favorited: true };
}

export async function favoriteRemove(
  ctx: OpContext,
  params: FavoriteRemoveParams
): Promise<FavoriteRemoveResult> {
  // No existence check: a star on something that is gone must still be removable.
  const path = normalizePath(params.path);
  const removed = ctx.db
    .delete(schema.favorites)
    .where(
      and(
        eq(schema.favorites.userId, ctx.userId),
        eq(schema.favorites.driveId, ctx.driveId),
        eq(schema.favorites.path, path)
      )
    )
    .returning({ path: schema.favorites.path })
    .all();
  return { path, removed: removed.length > 0 };
}

export async function favoriteList(
  ctx: OpContext,
  _params: FavoriteListParams
): Promise<FavoriteListResult> {
  const rows = ctx.db
    .select()
    .from(schema.favorites)
    .where(
      and(
        eq(schema.favorites.userId, ctx.userId),
        eq(schema.favorites.driveId, ctx.driveId)
      )
    )
    .orderBy(schema.favorites.path)
    .all();
  return { favorites: rows.map(toFavorite) };
}

/** Folders above `path`, deepest first: `/a/b/c.md` → `/a/b`, `/a`. */
function ancestorFolders(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = parts.length - 1; i > 0; i--) {
    out.push("/" + parts.slice(0, i).join("/"));
  }
  return out;
}

/**
 * Drop folder stars above `path` whose folder no longer exists. Best effort:
 * the file op already succeeded, so a storage error here leaves the star in
 * place rather than failing the rm or mv.
 */
async function dropVanishedFolders(ctx: OpContext, path: string): Promise<void> {
  const ancestors = ancestorFolders(path);
  if (ancestors.length === 0) return;
  const starred = ctx.db
    .selectDistinct({ path: schema.favorites.path })
    .from(schema.favorites)
    .where(
      and(
        eq(schema.favorites.driveId, ctx.driveId),
        eq(schema.favorites.kind, "directory"),
        inArray(schema.favorites.path, ancestors)
      )
    )
    .all();
  for (const { path: folder } of starred) {
    try {
      if ((await resolvePathKind(ctx, folder)) === "directory") continue;
    } catch {
      continue;
    }
    ctx.db
      .delete(schema.favorites)
      .where(
        and(
          eq(schema.favorites.driveId, ctx.driveId),
          eq(schema.favorites.path, folder),
          eq(schema.favorites.kind, "directory")
        )
      )
      .run();
  }
}

/** Called by rm: the file at `path` is gone for every user. */
export async function favoritesAfterRemove(ctx: OpContext, path: string): Promise<void> {
  ctx.db
    .delete(schema.favorites)
    .where(
      and(
        eq(schema.favorites.driveId, ctx.driveId),
        eq(schema.favorites.path, path),
        eq(schema.favorites.kind, "file")
      )
    )
    .run();
  await dropVanishedFolders(ctx, path);
}

/** Called by mv: every user's star on the file at `from` moves to `to`. */
export async function favoritesAfterMove(ctx: OpContext, from: string, to: string): Promise<void> {
  const f = schema.favorites;
  // A user who had already starred `to` keeps that one star.
  ctx.db
    .delete(f)
    .where(
      and(
        eq(f.driveId, ctx.driveId),
        eq(f.path, from),
        eq(f.kind, "file"),
        sql`${f.userId} IN (SELECT user_id FROM favorites WHERE drive_id = ${ctx.driveId} AND path = ${to})`
      )
    )
    .run();
  ctx.db
    .update(f)
    .set({ path: to })
    .where(and(eq(f.driveId, ctx.driveId), eq(f.path, from), eq(f.kind, "file")))
    .run();
  await dropVanishedFolders(ctx, from);
}
