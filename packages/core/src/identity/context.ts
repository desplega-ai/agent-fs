import { eq, and } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import { NotFoundError } from "../errors.js";
import type { Role } from "./rbac.js";
import { getUserDriveRole } from "./rbac.js";
import { getPersonalOrgId } from "./orgs.js";

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

    // When the caller also pinned an org (e.g. route /orgs/:orgId/ops),
    // the drive MUST belong to that org. Reject mismatches with the same
    // error as "missing" so cross-tenant callers cannot probe existence.
    if (!drive || (params.orgId && drive.orgId !== params.orgId)) {
      throw new NotFoundError(`Drive not found: ${params.driveId}`, {
        suggestion: params.orgId
          ? "Check the driveId belongs to the org you are addressing"
          : undefined,
      });
    }

    // No role on an existing drive must be indistinguishable from a drive
    // that does not exist — same error type and byte-identical message as
    // the missing/cross-org branch above (no intra-org existence oracle).
    const role = getUserDriveRole(db, params.userId, params.driveId);
    if (!role) {
      throw new NotFoundError(`Drive not found: ${params.driveId}`, {
        suggestion: params.orgId
          ? "Check the driveId belongs to the org you are addressing"
          : undefined,
      });
    }

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

    if (!drive)
      throw new NotFoundError(`No default drive for org: ${params.orgId}`);

    // A default drive the user has no role on must be indistinguishable from
    // the org having no default drive at all — same error, and no leak of the
    // drive's id to non-members.
    const role = getUserDriveRole(db, params.userId, drive.id);
    if (!role)
      throw new NotFoundError(`No default drive for org: ${params.orgId}`);

    return { orgId: params.orgId, driveId: drive.id, role };
  }

  // Fallback: the default drive of the personal org the user owns. Being a
  // member of someone else's personal org never changes it.
  const personalOrgId = getPersonalOrgId(db, params.userId);
  if (!personalOrgId) throw new Error("No personal org found for user");

  const drive = db
    .select()
    .from(schema.drives)
    .where(
      and(
        eq(schema.drives.orgId, personalOrgId),
        eq(schema.drives.isDefault, true)
      )
    )
    .get();

  if (!drive) throw new Error("No default drive found");

  const role = getUserDriveRole(db, params.userId, drive.id);
  if (!role) throw new Error("You do not have access to your default drive");

  return { orgId: personalOrgId, driveId: drive.id, role };
}
