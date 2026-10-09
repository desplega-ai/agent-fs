import { Hono } from "hono";
import { findShareByToken, getShareState, isWellFormedShareToken, siteObjectKey } from "@/core";
import type { DB, StorageAdapter, ShareRecord } from "@/core";
import { detectMimeType, withUtf8Charset } from "@/core/ops/mime.js";
import { ipRateLimitMiddleware } from "../middleware/ip-rate-limit.js";

/** `getObject` buffers the whole body, so anything bigger is refused. */
export const SITE_MAX_OBJECT_BYTES = 25 * 1024 * 1024;

/**
 * The page runs in an opaque origin (no `allow-same-origin`): it cannot read
 * the live UI's storage or cookies, and every fetch it makes is cross-origin.
 * No `default-src` limit, so pages can load fonts and scripts from CDNs.
 */
export const SITE_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals; frame-ancestors *";

/**
 * Sent on every /site response. No `X-Frame-Options`: the live UI, on another
 * origin, frames these pages. `Access-Control-Allow-Origin: *` lets the
 * opaque-origin page fetch its own files; any token holder can read them anyway.
 */
export function siteSecurityHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "Content-Security-Policy": SITE_CSP,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    ...extra,
  };
}

function plain(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: siteSecurityHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
  });
}

function tooLarge(): Response {
  return plain(
    413,
    `This file is larger than ${SITE_MAX_OBJECT_BYTES / 1024 / 1024} MB and cannot be served from a site link`
  );
}

function redirect(location: string): Response {
  return new Response(null, { status: 301, headers: siteSecurityHeaders({ Location: location }) });
}

/**
 * No object at this key. The local backend refuses to read a directory with
 * EISDIR rather than a not-found error; a directory is not a file either.
 */
function isMissing(err: any): boolean {
  return (
    err?.name === "NotFound" ||
    err?.name === "NoSuchKey" ||
    err?.$metadata?.httpStatusCode === 404 ||
    err?.code === "EISDIR" ||
    err?.cause?.code === "EISDIR"
  );
}

const isLive = (share: ShareRecord | null): share is ShareRecord =>
  !!share && share.kind === "site" && getShareState(share, new Date()) === "active";

/**
 * Public site shares: `GET /site/:token/<path>` serves the files of a shared
 * folder, `index.html` for the folder itself. Registered before
 * `authMiddleware`: the token is the only credential, and the org, drive and
 * folder come from the stored share, never from the request.
 *
 * Every response is proxied (no presigned redirects), so documents stay on
 * this host and relative paths resolve here. Viewing a site counts no views and
 * records no events: one page load fetches many files.
 */
export function siteRoutes(db: DB, s3: StorageAdapter, opts: { requestsPerMinute: number }) {
  const router = new Hono();

  // First, so it also covers the limiter's 429 and the onError response.
  router.use("*", async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(siteSecurityHeaders())) {
      if (!c.res.headers.has(name)) c.res.headers.set(name, value);
    }
    c.res.headers.delete("X-Frame-Options");
  });

  if (opts.requestsPerMinute > 0) {
    router.use("*", ipRateLimitMiddleware(opts.requestsPerMinute));
  }

  router.onError((err) => {
    // Never echo internal errors (bucket names, endpoints) on a public route.
    console.error(`site route error: ${err instanceof Error ? err.message : String(err)}`);
    return plain(500, "Something went wrong");
  });

  // Preflight for fetches from the page (opaque origin, so every one is cross-origin).
  router.options("*", () =>
    new Response(null, {
      status: 204,
      headers: siteSecurityHeaders({
        "Access-Control-Allow-Methods": "GET, HEAD",
        "Access-Control-Allow-Headers": "*",
      }),
    })
  );

  // GET also answers HEAD (Hono runs the GET handler and drops the body).
  router.get("*", async (c) => {
    // The raw, still-encoded path: a route param may already be decoded, and a
    // second decode would turn `%252e%252e` into `..`. `siteObjectKey` decodes
    // `rest` exactly once and checks the result.
    const url = new URL(c.req.url);
    const match = /^\/site\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match || !isWellFormedShareToken(match[1])) return plain(404, "Not found");
    const [, token, tail] = match;

    // Relative paths in the page need the trailing slash.
    if (tail === undefined) return redirect(`${url.pathname}/${url.search}`);

    const share = findShareByToken(db, token);
    if (!share || share.kind !== "site") return plain(404, "Not found");
    if (!isLive(share)) return plain(410, "This link has expired");

    const rest = tail.slice(1);
    const wantsIndex = rest === "" || rest.endsWith("/");
    const key = siteObjectKey(share, wantsIndex ? `${rest}index.html` : rest);
    if (!key) return plain(400, "Bad path");

    let body: Uint8Array;
    try {
      // `getObject` buffers the whole body: refuse an oversized file from its
      // size alone, before reading a byte of it.
      if ((await s3.headObject(key)).size > SITE_MAX_OBJECT_BYTES) return tooLarge();
      body = (await s3.getObject(key)).body;
    } catch (err: any) {
      if (!isMissing(err)) throw err;
      if (!wantsIndex) {
        // A folder named without its slash: send the browser to `rest/`.
        // Built from the raw path, so the encoding of the request is kept.
        const indexKey = siteObjectKey(share, `${rest}/index.html`);
        if (indexKey && (await exists(s3, indexKey))) {
          if (!isLive(findShareByToken(db, token))) return plain(410, "This link has expired");
          return redirect(`${url.pathname}/${url.search}`);
        }
      }
      return plain(404, "Not found");
    }

    // The object may have grown between the size check and the read.
    if (body.length > SITE_MAX_OBJECT_BYTES) return tooLarge();

    // Reading storage took time: the link may have been revoked or run out
    // meanwhile. Check again against the clock as it is now.
    if (!isLive(findShareByToken(db, token))) return plain(410, "This link has expired");

    return new Response(body.slice(), {
      status: 200,
      headers: siteSecurityHeaders({
        "Content-Type": withUtf8Charset(detectMimeType(key)),
        "Content-Length": String(body.length),
      }),
    });
  });

  router.all("*", () =>
    new Response("Method not allowed", {
      status: 405,
      headers: siteSecurityHeaders({ "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD, OPTIONS" }),
    })
  );

  return router;
}

async function exists(s3: StorageAdapter, key: string): Promise<boolean> {
  try {
    await s3.headObject(key);
    return true;
  } catch (err: any) {
    if (isMissing(err)) return false;
    throw err;
  }
}
