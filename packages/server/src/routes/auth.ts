import { Hono } from "hono";
import { createUser, listUserOrgs, resolveContext } from "@/core";
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

  router.get("/me", (c) => {
    const user = c.get("user");

    try {
      const resolved = resolveContext(db, { userId: user.id });
      return c.json({
        userId: user.id,
        email: user.email,
        defaultOrgId: resolved.orgId,
        defaultDriveId: resolved.driveId,
      });
    } catch {
      // If context resolution fails, return basic user info without defaults
      return c.json({
        userId: user.id,
        email: user.email,
        defaultOrgId: null,
        defaultDriveId: null,
      });
    }
  });

  return router;
}
