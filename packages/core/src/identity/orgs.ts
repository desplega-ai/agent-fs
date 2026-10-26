import { eq, and, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import { NotFoundError } from "../errors.js";
import { createDrive, setDriveMember } from "./drives.js";
import { assertDriveInOrg, getUserDriveRole, getUserOrgRole } from "./rbac.js";

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

  // Create default drive with explicit creator admin membership
  createDrive(db, {
    orgId: id,
    name: "default",
    isDefault: true,
    creatorUserId: params.userId,
  });

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

export function listOrgMembers(
  db: DB,
  orgId: string
): Array<{ userId: string; email: string; role: string }> {
  return db
    .select({
      userId: schema.orgMembers.userId,
      email: schema.users.email,
      role: schema.orgMembers.role,
    })
    .from(schema.orgMembers)
    .innerJoin(schema.users, eq(schema.orgMembers.userId, schema.users.id))
    .where(eq(schema.orgMembers.orgId, orgId))
    .all();
}

export function updateOrgMemberRole(
  db: DB,
  params: { orgId: string; userId: string; role: "viewer" | "editor" | "admin" }
): void {
  const existing = db
    .select({ role: schema.orgMembers.role })
    .from(schema.orgMembers)
    .where(
      and(
        eq(schema.orgMembers.orgId, params.orgId),
        eq(schema.orgMembers.userId, params.userId)
      )
    )
    .get();

  if (!existing) {
    throw new Error("Member not found in org");
  }

  // Guard: if downgrading from admin, ensure at least one admin remains
  if (existing.role === "admin" && params.role !== "admin") {
    const adminCount = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.orgMembers)
      .where(
        and(
          eq(schema.orgMembers.orgId, params.orgId),
          eq(schema.orgMembers.role, "admin")
        )
      )
      .get()!.count;

    if (adminCount <= 1) {
      throw new Error("Cannot remove the last admin from the org");
    }
  }

  db.update(schema.orgMembers)
    .set({ role: params.role })
    .where(
      and(
        eq(schema.orgMembers.orgId, params.orgId),
        eq(schema.orgMembers.userId, params.userId)
      )
    )
    .run();
}

export function removeOrgMember(
  db: DB,
  params: { orgId: string; userId: string }
): void {
  // Guard: cannot remove from personal org
  const org = db
    .select({ isPersonal: schema.orgs.isPersonal })
    .from(schema.orgs)
    .where(eq(schema.orgs.id, params.orgId))
    .get();

  if (org?.isPersonal) {
    throw new Error("Cannot remove members from a personal org");
  }

  // Guard: cannot remove last admin
  const member = db
    .select({ role: schema.orgMembers.role })
    .from(schema.orgMembers)
    .where(
      and(
        eq(schema.orgMembers.orgId, params.orgId),
        eq(schema.orgMembers.userId, params.userId)
      )
    )
    .get();

  if (!member) {
    throw new Error("Member not found in org");
  }

  if (member.role === "admin") {
    const adminCount = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.orgMembers)
      .where(
        and(
          eq(schema.orgMembers.orgId, params.orgId),
          eq(schema.orgMembers.role, "admin")
        )
      )
      .get()!.count;

    if (adminCount <= 1) {
      throw new Error("Cannot remove the last admin from the org");
    }
  }

  // Remove from all drives in this org
  const orgDrives = db
    .select({ id: schema.drives.id })
    .from(schema.drives)
    .where(eq(schema.drives.orgId, params.orgId))
    .all();

  for (const drive of orgDrives) {
    db.delete(schema.driveMembers)
      .where(
        and(
          eq(schema.driveMembers.driveId, drive.id),
          eq(schema.driveMembers.userId, params.userId)
        )
      )
      .run();
  }

  // Remove from org
  db.delete(schema.orgMembers)
    .where(
      and(
        eq(schema.orgMembers.orgId, params.orgId),
        eq(schema.orgMembers.userId, params.userId)
      )
    )
    .run();
}

export type MemberRole = "viewer" | "editor" | "admin";

export interface DriveGrant {
  driveId: string;
  role: MemberRole;
}

export interface InviteResult {
  status: "added";
  userId: string;
  email: string;
  drives: DriveGrant[];
}

/** Exact-account lookup that ignores surrounding whitespace and letter case. */
function findUserByEmail(
  db: DB,
  email: string
): { id: string; email: string } | null {
  const normalized = email.trim().toLowerCase();
  const user = db
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${normalized}`)
    .get();
  return user ?? null;
}

/**
 * Add an existing account to an org and grant it drive access.
 *
 * `drives` omitted keeps the original behaviour: the default drive with the
 * org role. `drives: []` adds org membership only. Every drive id must belong
 * to `orgId`; validation runs before any write and all writes share one
 * transaction, so a bad grant leaves nothing behind.
 */
export function inviteToOrg(
  db: DB,
  params: {
    orgId: string;
    email: string;
    role: MemberRole;
    drives?: DriveGrant[];
  }
): InviteResult {
  const user = findUserByEmail(db, params.email);
  if (!user) {
    throw new NotFoundError(`User with email ${params.email.trim()} not found`, {
      suggestion: "The person must register an agent-fs account first",
    });
  }

  let grants: DriveGrant[];
  if (params.drives === undefined) {
    const defaultDrive = db
      .select({ id: schema.drives.id })
      .from(schema.drives)
      .where(
        and(
          eq(schema.drives.orgId, params.orgId),
          eq(schema.drives.isDefault, true)
        )
      )
      .get();
    grants = defaultDrive ? [{ driveId: defaultDrive.id, role: params.role }] : [];
  } else {
    for (const grant of params.drives) {
      assertDriveInOrg(db, { driveId: grant.driveId, orgId: params.orgId });
    }
    // Last grant wins when a drive is listed twice.
    grants = [
      ...new Map(params.drives.map((g) => [g.driveId, g] as const)).values(),
    ];
  }

  db.transaction((tx) => {
    tx.insert(schema.orgMembers)
      .values({ orgId: params.orgId, userId: user.id, role: params.role })
      .onConflictDoUpdate({
        target: [schema.orgMembers.orgId, schema.orgMembers.userId],
        set: { role: params.role },
      })
      .run();

    for (const grant of grants) {
      tx.insert(schema.driveMembers)
        .values({ driveId: grant.driveId, userId: user.id, role: grant.role })
        .onConflictDoUpdate({
          target: [schema.driveMembers.driveId, schema.driveMembers.userId],
          set: { role: grant.role },
        })
        .run();
    }
  });

  return { status: "added", userId: user.id, email: user.email, drives: grants };
}

/**
 * Grant an existing org member access to one drive (upsert). Unknown emails
 * and accounts outside the org get the same 404, so drive admins cannot use
 * this to probe which accounts exist.
 */
export function addDriveMember(
  db: DB,
  params: {
    orgId: string;
    driveId: string;
    role: MemberRole;
  } & ({ email: string; userId?: undefined } | { userId: string; email?: undefined })
): { userId: string; email: string; driveId: string; role: MemberRole; created: boolean } {
  assertDriveInOrg(db, { driveId: params.driveId, orgId: params.orgId });

  const user =
    params.userId !== undefined
      ? db
          .select({ id: schema.users.id, email: schema.users.email })
          .from(schema.users)
          .where(eq(schema.users.id, params.userId))
          .get() ?? null
      : findUserByEmail(db, params.email);

  const orgRole = user ? getUserOrgRole(db, user.id, params.orgId) : null;
  if (!user || !orgRole) {
    throw new NotFoundError("Not a member of this org", {
      suggestion: "Ask an org admin to invite them to the org first",
    });
  }

  const created = getUserDriveRole(db, user.id, params.driveId) === null;
  setDriveMember(db, { driveId: params.driveId, userId: user.id, role: params.role });
  return { userId: user.id, email: user.email, driveId: params.driveId, role: params.role, created };
}
