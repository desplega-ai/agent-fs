import { Hono } from "hono";
import {
  listUserOrgs,
  getOrg,
  createOrg,
  inviteToOrg,
  listOrgMembers,
  updateOrgMemberRole,
  removeOrgMember,
  listDrives,
  createDrive,
  listDriveMembers,
  updateDriveMemberRole,
  removeDriveMember,
} from "@/core";
import type { DB } from "@/core";
import type { AppEnv } from "../types.js";

export function orgRoutes(db: DB) {
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
    const orgId = c.req.param("orgId");
    const org = getOrg(db, orgId);
    if (!org) return c.json({ error: "NOT_FOUND", message: "Org not found" }, 404);
    return c.json(org);
  });

  router.get("/:orgId/drives", (c) => {
    const orgId = c.req.param("orgId");
    const drives = listDrives(db, orgId);
    return c.json({ drives });
  });

  router.post("/:orgId/drives", async (c) => {
    const orgId = c.req.param("orgId");
    const { name } = await c.req.json();
    const drive = createDrive(db, { orgId, name });
    return c.json(drive, 201);
  });

  router.post("/:orgId/members/invite", async (c) => {
    const orgId = c.req.param("orgId");
    const { email, role } = await c.req.json();
    inviteToOrg(db, { orgId, email, role });
    return c.json({ ok: true });
  });

  // --- Org member management ---

  router.get("/:orgId/members", (c) => {
    const orgId = c.req.param("orgId");
    const members = listOrgMembers(db, orgId);
    return c.json({ members });
  });

  router.patch("/:orgId/members/:userId", async (c) => {
    const orgId = c.req.param("orgId");
    const userId = c.req.param("userId");
    const { role } = await c.req.json();
    try {
      updateOrgMemberRole(db, { orgId, userId, role });
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: "BAD_REQUEST", message: err.message }, 400);
    }
  });

  router.delete("/:orgId/members/:userId", (c) => {
    const orgId = c.req.param("orgId");
    const userId = c.req.param("userId");
    try {
      removeOrgMember(db, { orgId, userId });
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: "BAD_REQUEST", message: err.message }, 400);
    }
  });

  // --- Drive member management ---

  router.get("/:orgId/drives/:driveId/members", (c) => {
    const driveId = c.req.param("driveId");
    const members = listDriveMembers(db, driveId);
    return c.json({ members });
  });

  router.patch("/:orgId/drives/:driveId/members/:userId", async (c) => {
    const driveId = c.req.param("driveId");
    const userId = c.req.param("userId");
    const { role } = await c.req.json();
    try {
      updateDriveMemberRole(db, { driveId, userId, role });
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: "BAD_REQUEST", message: err.message }, 400);
    }
  });

  router.delete("/:orgId/drives/:driveId/members/:userId", (c) => {
    const driveId = c.req.param("driveId");
    const userId = c.req.param("userId");
    try {
      removeDriveMember(db, { driveId, userId });
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: "BAD_REQUEST", message: err.message }, 400);
    }
  });

  return router;
}
