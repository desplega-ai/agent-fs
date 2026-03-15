import { eq, and } from "drizzle-orm";
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
