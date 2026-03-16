import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import {
  resolveContext,
  dispatchOp,
  listUserOrgs,
  listDrives,
  getUserDriveRole,
  VERSION,
} from "@/core";
import type { OpContext, DB, EmbeddingProvider, AgentS3Client } from "@/core";
import { registerTools } from "./tools.js";

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface McpServerOptions {
  db: DB;
  s3: AgentS3Client;
  embeddingProvider: EmbeddingProvider | null;
}

export function createMcpServer(options: McpServerOptions) {
  const { db, s3, embeddingProvider } = options;

  const server = new McpServer({
    name: "agent-fs",
    version: VERSION,
  });

  const getContext = (extra: Extra): OpContext => {
    const authInfo = extra.authInfo;
    if (!authInfo?.extra?.user) {
      throw new Error("No auth context — MCP must be accessed through the HTTP server");
    }
    const user = authInfo.extra.user as { id: string; email: string };
    const resolved = resolveContext(db, { userId: user.id });
    return { db, s3, orgId: resolved.orgId, driveId: resolved.driveId, userId: user.id, embeddingProvider };
  };

  registerTools(server, getContext);

  // health tool — lets agents check system readiness
  server.tool("health", "Check agent-fs system health: database, S3, embeddings, version.", {}, async (_params, extra) => {
    const status: Record<string, unknown> = { version: VERSION };

    // Database — verify by listing root (touches DB + validates context)
    try {
      const ctx = getContext(extra);
      const result = await dispatchOp(ctx, "ls", { path: "/" }, { skipAuth: true }) as any;
      status.database = { ok: true, rootEntries: result.entries?.length ?? 0 };
    } catch (err: any) {
      status.database = { ok: false, error: err.message };
    }

    // S3
    try {
      await s3.listObjects("", { delimiter: "/" });
      status.s3 = { ok: true };
    } catch (err: any) {
      status.s3 = { ok: false, error: err.message };
    }

    // Embeddings
    status.embeddings = {
      configured: !!embeddingProvider,
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
    };
  });

  // whoami tool — lets agents check their identity and permissions
  server.tool("whoami", "Get current user identity, org memberships, and drive roles.", {}, async (_params, extra) => {
    const ctx = getContext(extra);
    const userId = ctx.userId;

    const orgs = listUserOrgs(db, userId);
    const orgDetails = orgs.map((org) => {
      const drives = listDrives(db, org.id);
      return {
        orgId: org.id,
        orgName: org.name,
        drives: drives.map((d) => ({
          driveId: d.id,
          driveName: d.name,
          role: getUserDriveRole(db, userId, d.id),
        })),
      };
    });

    const email = (extra.authInfo?.extra?.user as any)?.email;

    const result = {
      userId,
      ...(email ? { email } : {}),
      activeOrg: ctx.orgId,
      activeDrive: ctx.driveId,
      memberships: orgDetails,
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  });

  return server;
}
