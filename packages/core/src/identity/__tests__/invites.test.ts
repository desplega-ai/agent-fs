import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { createDatabase, schema } from "../../db/index.js";
import type { DB } from "../../db/index.js";
import { createUser } from "../users.js";
import { addDriveMember, createOrg, inviteToOrg } from "../orgs.js";
import { createDrive, setDriveMember } from "../drives.js";
import { getUserDriveRole, getUserOrgRole } from "../rbac.js";
import {
  acceptInvite,
  getInvitePreview,
  hashInviteToken,
  inviteAcceptUrl,
  listInvites,
  parseInviteToken,
  revokeInvite,
} from "../invites.js";
import type { PendingInviteResult } from "../invites.js";
import type { DriveGrant } from "../orgs.js";
import { NotFoundError, PermissionDeniedError, ValidationError } from "../../errors.js";

const TEST_DB = join(tmpdir(), `agent-fs-invites-test-${Date.now()}.db`);
let db: DB;

beforeAll(() => {
  db = createDatabase(TEST_DB);
}, 30_000);

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
});

function setup(tag: string) {
  const adminId = createUser(db, { email: `${tag}-admin@example.com` }).user.id;
  const org = createOrg(db, { name: `${tag}-org`, userId: adminId });
  const workId = createDrive(db, { orgId: org.id, name: "work", creatorUserId: adminId }).id;
  const ledgerId = createDrive(db, { orgId: org.id, name: "ledger", creatorUserId: adminId }).id;
  return { adminId, orgId: org.id, workId, ledgerId };
}

function invitePending(
  t: ReturnType<typeof setup>,
  email: string,
  drives: DriveGrant[] = [
    { driveId: t.workId, role: "editor" },
    { driveId: t.ledgerId, role: "viewer" },
  ]
): PendingInviteResult {
  const result = inviteToOrg(db, { orgId: t.orgId, email, role: "viewer", drives, invitedBy: t.adminId });
  expect(result.status).toBe("pending");
  return result as PendingInviteResult;
}

function inviteRow(id: string) {
  return db.select().from(schema.orgInvites).where(eq(schema.orgInvites.id, id)).get()!;
}

describe("pending invites", () => {
  test("an unknown email gets a pending invite; only the token hash is stored", () => {
    const t = setup("pend-store");
    const invite = invitePending(t, "  Pend-Store-New@Example.com ");

    expect(invite.email).toBe("pend-store-new@example.com");
    expect(invite.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = inviteRow(invite.inviteId);
    expect(row.tokenHash).toBe(hashInviteToken(invite.token));
    expect(JSON.stringify(row)).not.toContain(invite.token);
    expect(row.email).toBe("pend-store-new@example.com");
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);
  });

  test("without invitedBy an unknown email still throws NotFoundError", () => {
    const t = setup("pend-noinviter");
    expect(() =>
      inviteToOrg(db, { orgId: t.orgId, email: "pend-noinviter-new@example.com", role: "viewer" })
    ).toThrow(NotFoundError);
  });

  test("a foreign drive is rejected before any invite is written", () => {
    const t = setup("pend-foreign");
    const other = setup("pend-foreign-other");
    expect(() => invitePending(t, "pend-foreign-new@example.com", [{ driveId: other.workId, role: "viewer" }])).toThrow(
      NotFoundError
    );
    expect(listInvites(db, t.orgId)).toEqual([]);
  });

  test("drives omitted stores the default drive with the org role", () => {
    const t = setup("pend-default");
    const result = inviteToOrg(db, {
      orgId: t.orgId,
      email: "pend-default-new@example.com",
      role: "editor",
      invitedBy: t.adminId,
    });
    expect(result.drives).toHaveLength(1);
    expect(result.drives[0].role).toBe("editor");
  });

  test("a second invite to the same email revokes the first", () => {
    const t = setup("pend-replace");
    const first = invitePending(t, "pend-replace-new@example.com");
    const second = invitePending(t, "PEND-replace-new@example.com", [{ driveId: t.workId, role: "admin" }]);

    expect(inviteRow(first.inviteId).revokedAt).not.toBeNull();
    expect(listInvites(db, t.orgId).map((i) => i.id)).toEqual([second.inviteId]);
    expect(() => getInvitePreview(db, first.token)).toThrow(NotFoundError);
  });

  test("preview shows org, inviter, email, drive names and expiry", () => {
    const t = setup("pend-preview");
    const invite = invitePending(t, "pend-preview-new@example.com");
    const preview = getInvitePreview(db, invite.token);
    expect(preview).toMatchObject({
      orgId: t.orgId,
      orgName: "pend-preview-org",
      invitedBy: "pend-preview-admin@example.com",
      email: "pend-preview-new@example.com",
      drives: [
        { driveId: t.workId, name: "work", role: "editor" },
        { driveId: t.ledgerId, name: "ledger", role: "viewer" },
      ],
    });
  });

  test("accept applies the org role and exactly the granted drives", () => {
    const t = setup("pend-accept");
    const invite = invitePending(t, "pend-accept-new@example.com");
    const userId = createUser(db, { email: "Pend-Accept-New@example.com" }).user.id;

    const result = acceptInvite(db, { token: invite.token, userId });

    expect(result).toMatchObject({ orgId: t.orgId, role: "viewer", skippedDrives: [] });
    expect(getUserOrgRole(db, userId, t.orgId)).toBe("viewer");
    expect(getUserDriveRole(db, userId, t.workId)).toBe("editor");
    expect(getUserDriveRole(db, userId, t.ledgerId)).toBe("viewer");
    expect(inviteRow(invite.inviteId)).toMatchObject({ acceptedBy: userId });
    expect(listInvites(db, t.orgId)).toEqual([]);
  });

  test("a reused token fails", () => {
    const t = setup("pend-reuse");
    const invite = invitePending(t, "pend-reuse-new@example.com");
    const userId = createUser(db, { email: "pend-reuse-new@example.com" }).user.id;
    acceptInvite(db, { token: invite.token, userId });
    expect(() => acceptInvite(db, { token: invite.token, userId })).toThrow(NotFoundError);
  });

  test("a wrong email fails and leaves the invite usable", () => {
    const t = setup("pend-wrong");
    const invite = invitePending(t, "pend-wrong-new@example.com");
    const otherId = createUser(db, { email: "pend-wrong-other@example.com" }).user.id;

    expect(() => acceptInvite(db, { token: invite.token, userId: otherId })).toThrow(PermissionDeniedError);
    expect(getUserOrgRole(db, otherId, t.orgId)).toBeNull();
    expect(getUserDriveRole(db, otherId, t.workId)).toBeNull();
    expect(getInvitePreview(db, invite.token).email).toBe("pend-wrong-new@example.com");
  });

  test("a case variant cannot accept when the exact account exists", () => {
    const t = setup("pend-case-exact");
    const invite = invitePending(t, "pend-case-exact@example.com");
    const exactId = createUser(db, { email: "pend-case-exact@example.com" }).user.id;
    const variantId = createUser(db, { email: "PEND-case-exact@example.com" }).user.id;

    expect(() => acceptInvite(db, { token: invite.token, userId: variantId })).toThrow(PermissionDeniedError);
    expect(getUserOrgRole(db, variantId, t.orgId)).toBeNull();
    acceptInvite(db, { token: invite.token, userId: exactId });
    expect(getUserOrgRole(db, exactId, t.orgId)).toBe("viewer");
  });

  test("several case variants and no exact account is ambiguous and refused", () => {
    const t = setup("pend-case-amb");
    const invite = invitePending(t, "pend-case-amb@example.com");
    const upperId = createUser(db, { email: "PEND-case-amb@example.com" }).user.id;
    const mixedId = createUser(db, { email: "Pend-Case-Amb@example.com" }).user.id;

    for (const userId of [upperId, mixedId]) {
      expect(() => acceptInvite(db, { token: invite.token, userId })).toThrow(ValidationError);
      expect(getUserOrgRole(db, userId, t.orgId)).toBeNull();
    }
    expect(getInvitePreview(db, invite.token).email).toBe("pend-case-amb@example.com");
  });

  test("a sole case-variant account accepts", () => {
    const t = setup("pend-case-sole");
    const invite = invitePending(t, "pend-case-sole@example.com");
    const userId = createUser(db, { email: "PEND-Case-Sole@example.com" }).user.id;

    acceptInvite(db, { token: invite.token, userId });
    expect(getUserOrgRole(db, userId, t.orgId)).toBe("viewer");
  });

  test("an expired invite fails", () => {
    const t = setup("pend-expired");
    const invite = invitePending(t, "pend-expired-new@example.com");
    db.update(schema.orgInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.orgInvites.id, invite.inviteId))
      .run();
    const userId = createUser(db, { email: "pend-expired-new@example.com" }).user.id;

    expect(() => acceptInvite(db, { token: invite.token, userId })).toThrow(NotFoundError);
    expect(() => getInvitePreview(db, invite.token)).toThrow(NotFoundError);
    expect(listInvites(db, t.orgId)).toMatchObject([{ id: invite.inviteId, expired: true }]);
    expect(getUserOrgRole(db, userId, t.orgId)).toBeNull();
  });

  test("a revoked invite fails; revoking twice or from another org is a 404", () => {
    const t = setup("pend-revoke");
    const other = setup("pend-revoke-other");
    const invite = invitePending(t, "pend-revoke-new@example.com");

    expect(() => revokeInvite(db, { orgId: other.orgId, inviteId: invite.inviteId })).toThrow(NotFoundError);
    revokeInvite(db, { orgId: t.orgId, inviteId: invite.inviteId });
    expect(() => revokeInvite(db, { orgId: t.orgId, inviteId: invite.inviteId })).toThrow(NotFoundError);

    const userId = createUser(db, { email: "pend-revoke-new@example.com" }).user.id;
    expect(() => acceptInvite(db, { token: invite.token, userId })).toThrow(NotFoundError);
  });

  test("unknown, expired and revoked tokens fail with the same message", () => {
    const t = setup("pend-same");
    const revoked = invitePending(t, "pend-same-a@example.com");
    revokeInvite(db, { orgId: t.orgId, inviteId: revoked.inviteId });
    const messages = [revoked.token, "A".repeat(43), "not-a-token"].map((token) => {
      try {
        getInvitePreview(db, token);
        return "no error";
      } catch (err) {
        return (err as Error).message;
      }
    });
    expect(new Set(messages).size).toBe(1);
  });

  test("drives deleted after the invite are skipped and reported", () => {
    const t = setup("pend-deleted");
    const invite = invitePending(t, "pend-deleted-new@example.com");
    db.delete(schema.driveMembers).where(eq(schema.driveMembers.driveId, t.ledgerId)).run();
    db.delete(schema.drives).where(eq(schema.drives.id, t.ledgerId)).run();
    const userId = createUser(db, { email: "pend-deleted-new@example.com" }).user.id;

    const result = acceptInvite(db, { token: invite.token, userId });
    expect(result.drives).toEqual([{ driveId: t.workId, role: "editor" }]);
    expect(result.skippedDrives).toEqual([t.ledgerId]);
  });

  test("a direct add after registering revokes the pending invite", () => {
    const t = setup("pend-direct");
    const invite = invitePending(t, "pend-direct-new@example.com");
    createUser(db, { email: "pend-direct-new@example.com" });

    const result = inviteToOrg(db, {
      orgId: t.orgId,
      email: "pend-direct-new@example.com",
      role: "viewer",
      invitedBy: t.adminId,
    });
    expect(result.status).toBe("added");
    expect(inviteRow(invite.inviteId).revokedAt).not.toBeNull();
  });
});

describe("grants never lower an existing role", () => {
  // A client reads the member list, then writes. Whoever is promoted in between
  // must survive the write, so the tests promote first and write second.
  function promoted(tag: string) {
    const t = setup(tag);
    const email = `${tag}-peer@example.com`;
    const peerId = createUser(db, { email }).user.id;
    inviteToOrg(db, { orgId: t.orgId, email, role: "viewer", drives: [] });
    return { ...t, email, peerId };
  }

  function promote(t: ReturnType<typeof promoted>) {
    db.update(schema.orgMembers)
      .set({ role: "admin" })
      .where(eq(schema.orgMembers.userId, t.peerId))
      .run();
    setDriveMember(db, { driveId: t.workId, userId: t.peerId, role: "admin" });
  }

  test("inviteToOrg keeps an org and drive admin added after the member list was read", () => {
    const t = promoted("grant-invite");
    promote(t);
    const result = inviteToOrg(db, {
      orgId: t.orgId,
      email: t.email,
      role: "viewer",
      drives: [
        { driveId: t.workId, role: "viewer" },
        { driveId: t.ledgerId, role: "editor" },
      ],
      invitedBy: t.adminId,
    });
    expect(getUserOrgRole(db, t.peerId, t.orgId)).toBe("admin");
    expect(getUserDriveRole(db, t.peerId, t.workId)).toBe("admin");
    expect(getUserDriveRole(db, t.peerId, t.ledgerId)).toBe("editor");
    if (result.status !== "added") throw new Error("expected added");
    expect(result.orgRole).toBe("admin");
    expect(result.drives).toEqual([
      { driveId: t.workId, role: "admin" },
      { driveId: t.ledgerId, role: "editor" },
    ]);
  });

  test("inviteToOrg cannot demote the last org admin", () => {
    const t = setup("grant-last-admin");
    const email = "grant-last-admin-admin@example.com";
    inviteToOrg(db, { orgId: t.orgId, email, role: "viewer", drives: [{ driveId: t.workId, role: "viewer" }] });
    expect(getUserOrgRole(db, t.adminId, t.orgId)).toBe("admin");
    expect(getUserDriveRole(db, t.adminId, t.workId)).toBe("admin");
  });

  test("addDriveMember keeps a drive admin added after the member list was read", () => {
    const t = promoted("grant-add");
    promote(t);
    const result = addDriveMember(db, { orgId: t.orgId, driveId: t.workId, email: t.email, role: "viewer" });
    expect(result).toMatchObject({ role: "admin", created: false });
    expect(getUserDriveRole(db, t.peerId, t.workId)).toBe("admin");
  });

  test("a grant above the held role still raises it, and a new member gets exactly the asked role", () => {
    const t = promoted("grant-raise");
    expect(addDriveMember(db, { orgId: t.orgId, driveId: t.workId, userId: t.peerId, role: "viewer" })).toMatchObject({
      role: "viewer",
      created: true,
    });
    expect(addDriveMember(db, { orgId: t.orgId, driveId: t.workId, userId: t.peerId, role: "editor" })).toMatchObject({
      role: "editor",
      created: false,
    });
    expect(addDriveMember(db, { orgId: t.orgId, driveId: t.workId, userId: t.peerId, role: "admin" }).role).toBe("admin");
  });

  test("acceptInvite keeps a role granted between the invite and its acceptance", () => {
    const t = setup("grant-accept");
    const email = "grant-accept-new@example.com";
    const pending = invitePending(t, email, [{ driveId: t.workId, role: "viewer" }]);
    const peerId = createUser(db, { email }).user.id;
    // An admin adds the now-registered person directly and promotes them.
    db.insert(schema.orgMembers).values({ orgId: t.orgId, userId: peerId, role: "admin" }).run();
    setDriveMember(db, { driveId: t.workId, userId: peerId, role: "admin" });

    const accepted = acceptInvite(db, { token: pending.token, userId: peerId });
    expect(accepted.role).toBe("admin");
    expect(accepted.drives).toEqual([{ driveId: t.workId, role: "admin" }]);
    expect(getUserOrgRole(db, peerId, t.orgId)).toBe("admin");
    expect(getUserDriveRole(db, peerId, t.workId)).toBe("admin");
  });
});

describe("parseInviteToken", () => {
  const token = "abcDEF012_-".padEnd(43, "x");

  test("accepts a bare token or an accept link", () => {
    expect(parseInviteToken(token)).toBe(token);
    expect(parseInviteToken(` https://live.example.com/invite/${token} `)).toBe(token);
    expect(parseInviteToken(`https://live.example.com/invite/${token}?ref=mail`)).toBe(token);
  });

  test("accepts the fragment form, with or without the apiUrl query", () => {
    expect(parseInviteToken(`https://live.example.com/invite#${token}`)).toBe(token);
    expect(parseInviteToken(` https://live.example.com/invite/#${token} `)).toBe(token);
    expect(
      parseInviteToken(`https://live.example.com/invite?apiUrl=https%3A%2F%2Fapi.example.com#${token}`)
    ).toBe(token);
  });

  test("rejects anything else", () => {
    expect(parseInviteToken("short")).toBeNull();
    expect(parseInviteToken(`https://live.example.com/share/${token}`)).toBeNull();
    expect(parseInviteToken(`https://live.example.com/share#${token}`)).toBeNull();
    expect(parseInviteToken("https://live.example.com/invite#short")).toBeNull();
  });
});

describe("inviteAcceptUrl", () => {
  const token = "abcDEF012_-".padEnd(43, "x");

  test("puts the token in the fragment so it never travels in an HTTP request", () => {
    const url = inviteAcceptUrl("https://live.example.com/", token)!;
    expect(url).toBe(`https://live.example.com/invite#${token}`);
    const parsed = new URL(url);
    expect(parsed.pathname + parsed.search).toBe("/invite");
    expect(parseInviteToken(url)).toBe(token);
  });

  test("is absent without an app URL", () => {
    expect(inviteAcceptUrl(undefined, token)).toBeUndefined();
  });
});
