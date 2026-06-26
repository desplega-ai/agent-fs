import { describe, test, expect } from "bun:test";
import { z } from "zod";
import {
  getRegisteredOps,
  getOpDefinition,
  createUser,
  createOrg,
  inviteToOrg,
  createDrive,
  listDrives,
  setDriveMember,
  getUserOrgRole,
  getUserDriveRole,
} from "@/core";
import type { OpContext } from "@/core";
import { registerTools } from "../tools.js";
import { registerIdentityTools } from "../server.js";
import { createTestContext, createTestDb, MockS3Client } from "../../../core/src/test-utils.js";

describe("registerTools", () => {
  test("registers all ops as MCP tools", () => {
    const registeredTools: Array<{ name: string; description: string }> = [];

    // Mock McpServer with just the tool() method
    const mockServer = {
      tool: (name: string, description: string, _schema: any, _handler: any) => {
        registeredTools.push({ name, description });
      },
    };

    const { ctx } = createTestContext();
    registerTools(mockServer as any, () => ctx);

    const ops = getRegisteredOps();
    expect(registeredTools.length).toBe(ops.length);

    for (const op of ops) {
      expect(registeredTools.some((t) => t.name === op)).toBe(true);
    }
  });

  test("tool descriptions are rich descriptions from the registry", () => {
    const registeredTools: Array<{ name: string; description: string }> = [];

    const mockServer = {
      tool: (name: string, description: string, _schema: any, _handler: any) => {
        registeredTools.push({ name, description });
      },
    };

    const { ctx } = createTestContext();
    registerTools(mockServer as any, () => ctx);

    for (const tool of registeredTools) {
      // Descriptions should be rich (not just "agentfs <op>")
      expect(tool.description.length).toBeGreaterThan(20);
      // Descriptions should match the registry
      const def = getOpDefinition(tool.name);
      expect(tool.description).toBe(def!.description);
    }
  });

  test("tool handler calls dispatchOp and returns MCP text response", async () => {
    let capturedHandler: ((params: any) => Promise<any>) | null = null;

    const mockServer = {
      tool: (name: string, _desc: string, _schema: any, handler: any) => {
        if (name === "write") capturedHandler = handler;
      },
    };

    const { ctx } = createTestContext();
    registerTools(mockServer as any, () => ctx);

    expect(capturedHandler).not.toBeNull();

    // Call the write handler
    const result = await capturedHandler!({
      path: "/mcp-test.txt",
      content: "MCP test content",
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.version).toBe(1);
    expect(parsed.path).toBe("/mcp-test.txt");
  });
});

describe("ops tool error surfacing", () => {
  test("revert on a no-versioning backend returns isError with the message (no raw throw)", async () => {
    const handlers = new Map<string, (params: any, extra: any) => Promise<any>>();
    const mockServer = {
      tool: (name: string, _desc: string, _schema: any, handler: any) => {
        handlers.set(name, handler);
      },
    };

    const { ctx } = createTestContext({ capabilities: { versioning: false } });
    registerTools(mockServer as any, () => ctx);

    // Seed a file via the captured write handler so a version row exists.
    const write = handlers.get("write")!;
    await write({ path: "/mcp-cap.txt", content: "v1" }, {});

    const revertHandler = handlers.get("revert")!;
    // Must resolve to an isError result, NOT reject — surfaced cleanly to the agent.
    const result = await revertHandler({ path: "/mcp-cap.txt", version: 1 }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe("text");
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe("UNSUPPORTED_OPERATION");
    expect(body.message).toContain("not supported");
    expect(body.suggestion).toBeTruthy();
  });
});

// --- Identity tool harness ---

type ToolHandler = (params: any, extra: any) => Promise<any>;
type TestUser = { id: string; email: string };

/**
 * Build a multi-user world for exercising the identity tool handlers:
 * - `sharedOrg` owned by `admin` (org admin + default-drive admin)
 * - `editor` / `viewer` invited with matching org + default-drive roles
 * - `outsider` with no membership in `sharedOrg`, but admin of `foreignOrg`
 *
 * All handlers run with the active org pinned to `sharedOrg` (mirrors the
 * production `getContext`, which binds member tools to the resolved org).
 */
function createIdentityHarness() {
  const db = createTestDb();
  const s3 = new MockS3Client();

  const { user: admin } = createUser(db, { email: "admin@example.com" });
  const { user: editor } = createUser(db, { email: "editor@example.com" });
  const { user: viewer } = createUser(db, { email: "viewer@example.com" });
  const { user: outsider } = createUser(db, { email: "outsider@example.com" });

  const sharedOrg = createOrg(db, { name: "shared", userId: admin.id });
  inviteToOrg(db, { orgId: sharedOrg.id, email: editor.email, role: "editor" });
  inviteToOrg(db, { orgId: sharedOrg.id, email: viewer.email, role: "viewer" });
  const sharedDriveId = listDrives(db, sharedOrg.id).find((d) => d.isDefault)!.id;

  const foreignOrg = createOrg(db, { name: "foreign", userId: outsider.id });
  const foreignDriveId = listDrives(db, foreignOrg.id).find((d) => d.isDefault)!.id;

  const handlers = new Map<string, ToolHandler>();
  const mockServer = {
    tool: (name: string, _desc: string, _schema: any, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };

  const getContext = (extra: any): OpContext => {
    const user = extra.authInfo.extra.user as TestUser;
    return {
      db,
      s3: s3 as any,
      orgId: sharedOrg.id,
      driveId: sharedDriveId,
      userId: user.id,
      embeddingProvider: null,
    };
  };

  registerIdentityTools(mockServer as any, { db, getContext });

  const call = async (tool: string, params: any, user: TestUser) => {
    const handler = handlers.get(tool);
    if (!handler) throw new Error(`Tool not registered: ${tool}`);
    const result = await handler(params, {
      authInfo: { extra: { user } },
    });
    return { result, body: JSON.parse(result.content[0].text) };
  };

  return {
    db,
    sharedOrg,
    sharedDriveId,
    foreignOrg,
    foreignDriveId,
    admin,
    editor,
    viewer,
    outsider,
    handlers,
    call,
  };
}

describe("member tool RBAC", () => {
  test("registers whoami and all member tools", () => {
    const h = createIdentityHarness();
    expect([...h.handlers.keys()].sort()).toEqual(
      ["member-invite", "member-list", "member-remove", "member-update-role", "whoami"].sort()
    );
  });

  test("org member list requires org admin", async () => {
    const h = createIdentityHarness();

    for (const user of [h.viewer, h.editor]) {
      const { result, body } = await h.call("member-list", {}, user);
      expect(result.isError).toBe(true);
      expect(body.error).toContain("requires 'admin' role");
    }

    const { result, body } = await h.call("member-list", {}, h.admin);
    expect(result.isError).toBeUndefined();
    const emails = body.members.map((m: any) => m.email).sort();
    expect(emails).toEqual(["admin@example.com", "editor@example.com", "viewer@example.com"]);
  });

  test("org member list rejects non-members of the org", async () => {
    const h = createIdentityHarness();
    const { result, body } = await h.call("member-list", {}, h.outsider);
    expect(result.isError).toBe(true);
    expect(body.error).toContain("do not have access");
  });

  test("member-invite requires org admin", async () => {
    const h = createIdentityHarness();

    const denied = await h.call(
      "member-invite",
      { email: h.outsider.email, role: "viewer" },
      h.editor
    );
    expect(denied.result.isError).toBe(true);
    expect(getUserOrgRole(h.db, h.outsider.id, h.sharedOrg.id)).toBeNull();

    const allowed = await h.call(
      "member-invite",
      { email: h.outsider.email, role: "viewer" },
      h.admin
    );
    expect(allowed.result.isError).toBeUndefined();
    expect(allowed.body.ok).toBe(true);
    expect(getUserOrgRole(h.db, h.outsider.id, h.sharedOrg.id)).toBe("viewer");
  });

  test("org member-update-role requires org admin", async () => {
    const h = createIdentityHarness();

    const denied = await h.call(
      "member-update-role",
      { email: h.viewer.email, role: "editor" },
      h.editor
    );
    expect(denied.result.isError).toBe(true);
    expect(getUserOrgRole(h.db, h.viewer.id, h.sharedOrg.id)).toBe("viewer");

    const allowed = await h.call(
      "member-update-role",
      { email: h.viewer.email, role: "editor" },
      h.admin
    );
    expect(allowed.result.isError).toBeUndefined();
    expect(getUserOrgRole(h.db, h.viewer.id, h.sharedOrg.id)).toBe("editor");
  });

  test("org member-remove requires org admin", async () => {
    const h = createIdentityHarness();

    const denied = await h.call("member-remove", { email: h.viewer.email }, h.editor);
    expect(denied.result.isError).toBe(true);
    expect(getUserOrgRole(h.db, h.viewer.id, h.sharedOrg.id)).toBe("viewer");

    const allowed = await h.call("member-remove", { email: h.viewer.email }, h.admin);
    expect(allowed.result.isError).toBeUndefined();
    expect(getUserOrgRole(h.db, h.viewer.id, h.sharedOrg.id)).toBeNull();
    expect(getUserDriveRole(h.db, h.viewer.id, h.sharedDriveId)).toBeNull();
  });

  test("non-admins cannot probe account existence via member tools", async () => {
    const h = createIdentityHarness();
    const { result, body } = await h.call(
      "member-remove",
      { email: "ghost@example.com" },
      h.viewer
    );
    expect(result.isError).toBe(true);
    // Permission error, not "user not found" — the email lookup must not run.
    expect(body.error).toContain("requires 'admin' role");
    expect(body.error).not.toContain("not found");
  });

  test("drive member list requires drive admin or org admin", async () => {
    const h = createIdentityHarness();

    // Drive editor is not enough.
    const denied = await h.call("member-list", { driveId: h.sharedDriveId }, h.editor);
    expect(denied.result.isError).toBe(true);
    expect(denied.body.error).toContain("drive admin or org admin");

    // Explicit drive admin works, even though org role is still 'editor'.
    setDriveMember(h.db, { driveId: h.sharedDriveId, userId: h.editor.id, role: "admin" });
    const asDriveAdmin = await h.call("member-list", { driveId: h.sharedDriveId }, h.editor);
    expect(asDriveAdmin.result.isError).toBeUndefined();
    expect(asDriveAdmin.body.members.length).toBeGreaterThan(0);
  });

  test("org admin can manage drives without an explicit drive membership", async () => {
    const h = createIdentityHarness();

    // Drive created by editor — admin has no drive_members row for it.
    const drive = createDrive(h.db, {
      orgId: h.sharedOrg.id,
      name: "editor-drive",
      creatorUserId: h.editor.id,
    });
    expect(getUserDriveRole(h.db, h.admin.id, drive.id)).toBeNull();

    const { result, body } = await h.call("member-list", { driveId: drive.id }, h.admin);
    expect(result.isError).toBeUndefined();
    expect(body.members.map((m: any) => m.email)).toEqual([h.editor.email]);
  });

  test("drive admin can update and remove drive members", async () => {
    const h = createIdentityHarness();
    setDriveMember(h.db, { driveId: h.sharedDriveId, userId: h.editor.id, role: "admin" });

    const updated = await h.call(
      "member-update-role",
      { email: h.viewer.email, role: "editor", driveId: h.sharedDriveId },
      h.editor
    );
    expect(updated.result.isError).toBeUndefined();
    expect(getUserDriveRole(h.db, h.viewer.id, h.sharedDriveId)).toBe("editor");
    // Org role untouched — drive-scoped update only.
    expect(getUserOrgRole(h.db, h.viewer.id, h.sharedOrg.id)).toBe("viewer");

    const removed = await h.call(
      "member-remove",
      { email: h.viewer.email, driveId: h.sharedDriveId },
      h.editor
    );
    expect(removed.result.isError).toBeUndefined();
    expect(getUserDriveRole(h.db, h.viewer.id, h.sharedDriveId)).toBeNull();
    expect(getUserOrgRole(h.db, h.viewer.id, h.sharedOrg.id)).toBe("viewer");
  });

  test("drive-scoped tools reject driveIds outside the active org", async () => {
    const h = createIdentityHarness();

    // Even the org admin of the active org cannot reach a foreign drive...
    for (const [tool, params] of [
      ["member-list", { driveId: h.foreignDriveId }],
      ["member-update-role", { email: h.viewer.email, role: "viewer", driveId: h.foreignDriveId }],
      ["member-remove", { email: h.viewer.email, driveId: h.foreignDriveId }],
    ] as const) {
      const { result, body } = await h.call(tool, params, h.admin);
      expect(result.isError).toBe(true);
      expect(body.error).toContain("Drive not found in org");
    }

    // ...and neither can the foreign drive's own admin via this org's context.
    const { result, body } = await h.call(
      "member-list",
      { driveId: h.foreignDriveId },
      h.outsider
    );
    expect(result.isError).toBe(true);
    expect(body.error).toContain("Drive not found in org");
  });
});

describe("whoami hides inaccessible drives", () => {
  test("only drives with explicit membership are listed", async () => {
    const h = createIdentityHarness();

    // Drive in the shared org that viewer is NOT a member of.
    const secret = createDrive(h.db, {
      orgId: h.sharedOrg.id,
      name: "secret",
      creatorUserId: h.admin.id,
    });

    const viewerWhoami = await h.call("whoami", {}, h.viewer);
    const viewerOrg = viewerWhoami.body.memberships.find(
      (m: any) => m.orgId === h.sharedOrg.id
    );
    expect(viewerOrg).toBeDefined();
    expect(viewerOrg.drives.map((d: any) => d.driveId)).toEqual([h.sharedDriveId]);
    expect(viewerOrg.drives[0].role).toBe("viewer");

    const adminWhoami = await h.call("whoami", {}, h.admin);
    const adminOrg = adminWhoami.body.memberships.find(
      (m: any) => m.orgId === h.sharedOrg.id
    );
    expect(adminOrg.drives.map((d: any) => d.driveId).sort()).toEqual(
      [h.sharedDriveId, secret.id].sort()
    );
    // No null roles leak through under strict membership.
    for (const membership of adminWhoami.body.memberships) {
      for (const drive of membership.drives) {
        expect(drive.role).not.toBeNull();
      }
    }
  });

  test("foreign orgs and their drives never appear", async () => {
    const h = createIdentityHarness();
    const { body } = await h.call("whoami", {}, h.viewer);
    const orgIds = body.memberships.map((m: any) => m.orgId);
    expect(orgIds).not.toContain(h.foreignOrg.id);
    const allDriveIds = body.memberships.flatMap((m: any) =>
      m.drives.map((d: any) => d.driveId)
    );
    expect(allDriveIds).not.toContain(h.foreignDriveId);
  });
});

describe("Schema conversion", () => {
  test("all op schemas are ZodObject instances", () => {
    const ops = getRegisteredOps();
    for (const op of ops) {
      const def = getOpDefinition(op);
      expect(def).toBeDefined();
      // All our op schemas should be ZodObject
      expect(def!.schema).toBeInstanceOf(z.ZodObject);
    }
  });

  test("ZodObject schemas have extractable shape", () => {
    const ops = getRegisteredOps();
    for (const op of ops) {
      const def = getOpDefinition(op);
      if (def!.schema instanceof z.ZodObject) {
        const shape = (def!.schema as z.ZodObject<any>).shape;
        expect(typeof shape).toBe("object");
      }
    }
  });
});
