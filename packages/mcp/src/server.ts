import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import {
  resolveContext,
  dispatchOp,
  listUserOrgs,
  listDrivesForUser,
  getUserDriveRole,
  getUserByEmail,
  listOrgMembers,
  listDriveMembers,
  inviteToOrg,
  updateOrgMemberRole,
  removeOrgMember,
  updateDriveMemberRole,
  removeDriveMember,
  requireOrgRole,
  requireDriveAdmin,
  assertDriveInOrg,
  VERSION,
} from "@/core";
import type { OpContext, DB, EmbeddingProvider, StorageAdapter } from "@/core";
import { registerTools } from "./tools.js";

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface McpServerOptions {
  db: DB;
  s3: StorageAdapter;
  embeddingProvider: EmbeddingProvider | null;
  appUrl?: string;
}

export function createMcpServer(options: McpServerOptions) {
  const { db, s3, embeddingProvider, appUrl } = options;

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
    return { db, s3, orgId: resolved.orgId, driveId: resolved.driveId, userId: user.id, embeddingProvider, appUrl };
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

  registerIdentityTools(server, { db, getContext });

  return server;
}

/**
 * Register identity-related tools (whoami + member management).
 *
 * Exported separately from `createMcpServer` so tests can register the tools
 * on a mock server and invoke the captured handlers with synthetic auth
 * contexts (same pattern as `registerTools`).
 *
 * RBAC policy (mirrors HTTP member management):
 * - Org member list/invite/update/remove require org 'admin'.
 * - Drive member list/update/remove require drive 'admin' or org 'admin',
 *   and the drive must belong to the caller's active org.
 */
export function registerIdentityTools(
  server: McpServer,
  deps: { db: DB; getContext: (extra: Extra) => OpContext }
) {
  const { db, getContext } = deps;

  /**
   * Authorize a member-management call. Drive-scoped requests are bound to
   * the active org first (NotFound for unknown AND cross-org drives, so
   * other tenants' drive IDs are unprobeable), then require drive admin or
   * org admin. Org-scoped requests require org admin.
   */
  const requireMemberAdmin = (ctx: OpContext, driveId?: string) => {
    if (driveId) {
      assertDriveInOrg(db, { driveId, orgId: ctx.orgId });
      requireDriveAdmin(db, { userId: ctx.userId, driveId });
    } else {
      requireOrgRole(db, { userId: ctx.userId, orgId: ctx.orgId, requiredRole: "admin" });
    }
  };

  // whoami tool — lets agents check their identity and permissions
  server.tool("whoami", "Get current user identity, org memberships, and drive roles.", {}, async (_params, extra) => {
    const ctx = getContext(extra);
    const userId = ctx.userId;

    const orgs = listUserOrgs(db, userId);
    const orgDetails = orgs.map((org) => {
      // Strict membership: only drives the user is an explicit member of.
      const drives = listDrivesForUser(db, org.id, userId);
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

  // --- Member management tools ---

  server.tool(
    "member-list",
    "List members of the current org (requires org admin), or a specific drive in the current org (requires drive admin or org admin) if driveId is provided.",
    { driveId: z.string().optional().describe("Drive ID to list members for. Omit for org members.") },
    async (params: { driveId?: string }, extra) => {
      const ctx = getContext(extra);
      try {
        requireMemberAdmin(ctx, params.driveId);
        const members = params.driveId
          ? listDriveMembers(db, params.driveId)
          : listOrgMembers(db, ctx.orgId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ members }, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }, null, 2) }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "member-invite",
    "Invite a user to the current org by email (requires org admin). The user must already have an agent-fs account.",
    {
      email: z.string().describe("Email of the user to invite"),
      role: z.enum(["viewer", "editor", "admin"]).describe("Role to assign"),
    },
    async (params: { email: string; role: "viewer" | "editor" | "admin" }, extra) => {
      const ctx = getContext(extra);
      try {
        requireMemberAdmin(ctx);
        inviteToOrg(db, { orgId: ctx.orgId, email: params.email, role: params.role });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: true, invited: params.email, role: params.role }, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }, null, 2) }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "member-update-role",
    "Update a member's role in the current org (requires org admin) or a specific drive in the current org (requires drive admin or org admin).",
    {
      email: z.string().describe("Email of the member"),
      role: z.enum(["viewer", "editor", "admin"]).describe("New role"),
      driveId: z.string().optional().describe("Drive ID to update role for. Omit for org role."),
    },
    async (params: { email: string; role: "viewer" | "editor" | "admin"; driveId?: string }, extra) => {
      const ctx = getContext(extra);
      try {
        // Authorize before the email lookup so non-admins can't probe
        // whether an account exists.
        requireMemberAdmin(ctx, params.driveId);
        const user = getUserByEmail(db, params.email);
        if (!user) throw new Error(`User with email ${params.email} not found`);
        if (params.driveId) {
          updateDriveMemberRole(db, { driveId: params.driveId, userId: user.id, role: params.role });
        } else {
          updateOrgMemberRole(db, { orgId: ctx.orgId, userId: user.id, role: params.role });
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: true, email: params.email, role: params.role }, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }, null, 2) }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "member-remove",
    "Remove a member from the current org (cascades to all drives; requires org admin) or from a specific drive in the current org only (requires drive admin or org admin).",
    {
      email: z.string().describe("Email of the member to remove"),
      driveId: z.string().optional().describe("Drive ID to remove from. Omit to remove from org."),
    },
    async (params: { email: string; driveId?: string }, extra) => {
      const ctx = getContext(extra);
      try {
        // Authorize before the email lookup so non-admins can't probe
        // whether an account exists.
        requireMemberAdmin(ctx, params.driveId);
        const user = getUserByEmail(db, params.email);
        if (!user) throw new Error(`User with email ${params.email} not found`);
        if (params.driveId) {
          removeDriveMember(db, { driveId: params.driveId, userId: user.id });
        } else {
          removeOrgMember(db, { orgId: ctx.orgId, userId: user.id });
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: true, removed: params.email }, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }, null, 2) }],
          isError: true,
        };
      }
    }
  );
}
