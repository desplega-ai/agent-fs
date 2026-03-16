import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { VERSION, getConfig } from "@/core";
import type { DB, AgentS3Client, EmbeddingProvider } from "@/core";
import { createMcpServer } from "@/mcp/server.js";
import type { AppEnv } from "./types.js";
import { authMiddleware } from "./middleware/auth.js";
import { handleError } from "./middleware/error.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { authRoutes } from "./routes/auth.js";
import { opsRoutes } from "./routes/ops.js";
import { orgRoutes } from "./routes/orgs.js";
import { docsRoutes } from "./routes/docs.js";

export function createApp(db: DB, s3: AgentS3Client, embeddingProvider: EmbeddingProvider | null = null) {
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
    app.use("/mcp", rateLimitMiddleware(rpm));
  }

  // Error handler
  app.onError((err, c) => handleError(err, c));

  // Health check
  app.get("/health", (c) => c.json({ ok: true, version: VERSION }));

  // MCP endpoint — per-request stateless transport
  app.all("/mcp", async (c) => {
    const user = c.get("user");

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });

    const mcpServer = createMcpServer({ db, s3, embeddingProvider });
    await mcpServer.connect(transport);

    return transport.handleRequest(c.req.raw, {
      authInfo: {
        token: c.req.header("Authorization")?.slice(7) ?? "",
        clientId: user.id,
        scopes: [],
        extra: { user: { id: user.id, email: user.email } },
      },
    });
  });

  // Routes
  app.route("/auth", authRoutes(db));
  app.route("/orgs", orgRoutes(db));
  app.route("/orgs", opsRoutes(db, s3, embeddingProvider));
  app.route("/docs", docsRoutes());

  return app;
}
