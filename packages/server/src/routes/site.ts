import { Hono } from "hono";
import { findShareByToken, getShareState, isWellFormedShareToken, siteObjectKey } from "@/core";
import type { DB, StorageAdapter, ShareRecord } from "@/core";
import { detectMimeType, withUtf8Charset } from "@/core/ops/mime.js";
import { ipRateLimitMiddleware } from "../middleware/ip-rate-limit.js";
import { escapeHtml, HTML_SANDBOX } from "../share/render.js";
import { injectHtmlCommentOverlay, isHtmlCommentsRequested } from "../share/html-comment-overlay.js";

/** `getObject` buffers the whole body, so anything bigger is refused. */
export const SITE_MAX_OBJECT_BYTES = 25 * 1024 * 1024;

/**
 * The page runs in an opaque origin (no `allow-same-origin`): it cannot read
 * the live UI's storage or cookies, and every fetch it makes is cross-origin.
 * No `default-src` limit, so pages can load fonts and scripts from CDNs.
 */
export const SITE_CSP = `sandbox ${HTML_SANDBOX}; frame-ancestors *`;

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

function redirect(location: string, status: 301 | 302 = 301): Response {
  return new Response(null, { status, headers: siteSecurityHeaders({ Location: location }) });
}

const INDEX = "index.html";

const isHtmlName = (name: string) => /\.html?$/i.test(name);

/**
 * The HTML pages directly inside a folder, by storage key prefix (ends with
 * `/`). Only pages: other files and sub-folders are never enumerated, so a
 * link holder still has to know their names, as before listings existed.
 */
async function htmlPagesIn(s3: StorageAdapter, prefix: string): Promise<string[]> {
  const { objects } = await s3.listObjects(prefix, { delimiter: "/" });
  return objects
    .map((o) => o.key.slice(prefix.length))
    .filter((n) => n && !n.includes("/") && isHtmlName(n))
    .sort((a, b) => a.localeCompare(b));
}

/** A plain listing of a folder's HTML pages, when it has no index.html. Every name is escaped. */
function listingPage(rest: string, pages: string[]): Response {
  // `rest` already decoded once inside `siteObjectKey`, so this cannot throw.
  const title = escapeHtml(`/${decodeURIComponent(rest)}`);
  const items = pages
    .map((n) => `<li><a href="${escapeHtml(encodeURIComponent(n))}">${escapeHtml(n)}</a></li>`)
    .join("");
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px}ul{padding-left:20px}</style>
</head><body><h1>${title}</h1><ul>${items}</ul></body></html>`;
  return new Response(body, {
    status: 200,
    headers: siteSecurityHeaders({ "Content-Type": "text/html; charset=utf-8" }),
  });
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
 * folder, `index.html` for the folder itself. A folder without one redirects
 * to its only HTML page, or else lists its HTML pages. Registered before
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
    const key = siteObjectKey(share, wantsIndex ? `${rest}${INDEX}` : rest);
    if (!key) return plain(400, "Bad path");

    let body: Uint8Array;
    try {
      // `getObject` buffers the whole body: refuse an oversized file from its
      // size alone, before reading a byte of it.
      if ((await s3.headObject(key)).size > SITE_MAX_OBJECT_BYTES) return tooLarge();
      body = (await s3.getObject(key)).body;
    } catch (err: any) {
      if (!isMissing(err)) throw err;
      if (wantsIndex) {
        // No index.html: a lone HTML page opens directly (other files can sit
        // next to it), several get a listing of the pages. No page is a 404.
        const pages = await htmlPagesIn(s3, key.slice(0, -INDEX.length));
        if (pages.length > 0) {
          if (!isLive(findShareByToken(db, token))) return plain(410, "This link has expired");
          // Relative to this folder's URL, which ends with a slash. 302: the
          // folder's contents can change, so browsers must not cache it.
          if (pages.length === 1) return redirect(`${encodeURIComponent(pages[0])}${url.search}`, 302);
          return listingPage(rest, pages);
        }
      } else {
        // A folder named without its slash: send the browser to `rest/` when
        // that serves a page (its index.html or another HTML file). Built from
        // the raw path, so the encoding of the request is kept.
        const indexKey = siteObjectKey(share, `${rest}/${INDEX}`);
        if (indexKey) {
          const pages = await htmlPagesIn(s3, indexKey.slice(0, -INDEX.length));
          if (pages.length > 0) {
            if (!isLive(findShareByToken(db, token))) return plain(410, "This link has expired");
            return redirect(`${url.pathname}/${url.search}`);
          }
        }
      }
      return plain(404, "Not found");
    }

    // The object may have grown between the size check and the read.
    if (body.length > SITE_MAX_OBJECT_BYTES) return tooLarge();

    // Reading storage took time: the link may have been revoked or run out
    // meanwhile. Check again against the clock as it is now.
    if (!isLive(findShareByToken(db, token))) return plain(410, "This link has expired");

    // The live UI asks for its comment overlay on HTML pages; every other
    // response is the stored bytes as they are.
    const mime = detectMimeType(key);
    if (mime === "text/html" && isHtmlCommentsRequested(url)) body = injectHtmlCommentOverlay(body);

    return new Response(body.slice(), {
      status: 200,
      headers: siteSecurityHeaders({
        "Content-Type": withUtf8Charset(mime),
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
