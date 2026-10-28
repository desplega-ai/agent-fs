import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import {
  getProfile,
  updateProfile,
  profileUpdateSchema,
  resolveContext,
  dispatchOp,
  listUserOrgs,
  listDrivesForUser,
  getUserDriveRole,
  getUserByEmail,
  listOrgMembers,
  listDriveMembers,
  inviteToOrg,
  inviteAcceptUrl,
  listInvites,
  revokeInvite,
  acceptInvite,
  parseInviteToken,
  addDriveMember,
  updateOrgMemberRole,
  removeOrgMember,
  updateDriveMemberRole,
  removeDriveMember,
  requireOrgRole,
  requireDriveAdmin,
  assertDriveInOrg,
  VERSION,
} from "@/core";
import type { OpContext, DB, DriveGrant, EmbeddingProvider, StorageAdapter } from "@/core";
import { registerTools } from "./tools.js";

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface McpServerOptions {
  db: DB;
  s3: StorageAdapter;
  embeddingProvider: EmbeddingProvider | null;
  appUrl?: string;
  /** Public address of the API server, for absolute /share links. */
  apiUrl?: string;
  apiUrlSource?: "configured" | "request";
}

export function createMcpServer(options: McpServerOptions) {
  const { db, s3, embeddingProvider, appUrl, apiUrl, apiUrlSource } = options;

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
    return { db, s3, orgId: resolved.orgId, driveId: resolved.driveId, userId: user.id, embeddingProvider, appUrl, apiUrl, apiUrlSource };
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

  server.tool("profile-get", "Get your own profile.", {}, async (_params, extra) => {
    const result = getProfile(db, getContext(extra).userId);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
  server.tool("profile-set", "Update your own display name (null clears it).", profileUpdateSchema.shape, async (params, extra) => {
    try {
      const result = updateProfile(db, getContext(extra).userId, params);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: (err as Error).message }) }] };
    }
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
    "Invite a user to the current org by email (requires org admin). An email with an account is added at once (status 'added'); grants only raise, so the returned role and drives are what they hold afterwards, never lower than before (use member-update-role to lower one). An email without one gets a pending invite (status 'pending') with an acceptUrl (or token) valid 7 days: give it to the person, who registers that email and accepts it; this tool sends nothing. Pass drives to grant exactly those drives, each with its own role; omit drives to grant only the org's default drive with the org role; pass [] for org membership without drive access.",
    {
      email: z.string().describe("Email of the user to invite"),
      role: z.enum(["viewer", "editor", "admin"]).describe("Org role to assign"),
      drives: z
        .array(
          z.object({
            driveId: z.string().describe("Drive ID in the current org"),
            role: z.enum(["viewer", "editor", "admin"]).describe("Role on this drive"),
          })
        )
        .optional()
        .describe("Drives to grant. Omit for the default drive only."),
    },
    async (
      params: { email: string; role: "viewer" | "editor" | "admin"; drives?: DriveGrant[] },
      extra
    ) => {
      const ctx = getContext(extra);
      try {
        requireMemberAdmin(ctx);
        const result = inviteToOrg(db, {
          orgId: ctx.orgId,
          email: params.email,
          role: params.role,
          drives: params.drives,
          invitedBy: ctx.userId,
        });
        const body =
          result.status === "pending"
            ? {
                ok: true,
                status: result.status,
                invited: result.email,
                role: params.role,
                drives: result.drives,
                inviteId: result.inviteId,
                token: result.token,
                acceptUrl: inviteAcceptUrl(ctx.appUrl, result.token),
                expiresAt: result.expiresAt,
              }
            : { ok: true, status: result.status, invited: result.email, role: result.orgRole, drives: result.drives };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
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
    "member-invites",
    "List pending invites of the current org, or revoke one by passing revokeId (requires org admin). Expired invites are listed with expired: true.",
    { revokeId: z.string().optional().describe("Pending invite id to revoke. Omit to list.") },
    async (params: { revokeId?: string }, extra) => {
      const ctx = getContext(extra);
      try {
        requireMemberAdmin(ctx);
        if (params.revokeId) revokeInvite(db, { orgId: ctx.orgId, inviteId: params.revokeId });
        const body = params.revokeId
          ? { ok: true, revoked: params.revokeId }
          : { invites: listInvites(db, ctx.orgId) };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
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
    "invite-accept",
    "Accept an org invite as the current account. Pass the accept link or its token. The account's email must be the invited email.",
    { token: z.string().describe("Accept link (https://.../invite#<token>) or the bare token") },
    async (params: { token: string }, extra) => {
      const ctx = getContext(extra);
      try {
        const token = parseInviteToken(params.token);
        if (!token) throw new Error("Not an invite link or token");
        const result = acceptInvite(db, { token, userId: ctx.userId });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ...result }, null, 2) }],
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
    "member-add",
    "Add an existing member of the current org to a drive in the current org, (requires drive admin or org admin). Grants only raise: a role they already hold on the drive is never lowered, and the result carries the role they end up with. To lower a role, use member-update-role. To bring in someone outside the org, use member-invite.",
    {
      email: z.string().describe("Email of an existing org member"),
      driveId: z.string().describe("Drive ID in the current org"),
      role: z.enum(["viewer", "editor", "admin"]).describe("Role on the drive"),
    },
    async (params: { email: string; driveId: string; role: "viewer" | "editor" | "admin" }, extra) => {
      const ctx = getContext(extra);
      try {
        // Authorize before the email lookup so non-admins can't probe
        // whether an account exists.
        requireMemberAdmin(ctx, params.driveId);
        const result = addDriveMember(db, {
          orgId: ctx.orgId,
          driveId: params.driveId,
          email: params.email,
          role: params.role,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ...result }, null, 2) }],
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
