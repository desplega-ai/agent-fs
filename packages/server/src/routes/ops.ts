import { Hono } from "hono";
import { dispatchOp, resolveContext } from "@/core";
import type { DB, StorageAdapter, EmbeddingProvider } from "@/core";
import type { AppEnv } from "../types.js";
import { resolveApiUrl } from "../public-url.js";

export function opsRoutes(db: DB, s3: StorageAdapter, embeddingProvider: EmbeddingProvider | null = null, appUrl?: string, publicUrl?: string) {
  const router = new Hono<AppEnv>();

  router.post("/:orgId/ops", async (c) => {
    const user = c.get("user");
    const orgId = c.req.param("orgId");
    // Only a parse failure is the client's fault; rethrow the rest so bodyLimit
    // still answers 413 for an oversized chunked body.
    const body = await c.req.json().catch((err) => {
      if (err instanceof SyntaxError) return null;
      throw err;
    });
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json(
        { error: "VALIDATION_ERROR", message: "Request body must be a JSON object with an op field" },
        400
      );
    }
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

    // RBAC is enforced inside dispatchOp — no need to check here
    const ctx = {
      db,
      s3,
      orgId: resolved.orgId,
      driveId: resolved.driveId,
      userId: user.id,
      embeddingProvider,
      appUrl,
      apiUrl: resolveApiUrl(c, publicUrl),
      apiUrlSource: publicUrl ? ("configured" as const) : ("request" as const),
    };

    const result = await dispatchOp(ctx, op, params);
    return c.json(result as any);
  });

  return router;
}
