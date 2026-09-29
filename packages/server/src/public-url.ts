import type { Context } from "hono";

const HOST_RE = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/;

/**
 * Public address of this API server, without a trailing slash, for building
 * absolute share links. `AGENT_FS_PUBLIC_URL` (config.server.publicUrl) wins;
 * otherwise it is derived from the request, honouring the first value of
 * X-Forwarded-Proto / X-Forwarded-Host that a reverse proxy such as Fly adds.
 * The result only ever goes back to the authenticated caller who supplied those
 * headers, so a spoofed value cannot poison anyone else's link.
 */
export function resolveApiUrl(c: Context, configured?: string): string | undefined {
  if (configured) return configured.replace(/\/+$/, "");

  const forwardedHost = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || c.req.header("host");
  if (!host || !HOST_RE.test(host)) return undefined;

  const forwardedProto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const proto =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : new URL(c.req.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}
