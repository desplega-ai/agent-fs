import { Hono } from "hono";
import type { Context } from "hono";
import { presenceSessionIdSchema, presenceStateSchema, resolveContext, ValidationError } from "@/core";
import type { DB, PresenceRegistry } from "@/core";
import type { AppEnv } from "../types.js";

export function presenceRoutes(db: DB, presence: PresenceRegistry) {
  const router = new Hono<AppEnv>();
  const path = "/:orgId/drives/:driveId/presence";
  // Key presence by the resolved drive id, the same id the event stream subscribes with.
  const drive = (c: Context<AppEnv>) => resolveContext(db, {
    userId: c.get("user").id, orgId: c.req.param("orgId"), driveId: c.req.param("driveId"),
  }).driveId;
  const session = (c: Context<AppEnv>) => {
    const sessionId = presenceSessionIdSchema.safeParse(c.req.param("sessionId"));
    if (!sessionId.success) throw new ValidationError("Invalid presence sessionId");
    return sessionId.data;
  };

  router.get(path, (c) => c.json(presence.snapshot(drive(c))));
  router.put(`${path}/:sessionId`, async (c) => {
    const driveId = drive(c);
    const sessionId = session(c);
    const state = presenceStateSchema.safeParse(await c.req.json().catch(() => null));
    if (!state.success) throw new ValidationError(state.error.message);
    return c.json({ session: presence.upsert(driveId, sessionId, c.get("user"), state.data) });
  });
  router.delete(`${path}/:sessionId`, (c) => {
    presence.remove(drive(c), session(c), c.get("user").id);
    return c.json({ ok: true });
  });
  return router;
}
