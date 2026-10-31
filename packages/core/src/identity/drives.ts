import { eq, and, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import { ValidationError } from "../errors.js";
import { getUserOrgRole } from "./rbac.js";
import type { Role } from "./rbac.js";

export function createDrive(
  db: DB,
  params: {
    orgId: string;
    name: string;
    isDefault?: boolean;
    /**
     * When provided, the creator gets an explicit 'admin' drive membership
     * row. Under strict membership (drives are only visible to explicit
     * members) every user-facing creation path should pass this.
     */
    creatorUserId?: string;
  }
): { id: string; name: string } {
  const id = crypto.randomUUID();
  const now = new Date();

  db.insert(schema.drives)
    .values({
      id,
      orgId: params.orgId,
      name: params.name,
      isDefault: params.isDefault ?? false,
      createdAt: now,
    })
    .run();

  if (params.creatorUserId) {
    db.insert(schema.driveMembers)
      .values({ driveId: id, userId: params.creatorUserId, role: "admin" })
      .run();
  }

  return { id, name: params.name };
}

export function listDrives(
  db: DB,
  orgId: string
): Array<{ id: string; name: string; isDefault: boolean }> {
  return db
    .select()
    .from(schema.drives)
    .where(eq(schema.drives.orgId, orgId))
    .all()
    .map((d) => ({ id: d.id, name: d.name, isDefault: d.isDefault }));
}

/**
 * List drives in an org that the user can see.
 *
 * Strict explicit membership: a drive is visible to the user iff the user
 * has a row in `drive_members` for that drive. Drives with zero member
 * rows are visible to NO ONE (the old "public drive" fallback is gone —
 * creation paths add an explicit creator membership, and `runMigrations()`
 * backfills org admins onto pre-existing zero-member drives).
 *
 * The FUSE mount uses this to populate its root readdir without seeing
 * drives it can't access.
 */
export function listDrivesForUser(
  db: DB,
  orgId: string,
  userId: string
): Array<{ id: string; name: string; isDefault: boolean }> {
  return db
    .select({
      id: schema.drives.id,
      name: schema.drives.name,
      isDefault: schema.drives.isDefault,
    })
    .from(schema.drives)
    .innerJoin(
      schema.driveMembers,
      eq(schema.driveMembers.driveId, schema.drives.id)
    )
    .where(
      and(
        eq(schema.drives.orgId, orgId),
        eq(schema.driveMembers.userId, userId)
      )
    )
    .all()
    .map((d) => ({ id: d.id, name: d.name, isDefault: d.isDefault }));
}

/**
 * Drives whose membership `userId` may manage: every drive in the org for an
 * org admin, otherwise the drives where the user is drive admin. `myRole` is
 * the caller's own drive role (null when an org admin is not on the drive).
 */
export function listManageableDrives(
  db: DB,
  orgId: string,
  userId: string
): Array<{ id: string; name: string; isDefault: boolean; myRole: Role | null }> {
  const myRoles = new Map(
    db
      .select({ driveId: schema.driveMembers.driveId, role: schema.driveMembers.role })
      .from(schema.driveMembers)
      .where(eq(schema.driveMembers.userId, userId))
      .all()
      .map((m) => [m.driveId, m.role as Role] as const)
  );
  const orgAdmin = getUserOrgRole(db, userId, orgId) === "admin";
  return listDrives(db, orgId)
    .map((d) => ({ ...d, myRole: myRoles.get(d.id) ?? null }))
    .filter((d) => orgAdmin || d.myRole === "admin");
}

export function getDrive(
  db: DB,
  driveId: string
): { id: string; name: string; orgId: string; isDefault: boolean } | null {
  const drive = db
    .select()
    .from(schema.drives)
    .where(eq(schema.drives.id, driveId))
    .get();

  if (!drive) return null;
  return { id: drive.id, name: drive.name, orgId: drive.orgId, isDefault: drive.isDefault };
}

export function listDriveMembers(
  db: DB,
  driveId: string
): Array<{ userId: string; email: string; role: string }> {
  return db
    .select({
      userId: schema.driveMembers.userId,
      email: schema.users.email,
      role: schema.driveMembers.role,
    })
    .from(schema.driveMembers)
    .innerJoin(schema.users, eq(schema.driveMembers.userId, schema.users.id))
    .where(eq(schema.driveMembers.driveId, driveId))
    .all();
}

export function listDriveMembersPublic(
  db: DB,
  driveId: string
): Array<{ userId: string; email: string; displayName: string | null }> {
  return db
    .select({
      userId: schema.users.id,
      email: schema.users.email,
      displayName: schema.users.displayName,
    })
    .from(schema.driveMembers)
    .innerJoin(schema.users, eq(schema.driveMembers.userId, schema.users.id))
    .where(eq(schema.driveMembers.driveId, driveId))
    .all();
}

/** A drizzle transaction handle: the same query builder as {@link DB}. */
export type DbTx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/**
 * Run `fn` in a write transaction that takes SQLite's write lock up front
 * (`BEGIN IMMEDIATE`). The last-admin checks read before they write, so a plain
 * deferred transaction would let a second connection (another process on the
 * same database file) read the same admin count and then both demote.
 */
export function withWriteLock<T>(db: DB | DbTx, fn: (tx: DbTx) => T): T {
  return (db as DB).transaction((tx) => fn(tx), { behavior: "immediate" });
}

/**
 * Of `driveIds`, the drives where `userId` is the only admin. A drive keeps at
 * least one explicit admin, so these are the drives the member cannot leave.
 */
export function findSoleAdminDrives(
  db: DB | DbTx,
  params: { userId: string; driveIds: string[] }
): Array<{ id: string; name: string }> {
  const blocking: Array<{ id: string; name: string }> = [];
  for (const driveId of params.driveIds) {
    const admins = db
      .select({ userId: schema.driveMembers.userId })
      .from(schema.driveMembers)
      .where(
        and(
          eq(schema.driveMembers.driveId, driveId),
          eq(schema.driveMembers.role, "admin")
        )
      )
      .all();
    if (admins.length === 1 && admins[0].userId === params.userId) {
      const drive = db
        .select({ name: schema.drives.name })
        .from(schema.drives)
        .where(eq(schema.drives.id, driveId))
        .get();
      blocking.push({ id: driveId, name: drive?.name ?? driveId });
    }
  }
  return blocking;
}

/** "work" (drv_1), "docs" (drv_2): names are not unique across orgs, so the id rides along. */
export function describeDrives(drives: Array<{ id: string; name: string }>): string {
  return drives.map((d) => `"${d.name}" (${d.id})`).join(", ");
}

/**
 * Throw when `userId` is the only admin of the drive. A drive keeps at least
 * one explicit admin: demoting or removing the last one is refused so the drive
 * is never left without someone who can manage it.
 */
export function assertNotLastDriveAdmin(
  db: DB | DbTx,
  params: { driveId: string; userId: string; action: "demote" | "remove" }
): void {
  const blocking = findSoleAdminDrives(db, { userId: params.userId, driveIds: [params.driveId] });
  if (blocking.length > 0) {
    throw new ValidationError(
      `Cannot ${params.action} the only admin of drive ${describeDrives(blocking)}`,
      { suggestion: "Make another member an admin of the drive first" }
    );
  }
}

export function updateDriveMemberRole(
  db: DB,
  params: { driveId: string; userId: string; role: "viewer" | "editor" | "admin" }
): void {
  withWriteLock(db, (tx) => {
    const existing = tx
      .select({ role: schema.driveMembers.role })
      .from(schema.driveMembers)
      .where(
        and(
          eq(schema.driveMembers.driveId, params.driveId),
          eq(schema.driveMembers.userId, params.userId)
        )
      )
      .get();

    if (!existing) {
      throw new Error("Member not found in drive");
    }

    if (existing.role === "admin" && params.role !== "admin") {
      assertNotLastDriveAdmin(tx, { ...params, action: "demote" });
    }

    tx.update(schema.driveMembers)
      .set({ role: params.role })
      .where(
        and(
          eq(schema.driveMembers.driveId, params.driveId),
          eq(schema.driveMembers.userId, params.userId)
        )
      )
      .run();
  });
}

export function removeDriveMember(
  db: DB,
  params: { driveId: string; userId: string }
): void {
  withWriteLock(db, (tx) => {
    const existing = tx
      .select({ role: schema.driveMembers.role })
      .from(schema.driveMembers)
      .where(
        and(
          eq(schema.driveMembers.driveId, params.driveId),
          eq(schema.driveMembers.userId, params.userId)
        )
      )
      .get();

    if (!existing) {
      throw new Error("Member not found in drive");
    }

    if (existing.role === "admin") {
      assertNotLastDriveAdmin(tx, { ...params, action: "remove" });
    }

    tx.delete(schema.driveMembers)
      .where(
        and(
          eq(schema.driveMembers.driveId, params.driveId),
          eq(schema.driveMembers.userId, params.userId)
        )
      )
      .run();
  });
}

export function setDriveMember(
  db: DB,
  params: { driveId: string; userId: string; role: "viewer" | "editor" | "admin" }
): void {
  db.insert(schema.driveMembers)
    .values({
      driveId: params.driveId,
      userId: params.userId,
      role: params.role,
    })
    .onConflictDoUpdate({
      target: [schema.driveMembers.driveId, schema.driveMembers.userId],
      set: { role: params.role },
    })
    .run();
}
