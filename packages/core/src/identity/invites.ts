import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import { NotFoundError, PermissionDeniedError } from "../errors.js";
import type { DriveGrant, MemberRole } from "./orgs.js";
import { grantDriveRole, grantOrgRole } from "./grants.js";
import { ambiguousEmailError, resolveUserByEmail } from "./users.js";

/** How long an accept link stays valid. */
export const INVITE_TTL_SECONDS = 7 * 24 * 3600;

/** 32 random bytes → 256 bits of entropy, base64url → 43 chars (as share tokens). */
const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface PendingInviteResult {
  status: "pending";
  inviteId: string;
  email: string;
  /** Shown once. Only its SHA-256 is stored. */
  token: string;
  expiresAt: Date;
  drives: DriveGrant[];
}

export interface InviteRecord {
  id: string;
  orgId: string;
  email: string;
  orgRole: MemberRole;
  drives: DriveGrant[];
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
}

/** What the holder of an accept link may see before signing in. */
export interface InvitePreview {
  orgId: string;
  orgName: string;
  invitedBy: string;
  email: string;
  drives: Array<{ driveId: string; name: string; role: MemberRole }>;
  expiresAt: Date;
}

export interface AcceptInviteResult {
  orgId: string;
  role: MemberRole;
  drives: DriveGrant[];
  /** Drive ids from the invite that were deleted before it was accepted. */
  skippedDrives: string[];
}

export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Accept a bare token or an accept link, so people can paste whatever the admin
 * sent them. Two link shapes exist: `https://app/invite#<token>` (current; the
 * token sits in the fragment, which browsers never send over HTTP) and
 * `https://app/invite/<token>` (issued before the fragment form).
 */
export function parseInviteToken(input: string): string | null {
  const trimmed = input.trim();
  if (TOKEN_RE.test(trimmed)) return trimmed;
  const fragment = trimmed.match(/\/invite\/?(?:\?[^#\s]*)?#([A-Za-z0-9_-]{43})$/);
  if (fragment) return fragment[1];
  const path = trimmed.match(/\/invite\/([A-Za-z0-9_-]{43})(?:[/?#]|$)/);
  return path ? path[1] : null;
}

/**
 * Link the invitee opens to accept, on the live app. Absent without an app URL.
 * The token goes in the fragment so it never reaches the live host's access
 * logs or a Referer header, even when the live app and the API are separate hosts.
 */
export function inviteAcceptUrl(appUrl: string | undefined, token: string): string | undefined {
  return appUrl ? `${appUrl.replace(/\/+$/, "")}/invite#${token}` : undefined;
}

const INVALID_INVITE_MESSAGE = "Invite not found or no longer valid";

function invalidInvite(): NotFoundError {
  return new NotFoundError(INVALID_INVITE_MESSAGE, {
    suggestion: "Ask the person who invited you for a new link",
  });
}

type InviteRow = typeof schema.orgInvites.$inferSelect;
type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

function toRecord(row: InviteRow): InviteRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    email: row.email,
    orgRole: row.orgRole,
    drives: JSON.parse(row.drives) as DriveGrant[],
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/** Open = not accepted, not revoked. Expired invites are still open until replaced. */
const isOpen = and(isNull(schema.orgInvites.acceptedAt), isNull(schema.orgInvites.revokedAt));

/**
 * Revoke the open invite for this org and email, if any. Returns whether one
 * was revoked. Pass a transaction to make it part of a larger write.
 */
export function revokeOpenInviteForEmail(db: DB | Tx, orgId: string, email: string): boolean {
  const result = db
    .update(schema.orgInvites)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.orgInvites.orgId, orgId),
        eq(schema.orgInvites.email, normalizeInviteEmail(email)),
        isOpen
      )
    )
    .returning({ id: schema.orgInvites.id })
    .all();
  return result.length > 0;
}

/**
 * Create a pending invite with a fresh accept token, replacing any open invite
 * for the same org and email. `drives` must already be validated against the
 * org (inviteToOrg does that).
 */
export function createPendingInvite(
  db: DB,
  params: {
    orgId: string;
    email: string;
    role: MemberRole;
    drives: DriveGrant[];
    invitedBy: string;
  }
): PendingInviteResult {
  const id = crypto.randomUUID();
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const email = normalizeInviteEmail(params.email);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_SECONDS * 1000);

  db.transaction((tx) => {
    revokeOpenInviteForEmail(tx, params.orgId, email);
    tx.insert(schema.orgInvites)
      .values({
        id,
        orgId: params.orgId,
        email,
        orgRole: params.role,
        drives: JSON.stringify(params.drives),
        tokenHash: hashInviteToken(token),
        createdBy: params.invitedBy,
        createdAt: now,
        expiresAt,
      })
      .run();
  });

  return { status: "pending", inviteId: id, email, token, expiresAt, drives: params.drives };
}

/** The open, unexpired invite for a token, or null. */
export function getInviteByToken(db: DB, token: string): InviteRecord | null {
  if (!TOKEN_RE.test(token)) return null;
  const row = db
    .select()
    .from(schema.orgInvites)
    .where(and(eq(schema.orgInvites.tokenHash, hashInviteToken(token)), isOpen))
    .get();
  if (!row || row.expiresAt.getTime() <= Date.now()) return null;
  return toRecord(row);
}

/**
 * Public view of an invite for the accept page. Unknown, expired, revoked and
 * used tokens all throw the same NotFoundError, so a token's history is not
 * observable. Drives deleted since the invite are left out.
 */
export function getInvitePreview(db: DB, token: string): InvitePreview {
  const invite = getInviteByToken(db, token);
  if (!invite) throw invalidInvite();

  const org = db
    .select({ name: schema.orgs.name })
    .from(schema.orgs)
    .where(eq(schema.orgs.id, invite.orgId))
    .get();
  if (!org) throw invalidInvite();

  const inviter = db
    .select({ email: schema.users.email, displayName: schema.users.displayName })
    .from(schema.users)
    .where(eq(schema.users.id, invite.createdBy))
    .get();

  const names = new Map(
    db
      .select({ id: schema.drives.id, name: schema.drives.name })
      .from(schema.drives)
      .where(eq(schema.drives.orgId, invite.orgId))
      .all()
      .map((d) => [d.id, d.name] as const)
  );

  return {
    orgId: invite.orgId,
    orgName: org.name,
    invitedBy: inviter?.displayName || inviter?.email || "an org admin",
    email: invite.email,
    drives: invite.drives
      .filter((g) => names.has(g.driveId))
      .map((g) => ({ driveId: g.driveId, name: names.get(g.driveId)!, role: g.role })),
    expiresAt: invite.expiresAt,
  };
}

/**
 * Accept an invite as `userId`. The token proves the link was received; the
 * invite email must also resolve to that account (exact match, else a sole
 * case-insensitive match), so a forwarded link cannot land on someone else's
 * account. Several case-variant accounts with no exact match are ambiguous
 * and refused. Org role and drive grants apply in one transaction, and the
 * invite is consumed in the same transaction so a token works exactly once.
 */
export function acceptInvite(
  db: DB,
  params: { token: string; userId: string }
): AcceptInviteResult {
  const invite = getInviteByToken(db, params.token);
  if (!invite) throw invalidInvite();

  // Same rule as inviting an existing account: the invite email must resolve
  // to the caller, not merely equal their email ignoring case.
  const lookup = resolveUserByEmail(db, invite.email);
  if (lookup.kind === "ambiguous") throw ambiguousEmailError(invite.email, lookup.candidates.length);
  if (lookup.kind !== "found" || lookup.user.id !== params.userId) {
    throw new PermissionDeniedError(`This invite is for ${invite.email}`, {
      suggestion: `Sign in as ${invite.email} (register that email if it has no account yet), then accept again`,
    });
  }

  const existing = new Set(
    db
      .select({ id: schema.drives.id })
      .from(schema.drives)
      .where(eq(schema.drives.orgId, invite.orgId))
      .all()
      .map((d) => d.id)
  );
  const granted = invite.drives.filter((g) => existing.has(g.driveId));
  const skippedDrives = invite.drives.filter((g) => !existing.has(g.driveId)).map((g) => g.driveId);

  let role: MemberRole = invite.orgRole;
  const held: DriveGrant[] = [];
  db.transaction((tx) => {
    const consumed = tx
      .update(schema.orgInvites)
      .set({ acceptedAt: new Date(), acceptedBy: params.userId })
      .where(and(eq(schema.orgInvites.id, invite.id), isOpen))
      .returning({ id: schema.orgInvites.id })
      .all();
    // Lost a race with another accept or a revoke.
    if (consumed.length === 0) throw invalidInvite();

    // Raise-only, like inviteToOrg: an account that was added or promoted
    // between the invite and its acceptance keeps the higher role.
    role = grantOrgRole(tx, { orgId: invite.orgId, userId: params.userId, role: invite.orgRole });
    for (const grant of granted) {
      held.push({
        driveId: grant.driveId,
        role: grantDriveRole(tx, { driveId: grant.driveId, userId: params.userId, role: grant.role }).role,
      });
    }
  });

  return { orgId: invite.orgId, role, drives: held, skippedDrives };
}

/** Open invites of an org, newest first. Expired ones are included and flagged. */
export function listInvites(
  db: DB,
  orgId: string
): Array<Omit<InviteRecord, "orgId"> & { expired: boolean }> {
  const now = Date.now();
  return db
    .select()
    .from(schema.orgInvites)
    .where(and(eq(schema.orgInvites.orgId, orgId), isOpen))
    .orderBy(sql`${schema.orgInvites.createdAt} DESC`)
    .all()
    .map((row) => {
      const { orgId: _orgId, ...rest } = toRecord(row);
      return { ...rest, expired: row.expiresAt.getTime() <= now };
    });
}

/** Revoke an open invite. Unknown ids and other orgs' invites get the same 404. */
export function revokeInvite(db: DB, params: { orgId: string; inviteId: string }): void {
  const result = db
    .update(schema.orgInvites)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.orgInvites.id, params.inviteId),
        eq(schema.orgInvites.orgId, params.orgId),
        isOpen
      )
    )
    .returning({ id: schema.orgInvites.id })
    .all();
  if (result.length === 0) {
    throw new NotFoundError(`Pending invite not found: ${params.inviteId}`, {
      suggestion: "List pending invites with 'agent-fs member invites'",
    });
  }
}
