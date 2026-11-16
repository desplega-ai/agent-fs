import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createTestDb, MockS3Client } from "../../../core/src/test-utils.js";
import { createDrive, createUser, listDrives, listDrivesForUser, listUserOrgs, setDriveMember } from "@/core";
import { schema } from "../../../core/src/db/index.js";
import { createApp } from "../app.js";

describe("drive file summary", () => {
  let db: ReturnType<typeof createTestDb>;
  let app: ReturnType<typeof createApp>;
  let owner: ReturnType<typeof createUser>;
  let orgId: string;
  let driveId: string;
  let storageCalls: string[];

  beforeEach(() => {
    db = createTestDb();
    owner = createUser(db, { email: "summary-owner@example.com" });
    orgId = listUserOrgs(db, owner.user.id)[0].id;
    driveId = listDrives(db, orgId)[0].id;
    storageCalls = [];
    const storage = new MockS3Client();
    storage.listObjects = async () => {
      storageCalls.push("listObjects");
      throw new Error("The drive summary must not list storage objects");
    };
    app = createApp(db, storage);
  });

  afterEach(() => db.$client.close());

  function addFile(path: string, targetDrive = driveId, isDeleted = false) {
    db.insert(schema.files).values({
      path, driveId: targetDrive, isDeleted, size: 1,
      author: owner.user.id, createdAt: new Date(), modifiedAt: new Date(),
    }).run();
  }

  async function list(key = owner.apiKey, targetOrg = orgId) {
    return app.request(`/orgs/${targetOrg}/drives`, {
      headers: { Authorization: `Bearer ${key}` },
    });
  }

  async function summary() {
    const response = await list();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(storageCalls).toEqual([]);
    return body.drives.find((drive: { id: string }) => drive.id === driveId);
  }

  test("counts nested live files, excludes tombstones and folder markers, and caps at five", async () => {
    expect((await summary()).fileCountLowerBound).toBe(0);
    addFile("/deleted.txt", driveId, true);
    addFile("/folder/");
    for (let i = 0; i < 4; i++) addFile(`/deep/${i}/nested/file.txt`);
    expect((await summary()).fileCountLowerBound).toBe(4);
    addFile("/fifth.txt");
    expect((await summary()).fileCountLowerBound).toBe(5);
    db.$client.query("UPDATE files SET is_deleted = 1 WHERE drive_id = ? AND path = ?").run(driveId, "/fifth.txt");
    expect((await summary()).fileCountLowerBound).toBe(4);
    db.transaction(() => {
      for (let i = 0; i < 1000; i++) addFile(`/more/${i}.txt`);
    });
    expect((await summary()).fileCountLowerBound).toBe(5);
  });

  test("the summary query uses the existing drive index", async () => {
    addFile("/nested/file.txt");
    const prepare = spyOn(db.$client, "prepare");
    let query: string | undefined;
    try {
      expect(listDrivesForUser(db, orgId, owner.user.id)).toEqual([{
        id: driveId, name: "default", isDefault: true,
      }]);
      expect(prepare.mock.calls.some(([sql]) => sql.includes('from "files"'))).toBe(false);
      await summary();
      query = prepare.mock.calls.map(([sql]) => sql).find((sql) => sql.includes('from "files"'));
    } finally {
      prepare.mockRestore();
    }
    expect(query).toBeDefined();
    const plan = db.$client.query(`EXPLAIN QUERY PLAN ${query}`).all(orgId, owner.user.id) as { detail: string }[];
    expect(plan.some(({ detail }) => detail.includes("SEARCH files USING INDEX idx_files_drive_path"))).toBe(true);
    expect(plan.some(({ detail }) => detail.includes("SCAN files"))).toBe(false);
  });

  test("keeps counts within each visible drive and requires org membership", async () => {
    const hidden = createDrive(db, { orgId, name: "hidden" });
    for (let i = 0; i < 5; i++) addFile(`/secret/${i}.txt`, hidden.id);
    addFile("/visible.txt");
    const response = await list();
    expect((await response.json()).drives).toEqual([{
      id: driveId, name: "default", isDefault: true, fileCountLowerBound: 1,
    }]);
    const manageable = await app.request(`/orgs/${orgId}/drives?scope=manageable`, {
      headers: { Authorization: `Bearer ${owner.apiKey}` },
    });
    const hiddenDrive = (await manageable.json()).drives.find((drive: { id: string }) => drive.id === hidden.id);
    expect(hiddenDrive).toBeDefined();
    expect(hiddenDrive.fileCountLowerBound).toBeUndefined();

    setDriveMember(db, { driveId: hidden.id, userId: owner.user.id, role: "viewer" });
    const visible = await (await list()).json();
    expect(visible.drives.find((drive: { id: string }) => drive.id === hidden.id).fileCountLowerBound).toBe(5);
    expect((await summary()).fileCountLowerBound).toBe(1);

    const outsider = createUser(db, { email: "summary-outsider@example.com" });
    expect((await list(outsider.apiKey)).status).toBe(404);
    expect((await app.request(`/orgs/${orgId}/drives`)).status).toBe(401);
  });
});
