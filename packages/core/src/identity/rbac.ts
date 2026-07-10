import { eq, and } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import { NotFoundError, PermissionDeniedError } from "../errors.js";

export type Role = "viewer" | "editor" | "admin";

const ROLE_LEVELS: Record<Role, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
};

// Op-to-minimum-role mapping
const OP_ROLES: Record<string, Role> = {
  ls: "viewer",
  cat: "viewer",
  tail: "viewer",
  stat: "viewer",
  grep: "viewer",
  fts: "viewer",
  search: "viewer",
  "vec-search": "viewer",
  log: "viewer",
  diff: "viewer",
  recent: "viewer",
  tree: "viewer",
  glob: "viewer",
  sql: "viewer",
  "signed-url": "viewer",
  write: "editor",
  edit: "editor",
  append: "editor",
  rm: "editor",
  mv: "editor",
  cp: "editor",
  revert: "editor",
  reindex: "admin",
  "comment-add": "editor",
  "comment-list": "viewer",
  "comment-get": "viewer",
  "comment-notification-list": "viewer",
  "comment-notification-read": "viewer",
  "comment-update": "editor",
  "comment-delete": "editor",
  "comment-resolve": "editor",
};

export function getRequiredRole(opName: string): Role {
  return OP_ROLES[opName] ?? "admin";
}

/** True when `role` is present and at least as privileged as `required`. */
export function roleAtLeast(
  role: Role | null | undefined,
  required: Role
): boolean {
  if (!role) return false;
  return ROLE_LEVELS[role] >= ROLE_LEVELS[required];
}

export function getUserOrgRole(
  db: DB,
  userId: string,
  orgId: string
): Role | null {
  const member = db
    .select()
    .from(schema.orgMembers)
    .where(
      and(
        eq(schema.orgMembers.orgId, orgId),
        eq(schema.orgMembers.userId, userId)
      )
    )
    .get();

  return (member?.role as Role) ?? null;
}

export function getUserDriveRole(
  db: DB,
  userId: string,
  driveId: string
): Role | null {
  const member = db
    .select()
    .from(schema.driveMembers)
    .where(
      and(
        eq(schema.driveMembers.driveId, driveId),
        eq(schema.driveMembers.userId, userId)
      )
    )
    .get();

  return (member?.role as Role) ?? null;
}

/**
 * Require an explicit drive membership with at least `requiredRole`.
 * Returns the user's actual drive role on success.
 */
export function requireDriveRole(
  db: DB,
  params: { userId: string; driveId: string; requiredRole: Role }
): Role {
  const userRole = getUserDriveRole(db, params.userId, params.driveId);

  if (!userRole) {
    throw new PermissionDeniedError("You do not have access to this drive", {
      requiredRole: params.requiredRole,
      yourRole: "none",
      suggestion: "Request access from the drive admin",
    });
  }

  if (ROLE_LEVELS[userRole] < ROLE_LEVELS[params.requiredRole]) {
    throw new PermissionDeniedError(
      `This operation requires '${params.requiredRole}' role, but you have '${userRole}'`,
      {
        requiredRole: params.requiredRole,
        yourRole: userRole,
        suggestion:
          params.requiredRole === "editor"
            ? "Ask a drive admin to upgrade your role to editor"
            : "Ask a drive admin to upgrade your role",
      }
    );
  }

  return userRole;
}

export function checkPermission(
  db: DB,
  params: { userId: string; driveId: string; requiredRole: Role }
): void {
  requireDriveRole(db, params);
}

/**
 * Require an explicit org membership with at least `requiredRole`.
 * Returns the user's actual org role on success.
 */
export function requireOrgRole(
  db: DB,
  params: { userId: string; orgId: string; requiredRole: Role }
): Role {
  const userRole = getUserOrgRole(db, params.userId, params.orgId);

  if (!userRole) {
    throw new PermissionDeniedError(
      "You do not have access to this organization",
      {
        requiredRole: params.requiredRole,
        yourRole: "none",
        suggestion: "Request access from an org admin",
      }
    );
  }

  if (ROLE_LEVELS[userRole] < ROLE_LEVELS[params.requiredRole]) {
    throw new PermissionDeniedError(
      `This operation requires '${params.requiredRole}' role in the org, but you have '${userRole}'`,
      {
        requiredRole: params.requiredRole,
        yourRole: userRole,
        suggestion: "Ask an org admin to upgrade your role",
      }
    );
  }

  return userRole;
}

/**
 * Require drive administration rights: an explicit drive 'admin' membership,
 * or 'admin' membership in the drive's owning org.
 * Returns the role that satisfied the check.
 */
export function requireDriveAdmin(
  db: DB,
  params: { userId: string; driveId: string }
): Role {
  const drive = db
    .select()
    .from(schema.drives)
    .where(eq(schema.drives.id, params.driveId))
    .get();

  if (!drive) {
    throw new NotFoundError(`Drive not found: ${params.driveId}`);
  }

  const driveRole = getUserDriveRole(db, params.userId, params.driveId);
  if (driveRole === "admin") return driveRole;

  const orgRole = getUserOrgRole(db, params.userId, drive.orgId);
  if (orgRole === "admin") return orgRole;

  throw new PermissionDeniedError(
    "This operation requires drive admin or org admin role",
    {
      requiredRole: "admin",
      yourRole: driveRole ?? orgRole ?? "none",
      suggestion: "Ask a drive or org admin to perform this operation",
    }
  );
}

/**
 * Assert that `driveId` exists and belongs to `orgId`.
 * Throws NotFoundError otherwise (same error for "missing" and "wrong org"
 * so cross-tenant callers cannot probe drive existence).
 * Returns the drive on success.
 */
export function assertDriveInOrg(
  db: DB,
  params: { driveId: string; orgId: string }
): { id: string; orgId: string; name: string; isDefault: boolean } {
  const drive = db
    .select()
    .from(schema.drives)
    .where(eq(schema.drives.id, params.driveId))
    .get();

  if (!drive || drive.orgId !== params.orgId) {
    throw new NotFoundError(`Drive not found in org: ${params.driveId}`, {
      suggestion: "Check the driveId belongs to the org you are addressing",
    });
  }

  return {
    id: drive.id,
    orgId: drive.orgId,
    name: drive.name,
    isDefault: drive.isDefault,
  };
}
