import type { Context, Next } from "hono";
import { getUserByApiKey } from "@/core";
import type { DB } from "@/core";

// Paths that don't require authentication
const PUBLIC_PATHS = ["/auth/register", "/health"];

/**
 * An org-scoped key (minted by an org admin) only reaches `/orgs/<scopeOrgId>`
 * and the routes under it. Everything else (`/auth/*`, `/mcp`, `/invites`,
 * other orgs, the org list) is refused, so the key can neither act outside
 * the org nor mint, list, revoke or reset the user's other keys. The segment
 * is compared raw: Hono's `:orgId` param is matched from the same segment.
 */
export function scopedKeyAllows(path: string, scopeOrgId: string): boolean {
  const parts = path.split("/");
  return parts[0] === "" && parts[1] === "orgs" && parts[2] === scopeOrgId;
}

export function authMiddleware(db: DB) {
  return async (c: Context, next: Next) => {
    const path = new URL(c.req.url).pathname;

    if (PUBLIC_PATHS.some((p) => path === p || path.startsWith(p))) {
      return next();
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json(
        {
          error: "UNAUTHORIZED",
          message: "Missing or invalid Authorization header",
          suggestion: "Include 'Authorization: Bearer <api_key>' header",
        },
        401
      );
    }

    const apiKey = authHeader.slice(7);
    const user = getUserByApiKey(db, apiKey);

    if (!user) {
      return c.json(
        {
          error: "UNAUTHORIZED",
          message: "Invalid API key",
          suggestion: "Register with POST /auth/register",
        },
        401
      );
    }

    if (user.scopeOrgId && !scopedKeyAllows(path, user.scopeOrgId)) {
      return c.json(
        {
          error: "FORBIDDEN",
          message: "This API key is limited to one org",
          suggestion: `Use it only under /orgs/${user.scopeOrgId}/`,
        },
        403
      );
    }

    c.set("user", { id: user.id, email: user.email });
    return next();
  };
}
