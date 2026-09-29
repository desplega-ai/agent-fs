import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "../../db/index.js";
import { LocalStorageAdapter } from "../../storage/local-adapter.js";
import { createTestContext } from "../../test-utils.js";
import { createUser } from "../../identity/users.js";
import { listUserOrgs } from "../../identity/orgs.js";
import { listDrives } from "../../identity/drives.js";
import { dispatchOp } from "../index.js";
import { assertPathInsideDrive } from "../paths.js";
import { getS3Key } from "../versioning.js";
import { findShareByToken, shareStorageKey } from "../share.js";
import type { ShareCreateResult } from "../share.js";
import type { OpContext } from "../types.js";

/**
 * Two unrelated users on the REAL local-filesystem adapter, which resolves a
 * key against the whole storage root: a drive's files are only isolated from
 * each other by the path we build, so `share-create` must never accept a path
 * that can leave the caller's own drive.
 */
describe("share-create path isolation (local-filesystem backend)", () => {
  let root: string;
  let db: ReturnType<typeof createTestContext>["db"];
  let attacker: OpContext;
  let victim: OpContext;
  let victimKeyPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "afs-share-iso-"));
    const base = createTestContext();
    db = base.db;
    const s3 = new LocalStorageAdapter({ root });
    attacker = { ...base.ctx, s3, apiUrl: "https://api.example.test" };

    const v = createUser(base.db, { email: "victim@example.com" });
    const org = listUserOrgs(base.db, v.user.id)[0];
    const drive = listDrives(base.db, org.id)[0];
    victim = { ...base.ctx, s3, userId: v.user.id, orgId: org.id, driveId: drive.id };

    await dispatchOp(victim, "write", { path: "/secret.txt", content: "VICTIM-SECRET-BYTES" });
    victimKeyPath = `${victim.orgId}/drives/${victim.driveId}/secret.txt`;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const shareRows = () => db.select().from(schema.shares).all();

  test("control: the victim's file exists on disk and the victim can share it", async () => {
    const r = (await dispatchOp(victim, "share-create", { path: "/secret.txt" })) as ShareCreateResult;
    expect(r.path).toBe("/secret.txt");
  });

  test("control: naming the victim's key without dot segments stays inside the attacker's drive (not found)", async () => {
    await expect(
      dispatchOp(attacker, "share-create", { path: `/${victimKeyPath}` })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(shareRows()).toHaveLength(0);
  });

  // Every form below is a way to climb out of `<org>/drives/<drive>/` into a
  // sibling drive. The relative depth is exactly the number of segments in
  // the attacker's own key prefix (org, "drives", drive).
  const climb = (sep: string, dots = "..") => [dots, dots, dots].join(sep);
  const forms: Array<[string, () => string]> = [
    ["absolute climb", () => `/${climb("/")}/${victimKeyPath}`],
    ["relative climb (no leading slash)", () => `${climb("/")}/${victimKeyPath}`],
    ["trailing slash on the target", () => `/${climb("/")}/${victimKeyPath}/`],
    ["single-dot segments mixed in", () => `/./${climb("/./")}/./${victimKeyPath}`],
    ["climb via a real directory name", () => `/x/../${climb("/")}/${victimKeyPath}`],
    ["doubled separators", () => `//${climb("//")}//${victimKeyPath}`],
    ["backslash separators", () => `/${climb("\\")}\\${victimKeyPath.replaceAll("/", "\\")}`],
    ["mixed separators", () => `/..\\../..\\${victimKeyPath}`],
    ["backslash after a real segment", () => `/x\\..\\..\\..\\..\\${victimKeyPath}`],
    ["dot segment as the final component", () => `/${climb("/")}/${victimKeyPath}/..`],
  ];

  for (const [name, build] of forms) {
    test(`rejects ${name} and stores no share`, async () => {
      await expect(
        dispatchOp(attacker, "share-create", { path: build() })
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(shareRows()).toHaveLength(0);
    });
  }

  test("percent-encoded dots are a literal name on this backend and disclose nothing", async () => {
    // The adapter does not decode, so `%2e%2e` is just a file name that does not exist.
    await expect(
      dispatchOp(attacker, "share-create", { path: `/%2e%2e/%2e%2e/%2e%2e/${victimKeyPath}` })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(shareRows()).toHaveLength(0);
  });

  test("rejects a NUL byte", async () => {
    await expect(
      dispatchOp(attacker, "share-create", { path: "/secret.txt\u0000.png" })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(shareRows()).toHaveLength(0);
  });

  test("the validation runs before storage is touched", async () => {
    let touched = 0;
    const spy = new Proxy(attacker.s3, {
      get(target, prop, receiver) {
        if (prop === "headObject" || prop === "getObject") touched++;
        return Reflect.get(target, prop, receiver);
      },
    });
    await expect(
      dispatchOp({ ...attacker, s3: spy }, "share-create", { path: `/${climb("/")}/${victimKeyPath}` })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(touched).toBe(0);
  });

  test("ordinary names that merely contain dots still work", async () => {
    for (const path of ["/.hidden/notes..md", "/a..b/x...txt", "/..file", "/file.."]) {
      await dispatchOp(attacker, "write", { path, content: "ok" });
      const r = (await dispatchOp(attacker, "share-create", { path })) as ShareCreateResult;
      expect(r.path).toBe(path);
    }
  });

  test("the public read side re-checks a stored path and refuses to build a key for it", async () => {
    const r = (await dispatchOp(victim, "share-create", { path: "/secret.txt" })) as ShareCreateResult;
    const token = r.sharePath.replace("/share/", "");
    const share = findShareByToken(db, token)!;
    expect(shareStorageKey(share)).toBe(getS3Key(victim.orgId, victim.driveId, "/secret.txt"));

    // A row that got in some other way (older build, manual edit) is not served.
    const forged = { ...share, path: `/${climb("/")}/${victimKeyPath}` };
    expect(shareStorageKey(forged)).toBeNull();
    expect(shareStorageKey({ ...share, path: "/a\\..\\b" })).toBeNull();
  });
});

describe("assertPathInsideDrive", () => {
  test("accepts ordinary paths", () => {
    for (const p of ["/", "/a", "/a/b/c.txt", "/.hidden", "/a..b", "/..a", "/a../b", "/...", "/a b/ü.md"]) {
      expect(() => assertPathInsideDrive(p)).not.toThrow();
    }
  });

  test("rejects dot segments on either separator, and NUL", () => {
    for (const p of ["/..", "/.", "/a/..", "/a/./b", "/../a", "..", ".", "/a\\..\\b", "\\..\\a", "/a/..\\b", "/a\u0000b"]) {
      expect(() => assertPathInsideDrive(p)).toThrow(/segment|control|NUL/i);
    }
  });
});
