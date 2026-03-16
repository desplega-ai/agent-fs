import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createDatabase,
  getConfig,
  AgentS3Client,
  resolveContext,
  getUserByApiKey,
  ensureLocalUser,
  createEmbeddingProviderFromEnv,
  dispatchOp,
  listUserOrgs,
  listDrives,
  getUserDriveRole,
  VERSION,
} from "@/core";
import type { OpContext, DB } from "@/core";
import { registerTools } from "./tools.js";

export interface McpServerOptions {
  apiKey?: string;
}

export async function createMcpServer(options: McpServerOptions) {
  const server = new McpServer({
    name: "agent-fs",
    version: VERSION,
  });

  const config = getConfig();

  // Await embedding provider before registering tools to avoid race condition
  const embeddingProvider = await createEmbeddingProviderFromEnv(config.embedding);
  const db = createDatabase();
  const s3 = new AgentS3Client(config.s3);

  // Auto-bootstrap local user — no manual registration needed
  const { apiKey } = options.apiKey
    ? { apiKey: options.apiKey }
    : ensureLocalUser(db);

  const getContext = (): OpContext => {
    const user = getUserByApiKey(db, apiKey);
    if (!user) throw new Error("Invalid API key");

    const resolved = resolveContext(db, { userId: user.id });
    return {
      db,
      s3,
      orgId: resolved.orgId,
      driveId: resolved.driveId,
      userId: user.id,
      embeddingProvider,
    };
  };

  registerTools(server, getContext);

  // health tool — lets agents check system readiness
  server.tool("health", "Check agent-fs system health: database, S3, embeddings, version.", {}, async () => {
    const status: Record<string, unknown> = { version: VERSION };

    // Database — verify by listing root (touches DB + validates context)
    try {
      const ctx = getContext();
      const result = await dispatchOp(ctx, "ls", { path: "/" }, { skipAuth: true }) as any;
      status.database = { ok: true, rootEntries: result.entries?.length ?? 0 };
    } catch (err: any) {
      status.database = { ok: false, error: err.message };
    }

    // S3
    try {
      await s3.listObjects("", { delimiter: "/" });
      status.s3 = { ok: true, endpoint: config.s3.endpoint, bucket: config.s3.bucket };
    } catch (err: any) {
      status.s3 = { ok: false, error: err.message };
    }

    // Embeddings
    status.embeddings = {
      configured: !!embeddingProvider,
      provider: embeddingProvider ? config.embedding.provider : "none",
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
    };
  });

  // whoami tool — lets agents check their identity and permissions
  server.tool("whoami", "Get current user identity, org memberships, and drive roles.", {}, async () => {
    const user = getUserByApiKey(db, apiKey);
    if (!user) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Invalid API key" }) }],
      };
    }

    const orgs = listUserOrgs(db, user.id);
    const orgDetails = orgs.map((org) => {
      const drives = listDrives(db, org.id);
      return {
        orgId: org.id,
        orgName: org.name,
        drives: drives.map((d) => ({
          driveId: d.id,
          driveName: d.name,
          role: getUserDriveRole(db, user.id, d.id),
        })),
      };
    });

    const ctx = getContext();
    const result = {
      userId: user.id,
      email: user.email,
      activeOrg: ctx.orgId,
      activeDrive: ctx.driveId,
      memberships: orgDetails,
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  });

  console.error("[agent-fs] MCP server ready");

  return server;
}
