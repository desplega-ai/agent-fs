import { eq, and, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";

export function createDrive(
  db: DB,
  params: { orgId: string; name: string; isDefault?: boolean }
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

export function updateDriveMemberRole(
  db: DB,
  params: { driveId: string; userId: string; role: "viewer" | "editor" | "admin" }
): void {
  const existing = db
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

  db.update(schema.driveMembers)
    .set({ role: params.role })
    .where(
      and(
        eq(schema.driveMembers.driveId, params.driveId),
        eq(schema.driveMembers.userId, params.userId)
      )
    )
    .run();
}

export function removeDriveMember(
  db: DB,
  params: { driveId: string; userId: string }
): void {
  const existing = db
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

  db.delete(schema.driveMembers)
    .where(
      and(
        eq(schema.driveMembers.driveId, params.driveId),
        eq(schema.driveMembers.userId, params.userId)
      )
    )
    .run();
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
