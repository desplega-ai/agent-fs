import type { Context, Next } from "hono";
import { getUserByApiKey } from "@/core";
import type { DB } from "@/core";

// Paths that don't require authentication
const PUBLIC_PATHS = ["/auth/register", "/health"];

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

    c.set("user", user);
    return next();
  };
}
