import { Hono } from "hono";
import { acceptInvite, getInvitePreview } from "@/core";
import type { DB } from "@/core";
import { ipRateLimitMiddleware } from "../middleware/ip-rate-limit.js";
import type { AppEnv } from "../types.js";

/**
 * Invite accept links (/invites/:token). Mounted before authMiddleware: the
 * GET preview is public (the token is the credential), while the accept POST
 * falls through to authMiddleware and the authenticated routes below. The
 * per-IP limit covers both.
 */
export function publicInviteRoutes(db: DB, opts: { requestsPerMinute: number }) {
  const router = new Hono<AppEnv>();

  if (opts.requestsPerMinute > 0) {
    router.use("*", ipRateLimitMiddleware(opts.requestsPerMinute));
  }

  // Unknown, expired, revoked and used tokens all get the same 404 body.
  router.get("/:token", (c) => c.json(getInvitePreview(db, c.req.param("token"))));

  return router;
}

export function inviteRoutes(db: DB) {
  const router = new Hono<AppEnv>();

  router.post("/:token/accept", (c) => {
    const user = c.get("user");
    const result = acceptInvite(db, { token: c.req.param("token"), userId: user.id });
    return c.json({ ok: true, ...result });
  });

  return router;
}
