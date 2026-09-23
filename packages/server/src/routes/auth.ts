import { Hono } from "hono";
import {
  createUser,
  getProfile,
  updateProfile,
  listUserOrgs,
  resolveContext,
  resetApiKey,
  resetApiKeyOrgless,
} from "@/core";
import type { DB } from "@/core";
import type { AppEnv } from "../types.js";

export function authRoutes(db: DB) {
  const router = new Hono<AppEnv>();

  router.post("/register", async (c) => {
    const { email } = await c.req.json();

    if (!email || typeof email !== "string") {
      return c.json(
        { error: "VALIDATION_ERROR", message: "email is required" },
        400
      );
    }

    try {
      const result = createUser(db, { email });
      const orgs = listUserOrgs(db, result.user.id);

      return c.json({
        apiKey: result.apiKey,
        userId: result.user.id,
        orgId: orgs[0]?.id,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("UNIQUE")) {
        return c.json(
          { error: "CONFLICT", message: "User with this email already exists" },
          409
        );
      }
      throw err;
    }
  });

  router.get("/profile", (c) => c.json(getProfile(db, c.get("user").id)));
  router.patch("/profile", async (c) =>
    c.json(updateProfile(db, c.get("user").id, await c.req.json())));

  router.get("/me", (c) => {
    const user = c.get("user");

    try {
      const resolved = resolveContext(db, { userId: user.id });
      return c.json({
        userId: user.id,
        email: user.email,
        displayName: getProfile(db, user.id).displayName,
        defaultOrgId: resolved.orgId,
        defaultDriveId: resolved.driveId,
      });
    } catch {
      // If context resolution fails, return basic user info without defaults
      return c.json({
        userId: user.id,
        email: user.email,
        displayName: getProfile(db, user.id).displayName,
        defaultOrgId: null,
        defaultDriveId: null,
      });
    }
  });

  router.post("/reset-key", (c) => {
    const user = c.get("user");
    const orgs = listUserOrgs(db, user.id);

    if (orgs.length === 0) {
      // Defensive fallback: every user gets an auto-created personal org on
      // registration, so this should not happen in practice. Without an
      // orgId there is nowhere to attach the audit event, so skip it.
      console.warn(`api key reset for user ${user.id} with no orgs; no audit event recorded`);
      const { apiKey } = resetApiKeyOrgless(db, user.id);
      return c.json({ apiKey });
    }

    const org = orgs.find((o) => o.isPersonal) ?? orgs[0];
    const result = resetApiKey(db, {
      userId: user.id,
      actorId: user.id,
      orgId: org.id,
    });
    return c.json({ apiKey: result.apiKey });
  });

  return router;
}
