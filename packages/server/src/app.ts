import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { VERSION, getConfig } from "@/core";
import type { DB, AgentS3Client } from "@/core";
import type { AppEnv } from "./types.js";
import { authMiddleware } from "./middleware/auth.js";
import { handleError } from "./middleware/error.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { authRoutes } from "./routes/auth.js";
import { opsRoutes } from "./routes/ops.js";
import { orgRoutes } from "./routes/orgs.js";
import { docsRoutes } from "./routes/docs.js";

export function createApp(db: DB, s3: AgentS3Client) {
  const app = new Hono<AppEnv>();
  const config = getConfig();

  // CORS — configurable origins
  const origins = config.server?.cors?.origins ?? ["*"];
  if (origins.length === 1 && origins[0] === "*") {
    app.use("*", cors());
  } else {
    app.use("*", cors({ origin: origins }));
  }

  app.use("*", bodyLimit({ maxSize: 50 * 1024 * 1024 }));
  app.use("*", authMiddleware(db));

  // Rate limiting — skip /health
  const rpm = config.server?.rateLimit?.requestsPerMinute ?? 60;
  if (rpm > 0) {
    app.use("/orgs/*", rateLimitMiddleware(rpm));
    app.use("/auth/*", rateLimitMiddleware(rpm));
  }

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
