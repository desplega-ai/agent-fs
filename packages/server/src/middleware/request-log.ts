import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types.js";

/**
 * Request logger with start AND completion lines.
 *
 * The start line matters: when a request blocks the event loop indefinitely
 * (the wedge we're hunting in prod), its completion line never prints — the
 * last unmatched `-->` in the log names the offender. Skips /health to keep
 * the Fly health-check poller out of the logs.
 */
export function requestLogMiddleware(): MiddlewareHandler<AppEnv> {
  let seq = 0;

  return async (c, next) => {
    const path = c.req.path;
    if (path === "/health") return next();

    const id = ++seq;
    const start = performance.now();
    console.log(`--> #${id} ${c.req.method} ${path}`);
    try {
      await next();
    } finally {
      const ms = Math.round(performance.now() - start);
      const user = c.get("user")?.email ?? "-";
      const slow = ms >= 2000 ? " SLOW" : "";
      console.log(`<-- #${id} ${c.req.method} ${path} ${c.res.status} ${ms}ms user=${user}${slow}`);
    }
  };
}
