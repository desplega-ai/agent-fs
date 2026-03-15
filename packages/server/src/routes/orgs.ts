import { Hono } from "hono";
import {
  listUserOrgs,
  getOrg,
  createOrg,
  inviteToOrg,
  listDrives,
  createDrive,
} from "@agentfs/core";
import type { DB } from "@agentfs/core";
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

  return router;
}
