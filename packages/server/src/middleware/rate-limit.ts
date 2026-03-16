import type { MiddlewareHandler } from "hono";

/**
 * Simple in-memory sliding window rate limiter.
 * Keyed by API key (from Authorization header) or IP.
 */
export function rateLimitMiddleware(requestsPerMinute: number): MiddlewareHandler {
  const windows = new Map<string, number[]>();

  // Clean up stale entries every 5 minutes
  setInterval(() => {
    const cutoff = Date.now() - 60_000;
    for (const [key, timestamps] of windows) {
      const filtered = timestamps.filter((t) => t > cutoff);
      if (filtered.length === 0) {
        windows.delete(key);
      } else {
        windows.set(key, filtered);
      }
    }
  }, 300_000).unref();

  return async (c, next) => {
    // Extract key: prefer API key, fall back to IP
    const authHeader = c.req.header("authorization") ?? "";
    const key = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : c.req.header("x-forwarded-for") ?? "unknown";

    const now = Date.now();
    const cutoff = now - 60_000;
    const timestamps = (windows.get(key) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= requestsPerMinute) {
      const oldestInWindow = timestamps[0];
      const retryAfter = Math.ceil((oldestInWindow + 60_000 - now) / 1000);
      c.header("Retry-After", String(retryAfter));
      return c.json(
        { error: "RATE_LIMITED", message: "Too many requests" },
        429
      );
    }

    timestamps.push(now);
    windows.set(key, timestamps);
    await next();
  };
}
