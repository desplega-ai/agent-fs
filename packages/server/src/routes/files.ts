import { Hono } from "hono";
import {
  resolveContext,
  writeRaw,
  getHeadVersionRow,
  getS3Key,
} from "@/core";
import type { DB, AgentS3Client, EmbeddingProvider } from "@/core";
import { normalizePath } from "@/core/ops/paths.js";
import type { AppEnv } from "../types.js";

export function fileRoutes(
  db: DB,
  s3: AgentS3Client,
  embeddingProvider: EmbeddingProvider | null = null,
  appUrl?: string
) {
  const router = new Hono<AppEnv>();

  // GET /orgs/:orgId/drives/:driveId/files/:path+/raw
  // Streams raw file bytes with appropriate Content-Type header plus the
  // ETag / X-Agent-FS-* headers the FUSE mount needs to drive its
  // open-time conditional GET cache.
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
    // Normalize to the canonical "/path" form so DB lookups match what
    // the JSON op route stores (which always passes a leading-slash path).
    const filePath = normalizePath(decodeURIComponent(match[1]));

    const key = getS3Key(resolved.orgId, resolved.driveId, filePath);

    try {
      const result = await s3.getObject(key);
      const contentType = result.contentType || "application/octet-stream";

      // Look up the head version row so the response carries the version
      // and content hash without a second round-trip from the client.
      const head = getHeadVersionRow(
        { db, driveId: resolved.driveId },
        filePath
      );

      const headers: Record<string, string> = {
        "Content-Type": contentType,
        "Content-Length": String(result.body.length),
        "Cache-Control": "private, max-age=60",
      };

      if (head) {
        headers["ETag"] = `"${head.version}"`;
        headers["X-Agent-FS-Version"] = String(head.version);
        if (head.contentHash) {
          headers["X-Agent-FS-Content-Hash"] = head.contentHash;
        }
        if (head.createdAt) {
          headers["Last-Modified"] = new Date(head.createdAt).toUTCString();
        }
      }

      return new Response(result.body.slice(), {
        status: 200,
        headers,
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

  // PUT /orgs/:orgId/drives/:driveId/files/:path+/raw
  //
  // Binary write path used by the FUSE mount's close-time PUT. Headers:
  //   - If-Match: <version>            → expectedVersion: <version>
  //   - If-None-Match: *               → expectedVersion: 0 (create only)
  //   - X-Agent-FS-Message: <message>  → version message
  //
  // Reuses the in-process `writeRaw` helper (which fronts the `write` op)
  // so RBAC, versioning, FTS5 indexing and embedding scheduling all flow
  // through the existing pipeline. The body is buffered up to Hono's
  // 50 MB body limit — no true streaming in v1.
  router.put("/:orgId/drives/:driveId/files/*/raw", async (c) => {
    const user = c.get("user");
    const orgId = c.req.param("orgId");
    const driveIdParam = c.req.param("driveId");

    // Reject JSON bodies — agents that hit this route by mistake should
    // see a clear error rather than have their JSON written as a blob.
    const ct = c.req.header("Content-Type") ?? "";
    if (ct.toLowerCase().startsWith("application/json")) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message:
            "PUT /raw expects a binary body; use POST /ops with op=write for JSON-encoded content",
        },
        415
      );
    }

    const resolved = resolveContext(db, {
      userId: user.id,
      orgId,
      driveId: driveIdParam,
    });

    const url = new URL(c.req.url);
    const match = url.pathname.match(/\/files\/(.+)\/raw$/);
    if (!match) {
      return c.json({ error: "VALIDATION_ERROR", message: "Invalid file path" }, 400);
    }
    // Normalize to the canonical "/path" form so the row created here
    // collates with rows created by the JSON ops route.
    const filePath = normalizePath(decodeURIComponent(match[1]));

    // Resolve expectedVersion from conditional headers.
    //   If-None-Match: *  →  expectedVersion: 0 ("must not exist")
    //   If-Match: <n>     →  expectedVersion: <n>
    // If neither is set, the write is unconditional.
    let expectedVersion: number | undefined;
    const ifNoneMatch = c.req.header("If-None-Match");
    const ifMatch = c.req.header("If-Match");
    if (ifNoneMatch === "*") {
      expectedVersion = 0;
    } else if (ifMatch !== undefined) {
      // Strip optional surrounding quotes (`"<n>"` from ETag echoes).
      const trimmed = ifMatch.replace(/^"|"$/g, "");
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: `If-Match must be a non-negative integer version, got: ${ifMatch}`,
          },
          400
        );
      }
      expectedVersion = parsed;
    }

    const message = c.req.header("X-Agent-FS-Message") ?? undefined;

    // Read body. Hono's bodyLimit middleware already caps this at 50 MB.
    const arrayBuffer = await c.req.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    const ctx = {
      db,
      s3,
      orgId: resolved.orgId,
      driveId: resolved.driveId,
      userId: user.id,
      embeddingProvider,
      appUrl,
    };

    const result = await writeRaw(ctx, {
      path: filePath,
      bytes,
      message,
      expectedVersion,
    });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ETag: `"${result.version}"`,
        "X-Agent-FS-Version": String(result.version),
        ...(result.contentHash && {
          "X-Agent-FS-Content-Hash": result.contentHash,
        }),
        "X-Agent-FS-Deduped": result.deduped ? "1" : "0",
      },
    });
  });

  return router;
}
