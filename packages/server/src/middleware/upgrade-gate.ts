import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types.js";
import { upgradeInProgress } from "../upgrade-gate.js";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * While a long schema upgrade holds the write lock, refuse writes early with
 * an honest 503 + Retry-After instead of letting them spin on busy_timeout
 * and surface as SQLITE_BUSY. Reads go through (WAL readers never block).
 * /mcp is POST-based, so it is gated as a whole, reads included; the window
 * is one-off and the tradeoff is documented in DEPLOYMENT.md.
 */
export function upgradeGateMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const reason = upgradeInProgress();
    if (reason === null || READ_METHODS.has(c.req.method) || c.req.path === "/health") {
      return next();
    }
    c.header("Retry-After", "30");
    return c.json(
      {
        error: "UPGRADE_IN_PROGRESS",
        message: `Search index upgrade in progress: ${reason}. Writes resume when it finishes. Retry later.`,
      },
      503,
    );
  };
}
