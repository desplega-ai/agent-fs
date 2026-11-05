import { Hono } from "hono";
import {
  listUserOrgs,
  getOrg,
  parseSwarmUrl,
  setOrgSwarmUrl,
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
  createUserApiKey,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "@/core";
import type { DB, Role, DriveGrant, MemberRole } from "@/core";
import { ipRateLimitMiddleware } from "../middleware/ip-rate-limit.js";
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

/**
 * `GET /orgs/:orgId/public`, mounted before authMiddleware: a browser with no
 * key on a deep link learns where to sign in ("Continue with <swarm>"). It
 * answers only `{ swarmUrl }`, and unknown orgs get the same `null` as orgs
 * without one, so it reveals no org names and is no existence oracle.
 */
export function publicOrgRoutes(db: DB, opts: { requestsPerMinute: number }) {
  const router = new Hono<AppEnv>();
  const limit = opts.requestsPerMinute > 0
    ? ipRateLimitMiddleware(opts.requestsPerMinute)
    : (_c: unknown, next: () => Promise<void>) => next();

  router.get("/:orgId/public", limit, (c) =>
    c.json({ swarmUrl: getOrg(db, c.req.param("orgId"))?.swarmUrl ?? null }));

  return router;
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

  // `role` is the caller's role, as in `GET /orgs`. An org-scoped key gets
  // 403 on that list, so the live app reads its role here.
  router.get("/:orgId", (c) => {
    const user = c.get("user");
    const orgId = c.req.param("orgId");
    const role = requireOrgMember(db, user.id, orgId);
    const org = getOrg(db, orgId);
    if (!org) return c.json({ error: "NOT_FOUND", message: "Org not found" }, 404);
    return c.json({ ...org, role });
  });

  // The agent-swarm dashboard this org trusts for sign-in. Org admins edit it
  // in the live app. A swarm sets it on first start, only while it is empty.
  router.patch("/:orgId", async (c) => {
    const user = c.get("user");
    const orgId = c.req.param("orgId");
    requireOrgAdmin(db, user.id, orgId);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || !("swarmUrl" in body)) {
      throw new ValidationError("swarmUrl is required (a URL, or null to clear it)", { field: "swarmUrl" });
    }
    return c.json(setOrgSwarmUrl(db, { orgId, swarmUrl: parseSwarmUrl(body.swarmUrl) }));
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
    // reset-key returns a new primary key, which reaches the whole account.
    // An org-scoped key must not mint one, or it escapes its scope. The check
    // lives here, not in the middleware's path filter, because Hono matches
    // routes on the decoded path (e.g. `reset%2Dkey`).
    if (c.get("scopeOrgId")) {
      return c.json(
        {
          error: "FORBIDDEN",
          message: "An org-scoped API key cannot reset a member's primary key",
          suggestion: "Use an unscoped API key for this request",
        },
        403
      );
    }
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

  // Mint an additional key for a member without touching their existing
  // keys (reset-key rotates the primary one). Same guard as reset-key. The
  // key is scoped to this org: it only reaches /orgs/<orgId>/..., and it is
  // revoked when the member leaves the org, when the minting admin leaves or
  // loses admin here, and when the member runs their own reset-key.
  router.post("/:orgId/members/:userId/keys", async (c) => {
    const user = c.get("user");
    const orgId = c.req.param("orgId");
    const targetUserId = c.req.param("userId");
    requireOrgAdmin(db, user.id, orgId);
    requireOrgMember(db, targetUserId, orgId);
    const body = await c.req.json().catch(() => ({}));
    const key = createUserApiKey(db, {
      userId: targetUserId,
      label: body?.label,
      actorId: user.id,
      orgId,
      scopeOrgId: orgId,
    });
    return c.json({
      id: key.id,
      label: key.label,
      createdAt: key.createdAt,
      apiKey: key.apiKey,
      userId: targetUserId,
      orgId,
    }, 201);
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
