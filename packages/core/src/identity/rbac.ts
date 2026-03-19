import { eq, and } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import { PermissionDeniedError } from "../errors.js";

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
  log: "viewer",
  diff: "viewer",
  recent: "viewer",
  tree: "viewer",
  glob: "viewer",
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
  "comment-update": "editor",
  "comment-delete": "editor",
  "comment-resolve": "editor",
};

export function getRequiredRole(opName: string): Role {
  return OP_ROLES[opName] ?? "admin";
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

export function checkPermission(
  db: DB,
  params: { userId: string; driveId: string; requiredRole: Role }
): void {
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
}
