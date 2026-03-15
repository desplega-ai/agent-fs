import { eq, and } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import type { Role } from "./rbac.js";
import { getUserDriveRole } from "./rbac.js";

export interface ResolvedContext {
  orgId: string;
  driveId: string;
  role: Role;
}

export function resolveContext(
  db: DB,
  params: { userId: string; orgId?: string; driveId?: string }
): ResolvedContext {
  // If driveId is explicit, use it
  if (params.driveId) {
    const drive = db
      .select()
      .from(schema.drives)
      .where(eq(schema.drives.id, params.driveId))
      .get();

    if (!drive) throw new Error(`Drive not found: ${params.driveId}`);

    const role = getUserDriveRole(db, params.userId, params.driveId);
    if (!role) throw new Error("You do not have access to this drive");

    return { orgId: drive.orgId, driveId: params.driveId, role };
  }

  // If orgId is specified, use its default drive
  if (params.orgId) {
    const drive = db
      .select()
      .from(schema.drives)
      .where(
        and(
          eq(schema.drives.orgId, params.orgId),
          eq(schema.drives.isDefault, true)
        )
      )
      .get();

    if (!drive) throw new Error(`No default drive for org: ${params.orgId}`);

    const role = getUserDriveRole(db, params.userId, drive.id);
    if (!role) throw new Error("You do not have access to this drive");

    return { orgId: params.orgId, driveId: drive.id, role };
  }

  // Fallback: user's personal org's default drive
  const personalOrg = db
    .select({ orgId: schema.orgMembers.orgId })
    .from(schema.orgMembers)
    .innerJoin(schema.orgs, eq(schema.orgMembers.orgId, schema.orgs.id))
    .where(
      and(
        eq(schema.orgMembers.userId, params.userId),
        eq(schema.orgs.isPersonal, true)
      )
    )
    .get();

  if (!personalOrg) throw new Error("No personal org found for user");

  const drive = db
    .select()
    .from(schema.drives)
    .where(
      and(
        eq(schema.drives.orgId, personalOrg.orgId),
        eq(schema.drives.isDefault, true)
      )
    )
    .get();

  if (!drive) throw new Error("No default drive found");

  const role = getUserDriveRole(db, params.userId, drive.id);
  if (!role) throw new Error("You do not have access to your default drive");

  return { orgId: personalOrg.orgId, driveId: drive.id, role };
}
