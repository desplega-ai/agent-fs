import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { VERSION } from "@/core";
import type { DB, AgentS3Client } from "@/core";
import type { AppEnv } from "./types.js";
import { authMiddleware } from "./middleware/auth.js";
import { handleError } from "./middleware/error.js";
import { authRoutes } from "./routes/auth.js";
import { opsRoutes } from "./routes/ops.js";
import { orgRoutes } from "./routes/orgs.js";
import { docsRoutes } from "./routes/docs.js";

export function createApp(db: DB, s3: AgentS3Client) {
  const app = new Hono<AppEnv>();

  // Global middleware
  app.use("*", cors());
  app.use("*", bodyLimit({ maxSize: 50 * 1024 * 1024 }));
  app.use("*", authMiddleware(db));

  // Error handler
  app.onError((err, c) => handleError(err, c));

  // Health check
  app.get("/health", (c) => c.json({ ok: true, version: VERSION }));

  // Routes
  app.route("/auth", authRoutes(db));
  app.route("/orgs", orgRoutes(db));
  app.route("/orgs", opsRoutes(db, s3));
  app.route("/docs", docsRoutes());

  return app;
}
