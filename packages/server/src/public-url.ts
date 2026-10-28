import type { Context } from "hono";

/**
 * `AGENT_FS_PUBLIC_URL` as the base share links are built on: an absolute
 * http(s) URL with a host, optionally with a path prefix, and no credentials,
 * query, fragment or empty path segment (a route appended to those would not
 * be a clean path, and the web app refuses such links). Returns it normalized
 * (origin + path, no trailing slash), `undefined` when unset or empty, and
 * throws on anything else, so the server never starts with a value it would
 * silently ignore. The error never repeats the value: it may hold a secret.
 */
export function normalizePublicUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const invalid = (why: string) =>
    new Error(`Invalid AGENT_FS_PUBLIC_URL (server.publicUrl): ${why}. Example: https://files.example.com or https://example.com/agent-fs`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("not an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw invalid("use http or https");
  if (!url.hostname) throw invalid("no host");
  if (url.username || url.password) throw invalid("no credentials allowed");
  if (/[?#]/.test(value)) throw invalid("no query or fragment allowed");
  const path = url.pathname.replace(/\/+$/, "");
  if (path.includes("//")) throw invalid("no empty path segments (//) allowed");
  return `${url.origin}${path}`;
}

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
