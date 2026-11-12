// IPC drive addressing when two visible drives share a name.
//
// The FUSE helper names every mount root entry by the `slug` that
// `list_drives` returns and sends that slug back as `drive` on every request.
// Drive names are not unique (every org's first drive is "default"), so each
// listed slug must name exactly one drive, and a bare name shared by several
// drives must not silently pick one of them.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestDb, MockS3Client } from "../../../../core/src/test-utils.js";
import { createDrive, createOrg, createUser, inviteToOrg, listUserOrgs } from "../../../../core/src/index.js";
import { dispatchIpc, type IpcContext } from "../handlers.js";

interface Listed {
  slug: string;
  id: string;
  org_id: string;
}

let db: ReturnType<typeof createTestDb>;
let ctx: IpcContext;
let personalOrgId: string;
let otherEngId: string;
let teamEngId: string;
let teamOnlyId: string;

beforeEach(() => {
  db = createTestDb();
  const user = createUser(db, { email: "member@example.com" });
  personalOrgId = listUserOrgs(db, user.user.id)[0].id;

  // Another account's org with a drive named "eng"; the user gets editor on it.
  const other = createUser(db, { email: "other@example.com" });
  const otherOrg = createOrg(db, { name: "other-team", userId: other.user.id });
  otherEngId = createDrive(db, { orgId: otherOrg.id, name: "eng", creatorUserId: other.user.id }).id;
  inviteToOrg(db, {
    orgId: otherOrg.id,
    email: "member@example.com",
    role: "viewer",
    drives: [{ driveId: otherEngId, role: "editor" }],
  });

  // The user's own team org, also with an "eng" drive, plus a uniquely named one.
  const team = createOrg(db, { name: "my-team", userId: user.user.id });
  teamEngId = createDrive(db, { orgId: team.id, name: "eng", creatorUserId: user.user.id }).id;
  teamOnlyId = createDrive(db, { orgId: team.id, name: "team-only", creatorUserId: user.user.id }).id;

  ctx = {
    db,
    s3: new MockS3Client() as any,
    embeddingProvider: null,
    resolveApiKey: () => user.apiKey,
  };
});

afterEach(() => {
  db.$client.close();
});

async function listDrives(): Promise<Listed[]> {
  const resp: any = await dispatchIpc(ctx, { op: "list_drives" });
  expect(resp.error).toBeUndefined();
  return resp.drives;
}

/** Drive ids that hold a version of `path`. */
function drivesWithPath(path: string): string[] {
  return (
    db.$client.prepare("SELECT DISTINCT drive_id FROM file_versions WHERE path = ?").all(path) as Array<{
      drive_id: string;
    }>
  ).map((r) => r.drive_id);
}

describe("IPC drive slugs with same-named drives", () => {
  test("control: a drive id and a unique drive name resolve to that drive", async () => {
    const byId: any = await dispatchIpc(ctx, { op: "create_file", drive: teamEngId, path: "/by-id.txt" });
    expect(byId.error).toBeUndefined();
    expect(drivesWithPath("/by-id.txt")).toEqual([teamEngId]);

    const byName: any = await dispatchIpc(ctx, { op: "create_file", drive: "team-only", path: "/by-name.txt" });
    expect(byName.error).toBeUndefined();
    expect(drivesWithPath("/by-name.txt")).toEqual([teamOnlyId]);
  });

  test("every listed slug is unique and addresses its own drive", async () => {
    const listed = await listDrives();
    expect(listed.map((d) => d.id).sort()).toContain(otherEngId);
    expect(new Set(listed.map((d) => d.slug)).size).toBe(listed.length);

    for (const d of listed) {
      const path = `/probe-${d.id}.txt`;
      const resp: any = await dispatchIpc(ctx, { op: "create_file", drive: d.slug, path });
      expect(resp.error).toBeUndefined();
      expect(drivesWithPath(path)).toEqual([d.id]);
    }
  });

  test("a bare name shared by several drives is rejected, not routed to one of them", async () => {
    const resp: any = await dispatchIpc(ctx, { op: "create_file", drive: "eng", path: "/ambiguous.txt" });
    expect(resp.error?.code).toBe("NOT_FOUND");
    expect(drivesWithPath("/ambiguous.txt")).toEqual([]);
  });

  test("default_drive_slug addresses the personal org's default drive", async () => {
    const resp: any = await dispatchIpc(ctx, { op: "default_drive_slug" });
    const slug = resp.default_drive_slug as string;
    const listed = await listDrives();
    const target = listed.find((d) => d.slug === slug);
    expect(target?.org_id).toBe(personalOrgId);

    const write: any = await dispatchIpc(ctx, { op: "create_file", drive: slug, path: "/current.txt" });
    expect(write.error).toBeUndefined();
    expect(drivesWithPath("/current.txt")).toEqual([target!.id]);
  });
});
