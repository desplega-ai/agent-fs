import { Hono } from "hono";
import {
  listUserOrgs,
  getOrg,
  createOrg,
  inviteToOrg,
  addDriveMember,
  listOrgMembers,
  updateOrgMemberRole,
  removeOrgMember,
  listInvites,
  revokeInvite,
  inviteAcceptUrl,
  listDrivesForUser,
  listManageableDrives,
  createDrive,
  listDriveMembers,
  updateDriveMemberRole,
  removeDriveMember,
  getUserOrgRole,
  roleAtLeast,
  requireDriveAdmin,
  assertDriveInOrg,
  resetApiKey,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "@/core";
import type { DB, Role, DriveGrant, MemberRole } from "@/core";
import type { AppEnv } from "../types.js";

/**
 * Resolve the caller's role in `orgId`, throwing NotFoundError (404) when
 * the caller has no membership. Missing orgs and foreign orgs produce the
 * same 404 so cross-tenant callers cannot probe org existence.
 */
function requireOrgMember(db: DB, userId: string, orgId: string): Role {
  const role = getUserOrgRole(db, userId, orgId);
  if (!role) {
    throw new NotFoundError(`Org not found: ${orgId}`, {
      suggestion: "Check the org id or ask an org admin for access",
    });
  }
  return role;
}

/**
 * Like requireOrgMember, but additionally requires the 'admin' role.
 * Non-members get 404 (no existence oracle); members below admin get 403.
 */
function requireOrgAdmin(db: DB, userId: string, orgId: string): Role {
  const role = requireOrgMember(db, userId, orgId);
  if (!roleAtLeast(role, "admin")) {
    throw new PermissionDeniedError(
      "This operation requires 'admin' role in the org",
      {
        requiredRole: "admin",
        yourRole: role,
        suggestion: "Ask an org admin to perform this operation",
      }
    );
  }
  return role;
}

const MEMBER_ROLES: readonly MemberRole[] = ["viewer", "editor", "admin"];

function parseRole(value: unknown, field: string): MemberRole {
  if (!MEMBER_ROLES.includes(value as MemberRole)) {
    throw new ValidationError(`${field} must be one of: ${MEMBER_ROLES.join(", ")}`, {
      field,
    });
  }
  return value as MemberRole;
}

function parseEmail(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError("email is required", { field: "email" });
  }
  return value;
}

function parseDriveGrants(value: unknown): DriveGrant[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ValidationError("drives must be an array of { driveId, role }", {
      field: "drives",
    });
  }
  return value.map((grant, i) => {
    if (!grant || typeof grant.driveId !== "string" || !grant.driveId) {
      throw new ValidationError(`drives[${i}].driveId is required`, {
        field: `drives[${i}].driveId`,
      });
    }
    return { driveId: grant.driveId, role: parseRole(grant.role, `drives[${i}].role`) };
  });
}

export function orgRoutes(db: DB, appUrl?: string) {
  const router = new Hono<AppEnv>();

  router.get("/", (c) => {
    const user = c.get("user");
    const orgs = listUserOrgs(db, user.id);
    return c.json({ orgs });
  });

  router.post("/", async (c) => {
    const user = c.get("user");
    const { name } = await c.req.json();
    const org = createOrg(db, { name, userId: user.id });
    return c.json(org, 201);
  });

  router.get("/:orgId", (c) => {
    const user = c.get("user");
    const orgId = c.req.param("orgId");
    requireOrgMember(db, user.id, orgId);
    const org = getOrg(db, orgId);
    if (!org) return c.json({ error: "NOT_FOUND", message: "Org not found" }, 404);
    return c.json(org);
  });

  router.get("/:orgId/drives", (c) => {
    const user = c.get("user");
    const orgId = c.req.param("orgId");
    requireOrgMember(db, user.id, orgId);
    // `scope=manageable` lists the drives whose members the caller can manage
    // (every drive for an org admin). The default stays "drives I am on":
    // FUSE and the drive switcher depend on it.
    if (c.req.query("scope") === "manageable") {
      return c.json({ drives: listManageableDrives(db, orgId, user.id) });
    }
    const drives = listDrivesForUser(db, orgId, user.id);
    return c.json({ drives });
  });

  router.post("/:orgId/drives", async (c) => {
    const user = c.get("user");
    const orgId = c.req.param("orgId");
    requireOrgAdmin(db, user.id, orgId);
    const { name } = await c.req.json();
    // creatorUserId grants the creator an explicit admin drive membership so
    // the new drive stays visible under strict explicit-membership rules.
    const drive = createDrive(db, { orgId, name, creatorUserId: user.id });
    return c.json(drive, 201);
  });

  router.post("/:orgId/members/invite", async (c) => {
    const user = c.get("user");
    const orgId = c.req.param("orgId");
    requireOrgAdmin(db, user.id, orgId);
    const body = await c.req.json();
    const result = inviteToOrg(db, {
      orgId,
      email: parseEmail(body.email),
      role: parseRole(body.role, "role"),
      drives: parseDriveGrants(body.drives),
      invitedBy: user.id,
    });
    if (result.status === "pending") {
      const acceptUrl = inviteAcceptUrl(appUrl, result.token);
      return c.json({ ok: true, ...result, ...(acceptUrl ? { acceptUrl } : {}) });
    }
    return c.json({ ok: true, ...result });
  });

  // --- Pending invites (org admin only) ---

  router.get("/:orgId/invites", (c) => {
    const user = c.get("user");
    const orgId = c.req.param("orgId");
    requireOrgAdmin(db, user.id, orgId);
    return c.json({ invites: listInvites(db, orgId) });
  });

  router.delete("/:orgId/invites/:inviteId", (c) => {
    const user = c.get("user");
    const orgId = c.req.param("orgId");
    requireOrgAdmin(db, user.id, orgId);
    revokeInvite(db, { orgId, inviteId: c.req.param("inviteId") });
    return c.json({ ok: true });
  });

  // --- Org member management (org admin only) ---

  router.get("/:orgId/members", (c) => {
    const user = c.get("user");
    const orgId = c.req.param("orgId");
    requireOrgAdmin(db, user.id, orgId);
    const members = listOrgMembers(db, orgId);
    return c.json({ members });
  });

  router.patch("/:orgId/members/:userId", async (c) => {
    const user = c.get("user");
    const orgId = c.req.param("orgId");
    const userId = c.req.param("userId");
    requireOrgAdmin(db, user.id, orgId);
    const { role } = await c.req.json();
    try {
      updateOrgMemberRole(db, { orgId, userId, role });
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: "BAD_REQUEST", message: err.message }, 400);
    }
  });

  router.post("/:orgId/members/:userId/reset-key", (c) => {
    const user = c.get("user");
    const orgId = c.req.param("orgId");
    const targetUserId = c.req.param("userId");
    requireOrgAdmin(db, user.id, orgId);
    requireOrgMember(db, targetUserId, orgId);
    const result = resetApiKey(db, {
      userId: targetUserId,
      actorId: user.id,
      orgId,
    });
    return c.json({
      apiKey: result.apiKey,
      userId: result.user.id,
      email: result.user.email,
    });
  });

  router.delete("/:orgId/members/:userId", (c) => {
    const user = c.get("user");
    const orgId = c.req.param("orgId");
    const userId = c.req.param("userId");
    requireOrgAdmin(db, user.id, orgId);
    try {
      removeOrgMember(db, { orgId, userId });
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: "BAD_REQUEST", message: err.message }, 400);
    }
  });

  // --- Drive member management (drive admin or org admin) ---
  //
  // Every route binds :driveId to :orgId first (assertDriveInOrg throws the
  // same 404 for "missing" and "wrong org"), then requires drive-admin
  // rights (explicit drive admin OR admin of the owning org).

  router.get("/:orgId/drives/:driveId/members", (c) => {
    const user = c.get("user");
    const orgId = c.req.param("orgId");
    const driveId = c.req.param("driveId");
    assertDriveInOrg(db, { driveId, orgId });
    requireDriveAdmin(db, { userId: user.id, driveId });
    const members = listDriveMembers(db, driveId);
    return c.json({ members });
  });

  router.post("/:orgId/drives/:driveId/members", async (c) => {
    const user = c.get("user");
    const orgId = c.req.param("orgId");
    const driveId = c.req.param("driveId");
    assertDriveInOrg(db, { driveId, orgId });
    requireDriveAdmin(db, { userId: user.id, driveId });
    const body = await c.req.json();
    const role = parseRole(body.role, "role");
    const result =
      typeof body.userId === "string" && body.userId
        ? addDriveMember(db, { orgId, driveId, role, userId: body.userId })
        : addDriveMember(db, { orgId, driveId, role, email: parseEmail(body.email) });
    return c.json(result, result.created ? 201 : 200);
  });

  router.patch("/:orgId/drives/:driveId/members/:userId", async (c) => {
    const user = c.get("user");
    const orgId = c.req.param("orgId");
    const driveId = c.req.param("driveId");
    const userId = c.req.param("userId");
    assertDriveInOrg(db, { driveId, orgId });
    requireDriveAdmin(db, { userId: user.id, driveId });
    const { role } = await c.req.json();
    try {
      updateDriveMemberRole(db, { driveId, userId, role });
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: "BAD_REQUEST", message: err.message }, 400);
    }
  });

  router.delete("/:orgId/drives/:driveId/members/:userId", (c) => {
    const user = c.get("user");
    const orgId = c.req.param("orgId");
    const driveId = c.req.param("driveId");
    const userId = c.req.param("userId");
    assertDriveInOrg(db, { driveId, orgId });
    requireDriveAdmin(db, { userId: user.id, driveId });
    try {
      removeDriveMember(db, { driveId, userId });
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: "BAD_REQUEST", message: err.message }, 400);
    }
  });

  return router;
}
