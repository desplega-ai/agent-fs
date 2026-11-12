import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { and, eq } from "drizzle-orm";
import { createDatabase, schema } from "../../db/index.js";
import type { DB } from "../../db/index.js";
import { createUser } from "../users.js";
import { getPersonalOrgId, inviteToOrg } from "../orgs.js";
import type { DriveGrant, MemberRole } from "../orgs.js";
import { acceptInvite } from "../invites.js";
import { resolveContext } from "../context.js";
import { getUserOrgRole } from "../rbac.js";

const TEST_DB = joinPath(tmpdir(), `agent-fs-personal-org-context-${Date.now()}.db`);
let db: DB;
let seq = 0;

beforeAll(() => {
  db = createDatabase(TEST_DB);
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
});

/** The one personal org a freshly registered user is a member of. */
function onlyPersonalOrg(userId: string): string {
  const rows = db
    .select({ orgId: schema.orgMembers.orgId })
    .from(schema.orgMembers)
    .innerJoin(schema.orgs, eq(schema.orgMembers.orgId, schema.orgs.id))
    .where(and(eq(schema.orgMembers.userId, userId), eq(schema.orgs.isPersonal, true)))
    .all();
  expect(rows.length).toBe(1);
  return rows[0].orgId;
}

function pair() {
  const n = seq++;
  const a = createUser(db, { email: `a${n}@example.test` }).user;
  const aOrg = onlyPersonalOrg(a.id);
  const b = createUser(db, { email: `b${n}@example.test` }).user;
  const bOrg = onlyPersonalOrg(b.id);
  return { a, aOrg, b, bOrg };
}

/** `a` invites `b` into `orgId` and `b` accepts. */
function join(orgId: string, a: { id: string }, b: { id: string; email: string }, role: MemberRole, drives?: DriveGrant[]) {
  const invite = inviteToOrg(db, { orgId, email: b.email, role, drives, invitedBy: a.id });
  if (invite.status !== "pending") throw new Error(`expected a pending invite, got ${invite.status}`);
  acceptInvite(db, { token: invite.token, userId: b.id });
  expect(getUserOrgRole(db, b.id, orgId)).toBe(role);
}

describe("default context for a member of another user's personal org", () => {
  test("a user with one personal org resolves to it", () => {
    const { b, bOrg } = pair();
    expect(getPersonalOrgId(db, b.id)).toBe(bOrg);
    expect(resolveContext(db, { userId: b.id }).orgId).toBe(bOrg);
  });

  test("being added to another personal org keeps the user's own default org", () => {
    const switched: number[] = [];
    // Pairs with random org ids, so both id orderings are covered.
    for (let i = 0; i < 40; i++) {
      const { a, aOrg, b, bOrg } = pair();
      join(aOrg, a, b, "editor");
      if (resolveContext(db, { userId: b.id }).orgId !== bOrg) switched.push(i);
      expect(resolveContext(db, { userId: a.id }).orgId).toBe(aOrg);
    }
    expect(switched).toEqual([]);
  });

  test("an inviter whose personal org id sorts first does not change the default org", () => {
    let found: ReturnType<typeof pair> | null = null;
    for (let i = 0; i < 50 && !found; i++) {
      const p = pair();
      if (p.aOrg < p.bOrg) found = p;
    }
    expect(found).not.toBeNull();
    const { a, aOrg, b, bOrg } = found!;
    join(aOrg, a, b, "editor");
    expect(resolveContext(db, { userId: b.id }).orgId).toBe(bOrg);
  });

  test("a membership-only add (no drive role) keeps the default context working", () => {
    const failures: string[] = [];
    for (let i = 0; i < 20; i++) {
      const { a, aOrg, b, bOrg } = pair();
      join(aOrg, a, b, "viewer", []);
      try {
        if (resolveContext(db, { userId: b.id }).orgId !== bOrg) failures.push(`switched:${i}`);
      } catch (e) {
        failures.push(`threw:${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
