import { eq } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import { createDrive } from "./drives.js";

export function createOrg(
  db: DB,
  params: { name: string; userId: string; isPersonal?: boolean }
): { id: string; name: string } {
  const id = crypto.randomUUID();
  const now = new Date();

  db.insert(schema.orgs)
    .values({
      id,
      name: params.name,
      isPersonal: params.isPersonal ?? false,
      createdAt: now,
    })
    .run();

  // Add creator as admin
  db.insert(schema.orgMembers)
    .values({ orgId: id, userId: params.userId, role: "admin" })
    .run();

  // Create default drive and add creator as admin
  const drive = createDrive(db, { orgId: id, name: "default", isDefault: true });

  db.insert(schema.driveMembers)
    .values({ driveId: drive.id, userId: params.userId, role: "admin" })
    .run();

  return { id, name: params.name };
}

export function listUserOrgs(
  db: DB,
  userId: string
): Array<{ id: string; name: string; role: string; isPersonal: boolean }> {
  const memberships = db
    .select({
      orgId: schema.orgMembers.orgId,
      role: schema.orgMembers.role,
      name: schema.orgs.name,
      isPersonal: schema.orgs.isPersonal,
    })
    .from(schema.orgMembers)
    .innerJoin(schema.orgs, eq(schema.orgMembers.orgId, schema.orgs.id))
    .where(eq(schema.orgMembers.userId, userId))
    .all();

  return memberships.map((m) => ({
    id: m.orgId,
    name: m.name,
    role: m.role,
    isPersonal: m.isPersonal,
  }));
}

export function getOrg(
  db: DB,
  orgId: string
): { id: string; name: string; isPersonal: boolean } | null {
  const org = db
    .select()
    .from(schema.orgs)
    .where(eq(schema.orgs.id, orgId))
    .get();

  if (!org) return null;
  return { id: org.id, name: org.name, isPersonal: org.isPersonal };
}

export function inviteToOrg(
  db: DB,
  params: { orgId: string; email: string; role: "viewer" | "editor" | "admin" }
): void {
  // Find or fail — user must exist
  const user = db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, params.email))
    .get();

  if (!user) {
    throw new Error(`User with email ${params.email} not found`);
  }

  db.insert(schema.orgMembers)
    .values({ orgId: params.orgId, userId: user.id, role: params.role })
    .onConflictDoUpdate({
      target: [schema.orgMembers.orgId, schema.orgMembers.userId],
      set: { role: params.role },
    })
    .run();

  // Also give access to default drive with same role
  const defaultDrive = db
    .select()
    .from(schema.drives)
    .where(eq(schema.drives.orgId, params.orgId))
    .get();

  if (defaultDrive) {
    db.insert(schema.driveMembers)
      .values({
        driveId: defaultDrive.id,
        userId: user.id,
        role: params.role,
      })
      .onConflictDoUpdate({
        target: [schema.driveMembers.driveId, schema.driveMembers.userId],
        set: { role: params.role },
      })
      .run();
  }
}
