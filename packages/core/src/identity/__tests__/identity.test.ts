import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, schema } from "../../db/index.js";
import type { DB } from "../../db/index.js";
import { createUser, getUserByApiKey, getUserByEmail } from "../users.js";
import { listUserOrgs, getOrg, inviteToOrg } from "../orgs.js";
import { listDrives, getDrive, setDriveMember } from "../drives.js";
import { checkPermission, getRequiredRole, getUserDriveRole } from "../rbac.js";
import { resolveContext } from "../context.js";
import { PermissionDeniedError } from "../../errors.js";

const TEST_DB = join(tmpdir(), `agent-fs-identity-test-${Date.now()}.db`);
let db: DB;

beforeAll(() => {
  db = createDatabase(TEST_DB);
});

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
