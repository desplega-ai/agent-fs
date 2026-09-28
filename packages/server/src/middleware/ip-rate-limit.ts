import type { Context, MiddlewareHandler } from "hono";

/**
 * Best-effort client address for anonymous traffic.
 *
 * `Fly-Client-IP` is set by Fly's edge and cannot be forged by the caller, but
 * only on Fly: anywhere else a client could send it itself, so it is trusted
 * only when `FLY_APP_NAME` says we are behind Fly. Otherwise use the socket.
 * Behind any other reverse proxy every request shares the proxy's address and
 * therefore one bucket: raise the limit there.
 */
export function clientIp(c: Context): string {
  if (process.env.FLY_APP_NAME) {
    const fly = c.req.header("fly-client-ip");
    if (fly) return fly;
  }
  const env = c.env as { requestIP?: (req: Request) => { address?: string } | null } | undefined;
  const socket = env?.requestIP?.(c.req.raw)?.address;
  return socket ?? "unknown";
}

/**
 * Sliding-window limiter keyed by client address only. Unlike
 * `rateLimitMiddleware` it ignores the Authorization header: on a public route
 * that header is attacker-controlled, so keying on it would give every request
 * its own fresh bucket.
 */
export function ipRateLimitMiddleware(requestsPerMinute: number): MiddlewareHandler {
  const windows = new Map<string, number[]>();

  setInterval(() => {
    const cutoff = Date.now() - 60_000;
    for (const [key, timestamps] of windows) {
      const live = timestamps.filter((t) => t > cutoff);
      if (live.length === 0) windows.delete(key);
      else windows.set(key, live);
    }
  }, 300_000).unref();

  return async (c, next) => {
    const key = clientIp(c);
    const now = Date.now();
    const cutoff = now - 60_000;
    const timestamps = (windows.get(key) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= requestsPerMinute) {
      const retryAfter = Math.ceil((timestamps[0] + 60_000 - now) / 1000);
      return new Response("Too many requests", {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    timestamps.push(now);
    windows.set(key, timestamps);
    await next();
  };
}
