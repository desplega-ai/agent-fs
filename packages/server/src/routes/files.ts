import { Hono } from "hono";
import { resolveContext } from "@/core";
import type { DB, AgentS3Client } from "@/core";
import { getS3Key } from "@/core/ops/versioning.js";
import type { AppEnv } from "../types.js";

export function fileRoutes(db: DB, s3: AgentS3Client) {
  const router = new Hono<AppEnv>();

  // GET /orgs/:orgId/drives/:driveId/files/:path+/raw
  // Streams raw file bytes with appropriate Content-Type header.
  router.get("/:orgId/drives/:driveId/files/*/raw", async (c) => {
    const user = c.get("user");
    const orgId = c.req.param("orgId");
    const driveIdParam = c.req.param("driveId");

    const resolved = resolveContext(db, { userId: user.id, orgId, driveId: driveIdParam });

    // Extract the file path from the wildcard (everything between /files/ and /raw)
    const url = new URL(c.req.url);
    const match = url.pathname.match(/\/files\/(.+)\/raw$/);
    if (!match) {
      return c.json({ error: "VALIDATION_ERROR", message: "Invalid file path" }, 400);
    }
    const filePath = decodeURIComponent(match[1]);

    const key = getS3Key(resolved.orgId, resolved.driveId, filePath);

    try {
      const result = await s3.getObject(key);
      const contentType = result.contentType || "application/octet-stream";

      return new Response(result.body.buffer as ArrayBuffer, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(result.body.length),
          "Cache-Control": "private, max-age=60",
        },
      });
    } catch (err: any) {
      if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
        return c.json(
          { error: "NOT_FOUND", message: `File not found: ${filePath}` },
          404
        );
      }
      throw err;
    }
  });

  return router;
}
