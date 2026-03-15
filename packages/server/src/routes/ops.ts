import { Hono } from "hono";
import {
  dispatchOp,
  resolveContext,
  checkPermission,
  getRequiredRole,
} from "@agentfs/core";
import type { DB, AgentS3Client } from "@agentfs/core";
import type { AppEnv } from "../types.js";

export function opsRoutes(db: DB, s3: AgentS3Client) {
  const router = new Hono<AppEnv>();

  router.post("/:orgId/ops", async (c) => {
    const user = c.get("user");
    const orgId = c.req.param("orgId");
    const body = await c.req.json();
    const { op, ...params } = body;

    if (!op) {
      return c.json(
        { error: "VALIDATION_ERROR", message: "op is required in request body" },
        400
      );
    }

    const driveId = params.driveId || params.drive_id;
    delete params.driveId;
    delete params.drive_id;

    const resolved = resolveContext(db, { userId: user.id, orgId, driveId });

    const requiredRole = getRequiredRole(op);
    checkPermission(db, {
      userId: user.id,
      driveId: resolved.driveId,
      requiredRole,
    });

    const ctx = {
      db,
      s3,
      orgId: resolved.orgId,
      driveId: resolved.driveId,
      userId: user.id,
    };

    const result = await dispatchOp(ctx, op, params);
    return c.json(result as any);
  });

  return router;
}
