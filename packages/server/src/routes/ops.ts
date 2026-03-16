import { Hono } from "hono";
import { dispatchOp, resolveContext, createEmbeddingProviderFromEnv, getConfig } from "@/core";
import type { DB, AgentS3Client, EmbeddingProvider } from "@/core";
import type { AppEnv } from "../types.js";

export function opsRoutes(db: DB, s3: AgentS3Client) {
  const router = new Hono<AppEnv>();

  // Lazy-init embedding provider on first request
  let embeddingProvider: EmbeddingProvider | null | undefined;
  let embeddingInitPromise: Promise<EmbeddingProvider | null> | null = null;

  async function getEmbeddingProvider(): Promise<EmbeddingProvider | null> {
    if (embeddingProvider !== undefined) return embeddingProvider;
    if (!embeddingInitPromise) {
      const config = getConfig();
      embeddingInitPromise = createEmbeddingProviderFromEnv(config.embedding);
    }
    embeddingProvider = await embeddingInitPromise;
    return embeddingProvider;
  }

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

    // RBAC is enforced inside dispatchOp — no need to check here
    const ctx = {
      db,
      s3,
      orgId: resolved.orgId,
      driveId: resolved.driveId,
      userId: user.id,
      embeddingProvider: await getEmbeddingProvider(),
    };

    const result = await dispatchOp(ctx, op, params);
    return c.json(result as any);
  });

  return router;
}
