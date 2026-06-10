import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, schema } from "../../db/index.js";
import type { DB } from "../../db/index.js";
import { createUser, getUserByApiKey, getUserByEmail } from "../users.js";
import { createOrg, listUserOrgs, getOrg, inviteToOrg } from "../orgs.js";
import {
  createDrive,
  listDrives,
  listDrivesForUser,
  getDrive,
  setDriveMember,
} from "../drives.js";
import {
  checkPermission,
  getRequiredRole,
  getUserDriveRole,
  getUserOrgRole,
  roleAtLeast,
  requireDriveRole,
  requireOrgRole,
  requireDriveAdmin,
  assertDriveInOrg,
} from "../rbac.js";
import { resolveContext } from "../context.js";
import { NotFoundError, PermissionDeniedError } from "../../errors.js";

const TEST_DB = join(tmpdir(), `agent-fs-identity-test-${Date.now()}.db`);
let db: DB;

beforeAll(() => {
  db = createDatabase(TEST_DB);
}, 30_000);

afterAll(() => {
  try {
    unlinkSync(TEST_DB);
    unlinkSync(TEST_DB + "-wal");
    unlinkSync(TEST_DB + "-shm");
  } catch {}
});

describe("User management", () => {
  let userId: string;
  let apiKey: string;

  test("createUser creates user with API key, personal org, and default drive", () => {
    const result = createUser(db, { email: "alice@example.com" });

    expect(result.user.email).toBe("alice@example.com");
    expect(result.apiKey).toMatch(/^af_[0-9a-f]{64}$/);
    userId = result.user.id;
    apiKey = result.apiKey;

    // Should have a personal org
    const orgs = listUserOrgs(db, userId);
    expect(orgs.length).toBe(1);
    expect(orgs[0].isPersonal).toBe(true);
    expect(orgs[0].role).toBe("admin");

    // Org should have a default drive
    const drives = listDrives(db, orgs[0].id);
    expect(drives.length).toBe(1);
    expect(drives[0].isDefault).toBe(true);
  });

  test("getUserByApiKey returns user for valid key", () => {
    const user = getUserByApiKey(db, apiKey);
    expect(user).not.toBeNull();
    expect(user!.id).toBe(userId);
    expect(user!.email).toBe("alice@example.com");
  });

  test("getUserByApiKey returns null for invalid key", () => {
    const user = getUserByApiKey(db, "af_invalid");
    expect(user).toBeNull();
  });

  test("getUserByEmail returns user", () => {
    const user = getUserByEmail(db, "alice@example.com");
    expect(user).not.toBeNull();
    expect(user!.id).toBe(userId);
  });

  test("API key is stored as hash, not plaintext", () => {
    const raw = db
      .select()
      .from(schema.users)
      .where(require("drizzle-orm").eq(schema.users.id, userId))
      .get();

    expect(raw!.apiKeyHash).not.toBe(apiKey);
    expect(raw!.apiKeyHash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
  });
});

describe("Org & invite flow", () => {
  let aliceId: string;
  let bobId: string;
  let orgId: string;

  beforeAll(() => {
    const alice = getUserByEmail(db, "alice@example.com")!;
    aliceId = alice.id;
    orgId = listUserOrgs(db, aliceId)[0].id;

    const bob = createUser(db, { email: "bob@example.com" });
    bobId = bob.user.id;
  });

  test("invite user to org as viewer", () => {
    inviteToOrg(db, { orgId, email: "bob@example.com", role: "viewer" });

    const bobOrgs = listUserOrgs(db, bobId);
    expect(bobOrgs.some((o) => o.id === orgId && o.role === "viewer")).toBe(true);
  });
});

describe("RBAC enforcement", () => {
  let aliceId: string;
  let bobId: string;
  let driveId: string;

  beforeAll(() => {
    aliceId = getUserByEmail(db, "alice@example.com")!.id;
    bobId = getUserByEmail(db, "bob@example.com")!.id;
    const orgs = listUserOrgs(db, aliceId);
    const drives = listDrives(db, orgs[0].id);
    driveId = drives[0].id;
  });

  test("admin can do anything", () => {
    expect(() =>
      checkPermission(db, { userId: aliceId, driveId, requiredRole: "admin" })
    ).not.toThrow();
  });

  test("viewer can read", () => {
    expect(() =>
      checkPermission(db, { userId: bobId, driveId, requiredRole: "viewer" })
    ).not.toThrow();
  });

  test("viewer cannot write", () => {
    expect(() =>
      checkPermission(db, { userId: bobId, driveId, requiredRole: "editor" })
    ).toThrow(PermissionDeniedError);
  });

  test("permission denied error includes roles", () => {
    try {
      checkPermission(db, { userId: bobId, driveId, requiredRole: "editor" });
      expect(true).toBe(false); // Should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(PermissionDeniedError);
      const json = (err as PermissionDeniedError).toJSON();
      expect(json.required_role).toBe("editor");
      expect(json.your_role).toBe("viewer");
    }
  });

  test("getRequiredRole maps ops correctly", () => {
    expect(getRequiredRole("cat")).toBe("viewer");
    expect(getRequiredRole("write")).toBe("editor");
    expect(getRequiredRole("unknown")).toBe("admin");
  });

  test("upgrade role allows write", () => {
    setDriveMember(db, { driveId, userId: bobId, role: "editor" });
    expect(() =>
      checkPermission(db, { userId: bobId, driveId, requiredRole: "editor" })
    ).not.toThrow();
  });
});

describe("Drive context resolution", () => {
  test("resolves to personal org default drive by default", () => {
    const userId = getUserByEmail(db, "alice@example.com")!.id;
    const ctx = resolveContext(db, { userId });

    expect(ctx.orgId).toBeTruthy();
    expect(ctx.driveId).toBeTruthy();
    expect(ctx.role).toBe("admin");
  });

  test("resolves explicit orgId to default drive", () => {
    const userId = getUserByEmail(db, "alice@example.com")!.id;
    const orgs = listUserOrgs(db, userId);
    const ctx = resolveContext(db, { userId, orgId: orgs[0].id });

    expect(ctx.orgId).toBe(orgs[0].id);
    expect(ctx.driveId).toBeTruthy();
  });

  test("resolves explicit driveId", () => {
    const userId = getUserByEmail(db, "alice@example.com")!.id;
    const orgs = listUserOrgs(db, userId);
    const drives = listDrives(db, orgs[0].id);

    const ctx = resolveContext(db, { userId, driveId: drives[0].id });
    expect(ctx.driveId).toBe(drives[0].id);
  });
});

describe("Context org/drive binding", () => {
  let ownerId: string;
  let personalOrgId: string;
  let secondOrgId: string;
  let secondOrgDriveId: string;

  beforeAll(() => {
    // Self-sufficient: works standalone under --test-name-pattern.
    ownerId = createUser(db, { email: "ctx-owner@example.com" }).user.id;
    personalOrgId = listUserOrgs(db, ownerId).find((o) => o.isPersonal)!.id;

    const secondOrg = createOrg(db, { name: "ctx-second", userId: ownerId });
    secondOrgId = secondOrg.id;
    secondOrgDriveId = listDrives(db, secondOrgId)[0].id;
  });

  test("resolveContext accepts driveId belonging to the given orgId", () => {
    const ctx = resolveContext(db, {
      userId: ownerId,
      orgId: secondOrgId,
      driveId: secondOrgDriveId,
    });

    expect(ctx.orgId).toBe(secondOrgId);
    expect(ctx.driveId).toBe(secondOrgDriveId);
  });

  test("resolveContext rejects driveId from another org", () => {
    expect(() =>
      resolveContext(db, {
        userId: ownerId,
        orgId: personalOrgId,
        driveId: secondOrgDriveId,
      })
    ).toThrow(NotFoundError);
  });

  test("resolveContext rejects unknown driveId", () => {
    expect(() =>
      resolveContext(db, { userId: ownerId, driveId: "no-such-drive" })
    ).toThrow(NotFoundError);
  });
});

describe("Strict drive membership", () => {
  let aliceId: string;
  let bobId: string;
  let orgId: string;

  beforeAll(() => {
    // Self-sufficient: works standalone under --test-name-pattern.
    aliceId = createUser(db, { email: "strict-owner@example.com" }).user.id;
    bobId = createUser(db, { email: "strict-peer@example.com" }).user.id;
    orgId = listUserOrgs(db, aliceId).find((o) => o.isPersonal)!.id;
    // Peer joins the org (and its default drive) as viewer.
    inviteToOrg(db, { orgId, email: "strict-peer@example.com", role: "viewer" });
  });

  test("newly-created drive has explicit creator membership", () => {
    const drive = createDrive(db, {
      orgId,
      name: "with-creator",
      creatorUserId: aliceId,
    });

    expect(getUserDriveRole(db, aliceId, drive.id)).toBe("admin");

    const visible = listDrivesForUser(db, orgId, aliceId);
    expect(visible.some((d) => d.id === drive.id)).toBe(true);
  });

  test("drive without any membership rows is visible to no one", () => {
    const drive = createDrive(db, { orgId, name: "zero-members" });

    // Not even the org admin can see it via listDrivesForUser — the old
    // "zero members means public" fallback is gone.
    const aliceVisible = listDrivesForUser(db, orgId, aliceId);
    expect(aliceVisible.some((d) => d.id === drive.id)).toBe(false);

    const bobVisible = listDrivesForUser(db, orgId, bobId);
    expect(bobVisible.some((d) => d.id === drive.id)).toBe(false);

    // It still exists in the unfiltered org listing.
    const all = listDrives(db, orgId);
    expect(all.some((d) => d.id === drive.id)).toBe(true);
  });

  test("listDrivesForUser excludes drives where user is not a member", () => {
    const drive = createDrive(db, {
      orgId,
      name: "alice-only",
      creatorUserId: aliceId,
    });

    const bobVisible = listDrivesForUser(db, orgId, bobId);
    expect(bobVisible.some((d) => d.id === drive.id)).toBe(false);

    // Explicit membership makes it visible.
    setDriveMember(db, { driveId: drive.id, userId: bobId, role: "viewer" });
    const bobVisibleAfter = listDrivesForUser(db, orgId, bobId);
    expect(bobVisibleAfter.some((d) => d.id === drive.id)).toBe(true);
  });
});

describe("Org and drive authorization helpers", () => {
  let aliceId: string;
  let bobId: string;
  let strangerId: string;
  let orgId: string;
  let driveId: string;

  beforeAll(() => {
    // Self-sufficient: works standalone under --test-name-pattern.
    aliceId = createUser(db, { email: "authz-admin@example.com" }).user.id;
    bobId = createUser(db, { email: "authz-viewer@example.com" }).user.id;
    strangerId = createUser(db, { email: "authz-stranger@example.com" }).user.id;
    orgId = listUserOrgs(db, aliceId).find((o) => o.isPersonal)!.id;
    driveId = listDrives(db, orgId).find((d) => d.isDefault)!.id;
    // Bob joins the org (and its default drive) as viewer.
    inviteToOrg(db, { orgId, email: "authz-viewer@example.com", role: "viewer" });
  });

  test("roleAtLeast compares role levels", () => {
    expect(roleAtLeast("admin", "viewer")).toBe(true);
    expect(roleAtLeast("editor", "editor")).toBe(true);
    expect(roleAtLeast("viewer", "editor")).toBe(false);
    expect(roleAtLeast(null, "viewer")).toBe(false);
    expect(roleAtLeast(undefined, "viewer")).toBe(false);
  });

  test("getUserOrgRole returns explicit org role or null", () => {
    expect(getUserOrgRole(db, aliceId, orgId)).toBe("admin");
    expect(getUserOrgRole(db, bobId, orgId)).toBe("viewer");
    expect(getUserOrgRole(db, strangerId, orgId)).toBeNull();
  });

  test("requireOrgRole passes for sufficient role and returns it", () => {
    expect(requireOrgRole(db, { userId: aliceId, orgId, requiredRole: "admin" })).toBe("admin");
    expect(requireOrgRole(db, { userId: bobId, orgId, requiredRole: "viewer" })).toBe("viewer");
  });

  test("requireOrgRole throws for insufficient role or non-member", () => {
    expect(() =>
      requireOrgRole(db, { userId: bobId, orgId, requiredRole: "admin" })
    ).toThrow(PermissionDeniedError);

    expect(() =>
      requireOrgRole(db, { userId: strangerId, orgId, requiredRole: "viewer" })
    ).toThrow(PermissionDeniedError);
  });

  test("requireDriveRole returns the actual role on success", () => {
    expect(
      requireDriveRole(db, { userId: aliceId, driveId, requiredRole: "editor" })
    ).toBe("admin");
    expect(() =>
      requireDriveRole(db, { userId: bobId, driveId, requiredRole: "admin" })
    ).toThrow(PermissionDeniedError);
  });

  test("requireDriveAdmin passes for explicit drive admin", () => {
    expect(requireDriveAdmin(db, { userId: aliceId, driveId })).toBe("admin");
  });

  test("requireDriveAdmin falls back to org admin without drive row", () => {
    // Alice is org admin; create a drive she has no membership row on.
    const drive = createDrive(db, { orgId, name: "org-admin-fallback" });
    expect(getUserDriveRole(db, aliceId, drive.id)).toBeNull();

    expect(requireDriveAdmin(db, { userId: aliceId, driveId: drive.id })).toBe("admin");
  });

  test("requireDriveAdmin rejects non-admins and unknown drives", () => {
    // Bob is org viewer and drive viewer — neither satisfies admin.
    expect(() => requireDriveAdmin(db, { userId: bobId, driveId })).toThrow(
      PermissionDeniedError
    );
    expect(() =>
      requireDriveAdmin(db, { userId: aliceId, driveId: "no-such-drive" })
    ).toThrow(NotFoundError);
  });

  test("assertDriveInOrg binds drive to org", () => {
    const drive = assertDriveInOrg(db, { driveId, orgId });
    expect(drive.id).toBe(driveId);
    expect(drive.orgId).toBe(orgId);

    const otherOrg = createOrg(db, { name: "other-org", userId: aliceId });
    expect(() =>
      assertDriveInOrg(db, { driveId, orgId: otherOrg.id })
    ).toThrow(NotFoundError);
    expect(() =>
      assertDriveInOrg(db, { driveId: "no-such-drive", orgId })
    ).toThrow(NotFoundError);
  });
});

describe("Drive membership backfill migration", () => {
  let carolId: string;
  let daveId: string;
  let teamOrgId: string;
  let teamDefaultDriveId: string;
  let legacyDriveId: string;

  beforeAll(() => {
    carolId = createUser(db, { email: "carol@example.com" }).user.id;
    daveId = createUser(db, { email: "dave@example.com" }).user.id;

    const teamOrg = createOrg(db, { name: "carol-team", userId: carolId });
    teamOrgId = teamOrg.id;
    teamDefaultDriveId = listDrives(db, teamOrgId).find((d) => d.isDefault)!.id;

    // Dave joins as org editor (also gets editor on the default drive).
    inviteToOrg(db, { orgId: teamOrgId, email: "dave@example.com", role: "editor" });

    // Simulate a pre-strict-membership drive: zero member rows.
    legacyDriveId = createDrive(db, { orgId: teamOrgId, name: "legacy" }).id;
  });

  test("backfills empty drive members for org admins", () => {
    // Before backfill: invisible to everyone under strict membership.
    expect(
      listDrivesForUser(db, teamOrgId, carolId).some((d) => d.id === legacyDriveId)
    ).toBe(false);
    expect(getUserDriveRole(db, carolId, legacyDriveId)).toBeNull();

    // Re-running createDatabase on the same file re-runs migrations.
    createDatabase(TEST_DB);

    // Org admin carol got an explicit admin row; org editor dave did not.
    expect(getUserDriveRole(db, carolId, legacyDriveId)).toBe("admin");
    expect(getUserDriveRole(db, daveId, legacyDriveId)).toBeNull();

    expect(
      listDrivesForUser(db, teamOrgId, carolId).some((d) => d.id === legacyDriveId)
    ).toBe(true);
    expect(
      listDrivesForUser(db, teamOrgId, daveId).some((d) => d.id === legacyDriveId)
    ).toBe(false);
  });

  test("backfill does not touch drives that already have members", () => {
    // Default drive memberships are unchanged: carol admin, dave editor.
    expect(getUserDriveRole(db, carolId, teamDefaultDriveId)).toBe("admin");
    expect(getUserDriveRole(db, daveId, teamDefaultDriveId)).toBe("editor");
  });

  test("backfill is idempotent", () => {
    createDatabase(TEST_DB);

    const rows = db
      .select()
      .from(schema.driveMembers)
      .where(require("drizzle-orm").eq(schema.driveMembers.driveId, legacyDriveId))
      .all();

    expect(rows.length).toBe(1);
    expect(rows[0].userId).toBe(carolId);
    expect(rows[0].role).toBe("admin");
  });
});
