import { and, eq, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import type { MemberRole } from "./orgs.js";

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/**
 * SQL for "the higher of the stored role and the incoming one", for the
 * `set` clause of an upsert. A column reference there is the stored row and
 * `excluded.role` is the incoming one, so the comparison and the write are one
 * statement: a concurrent promotion can never be lowered by a late grant.
 */
function higherRole(stored: unknown) {
  return sql`CASE
    WHEN ${stored} = 'admin' OR excluded.role = 'admin' THEN 'admin'
    WHEN ${stored} = 'editor' OR excluded.role = 'editor' THEN 'editor'
    ELSE 'viewer'
  END`;
}

/**
 * Give `userId` at least `role` in an org. A new member gets `role`; an
 * existing member keeps their role when it is already at least as high, so an
 * invite can never demote anyone (changing a role is `updateOrgMemberRole`,
 * which guards the last admin). Returns the role the member ends up with.
 */
export function grantOrgRole(
  db: DB | Tx,
  params: { orgId: string; userId: string; role: MemberRole }
): MemberRole {
  const row = db
    .insert(schema.orgMembers)
    .values({ orgId: params.orgId, userId: params.userId, role: params.role })
    .onConflictDoUpdate({
      target: [schema.orgMembers.orgId, schema.orgMembers.userId],
      set: { role: higherRole(schema.orgMembers.role) },
    })
    .returning({ role: schema.orgMembers.role })
    .get();
  return row.role;
}

/** Same as {@link grantOrgRole} for a drive. `created` is true when the user was not on the drive. */
export function grantDriveRole(
  db: DB | Tx,
  params: { driveId: string; userId: string; role: MemberRole }
): { role: MemberRole; created: boolean } {
  const existing = db
    .select({ role: schema.driveMembers.role })
    .from(schema.driveMembers)
    .where(
      and(eq(schema.driveMembers.driveId, params.driveId), eq(schema.driveMembers.userId, params.userId))
    )
    .get();
  const row = db
    .insert(schema.driveMembers)
    .values({ driveId: params.driveId, userId: params.userId, role: params.role })
    .onConflictDoUpdate({
      target: [schema.driveMembers.driveId, schema.driveMembers.userId],
      set: { role: higherRole(schema.driveMembers.role) },
    })
    .returning({ role: schema.driveMembers.role })
    .get();
  return { role: row.role, created: !existing };
}
