import { Hono } from "hono";
import type { Context } from "hono";
import {
  authorizeShareBytes,
  capUrlTtlSeconds,
  findShareByToken,
  getShareState,
  openShareView,
  recordShareViewed,
  shareStorageKey,
} from "@/core";
import type { DB, StorageAdapter, ShareByteAccess, ShareRecord } from "@/core";
import { decodeIndexableText, encodeRFC5987ValueChars } from "@/core/ops/mime.js";
import { ipRateLimitMiddleware } from "../middleware/ip-rate-limit.js";
import {
  buildCsp,
  classifyShareFile,
  grantQuery,
  isEmbeddable,
  isLinkPreviewBot,
  isMarkdownSafeToRender,
  renderExpiredPage,
  renderMarkdownSafe,
  renderPreviewBotPage,
  renderSharePage,
  renderUnavailablePage,
  shareContentType,
  shareSecurityHeaders,
} from "../share/render.js";
import type { ShareBody, ShareFileType } from "../share/render.js";

/** Largest text/markdown file rendered into the page; bigger ones are download-only. */
const MAX_PREVIEW_BYTES = 1024 * 1024;
/** Longest an embed (or a download redirect) presigned URL lives. */
const EMBED_URL_TTL_SECONDS = 3600;
const DOWNLOAD_URL_TTL_SECONDS = 300;

function isNotFound(err: any): boolean {
  return err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404;
}

function html(status: number, body: string, csp: string = buildCsp(null)): Response {
  return new Response(body, {
    status,
    headers: shareSecurityHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
    }),
  });
}

function plain(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: shareSecurityHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
  });
}

function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  return `${kind}; filename*=UTF-8''${encodeRFC5987ValueChars(filename)}`;
}

function filenameOf(share: ShareRecord): string {
  return share.path.split("/").pop() || "download";
}

/**
 * Public share links: `GET /share/:token` (HTML preview) plus the byte routes
 * `/raw` (inline embed) and `/download` (attachment). Registered before
 * `authMiddleware`: the token is the only credential. The org, drive and path
 * come from the stored share, never from the request.
 *
 * Invalid, expired, revoked and used-up links all render the same "expired"
 * page. The status differs (404 unknown, 410 known) but a token is 256 random
 * bits, so only someone who already holds a real token can tell them apart.
 */
export function shareRoutes(db: DB, s3: StorageAdapter, opts: { requestsPerMinute: number }) {
  const router = new Hono();

  // Registered first so it wraps everything below, including the 429 the rate
  // limiter answers with and the response `onError` builds. Whatever headers a
  // response lacks are filled in, so no share response can leave without the
  // baseline (CSP included), whichever code path produced it.
  router.use("*", async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(shareSecurityHeaders())) {
      if (!c.res.headers.has(name)) c.res.headers.set(name, value);
    }
  });

  if (opts.requestsPerMinute > 0) {
    router.use("*", ipRateLimitMiddleware(opts.requestsPerMinute));
  }

  router.onError((err) => {
    // Never echo internal errors (bucket names, endpoints) on a public route.
    console.error(`share route error: ${err instanceof Error ? err.message : String(err)}`);
    return plain(500, "Something went wrong");
  });

  const expired = (share: ShareRecord | null) => html(share ? 410 : 404, renderExpiredPage());

  // --- HTML page ---

  router.get("/:token", async (c) => {
    const token = c.req.param("token");
    const share = findShareByToken(db, token);

    if (!share || getShareState(share, new Date()) !== "active") return expired(share);

    // HEAD probes and link-preview crawlers must not spend a view.
    if (c.req.raw.method === "HEAD") return html(200, "");
    if (isLinkPreviewBot(c.req.header("user-agent"))) return html(200, renderPreviewBotPage());

    const key = shareStorageKey(share);
    if (!key) return html(404, renderUnavailablePage());
    const filename = filenameOf(share);
    const type = classifyShareFile(share.path);

    let head;
    try {
      head = await s3.headObject(key);
    } catch (err: any) {
      if (isNotFound(err)) return html(404, renderUnavailablePage());
      throw err;
    }

    // Spend the view, against the clock as it is after the storage round trip.
    // The guards are re-checked atomically inside the UPDATE, so this is what
    // decides a race for the last view, and what refuses a link that expired
    // while we waited on storage. A view-limited link also gets the grant this
    // page needs for its byte fetches.
    const opened = openShareView(db, token, new Date());
    if (!opened) return expired(share);
    const spent = opened.share;
    const grant = opened.grant?.token ?? null;
    recordShareViewed(db, spent);

    const viewsLeft = spent.maxViews === null ? null : Math.max(0, spent.maxViews - spent.views);

    let body: ShareBody;
    let embedSource: string | null = null;
    try {
      const built = await buildBody({ s3, key, share: spent, filename, type, size: head.size, token, grant });
      // No time left to issue an embed URL for: the link is over.
      if (!built) return expired(spent);
      body = built.body;
      embedSource = built.embedSource;
    } catch (err: any) {
      if (isNotFound(err)) return html(404, renderUnavailablePage());
      throw err;
    }

    // Last look before anything is released: building the page waited on
    // storage again, and the link may have been revoked or run out meanwhile.
    const releasedAt = new Date();
    const live = findShareByToken(db, token);
    if (!live || live.revokedAt || live.expiresAt.getTime() <= releasedAt.getTime()) return expired(live);

    return html(
      200,
      renderSharePage({
        token,
        filename,
        size: head.size,
        mime: type.mime,
        expiresAt: spent.expiresAt,
        now: releasedAt,
        viewsLeft,
        grant,
        body,
      }),
      buildCsp(embedSource)
    );
  });

  // --- Byte routes: /raw (inline embed) and /download (attachment) ---
  //
  // A view-limited link never serves bytes on its token alone: the request must
  // carry the grant that was issued with a counted page view (`?g=`). Time and
  // revocation are re-read at every step below, never carried over an await.

  const authorizeBytes = (c: Context) =>
    authorizeShareBytes(db, c.req.param("token")!, c.req.query("g"), new Date());

  // --- Inline bytes for the page's embed (backends without presigned URLs) ---

  router.get("/:token/raw", async (c) => {
    const access = authorizeBytes(c);
    if (!access.ok) return deniedBytes(access);
    const share = access.share;

    const type = classifyShareFile(share.path);
    // Only types the page embeds. Everything else, including HTML and SVG, is
    // reachable through /download only.
    if (!isEmbeddable(type)) return plain(404, "Not found");

    const key = shareStorageKey(share);
    if (!key) return plain(404, "This file is no longer available");
    const filename = filenameOf(share);

    if (s3.capabilities.presignedUrls) {
      const ttl = capUrlTtlSeconds(share, DOWNLOAD_URL_TTL_SECONDS);
      if (ttl === null) return plain(410, "This link has expired");
      const url = await s3.getPresignedUrl(key, ttl, type.mime, contentDisposition("inline", filename));
      return redirect(url);
    }
    return streamObject(s3, key, shareContentType(type), contentDisposition("inline", filename), {
      embed: { pdf: type.kind === "pdf" },
      stillAllowed: () => authorizeBytes(c).ok,
    });
  });

  // --- Download (attachment) ---

  router.get("/:token/download", async (c) => {
    const access = authorizeBytes(c);
    if (!access.ok) return deniedBytes(access);
    const share = access.share;

    const type = classifyShareFile(share.path);
    const key = shareStorageKey(share);
    if (!key) return plain(404, "This file is no longer available");
    const filename = filenameOf(share);
    const disposition = contentDisposition("attachment", filename);

    try {
      if (s3.capabilities.presignedUrls) {
        await s3.headObject(key);
        // Storage took its time: authorize again, and size the URL from now.
        const again = authorizeBytes(c);
        if (!again.ok) return deniedBytes(again);
        const ttl = capUrlTtlSeconds(again.share, DOWNLOAD_URL_TTL_SECONDS);
        if (ttl === null) return plain(410, "This link has expired");
        const url = await s3.getPresignedUrl(key, ttl, shareContentType(type), disposition);
        return redirect(url);
      }
      return await streamObject(s3, key, shareContentType(type), disposition, {
        stillAllowed: () => authorizeBytes(c).ok,
      });
    } catch (err: any) {
      if (isNotFound(err)) return plain(404, "This file is no longer available");
      throw err;
    }
  });

  router.all("*", () => plain(404, "Not found"));

  return router;
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: shareSecurityHeaders({ Location: location }),
  });
}

/**
 * Why the byte routes said no. 404 unknown, 410 over (revoked, expired, used
 * up), 403 a live view-limited link asked for bytes without a view's grant.
 */
function deniedBytes(access: Extract<ShareByteAccess, { ok: false }>): Response {
  if (access.reason === "not_found") return plain(404, "This link has expired");
  if (access.reason === "grant_required") return plain(403, "Open the share link to view or download this file");
  return plain(410, "This link has expired");
}

/**
 * Stream the object through the server (backends without presigned URLs).
 * `embed` is set for the inline /raw route: the share page frames PDFs itself,
 * so it needs `SAMEORIGIN` rather than the blanket `DENY`. Chrome refuses to
 * show a PDF whose own response carries a restrictive CSP, so a PDF gets only
 * `frame-ancestors`; every other type is locked down completely.
 *
 * `stillAllowed` is asked once the bytes are read, right before they are
 * released: reading storage takes time, and a link revoked or expired in the
 * meantime must not hand them over.
 */
async function streamObject(
  s3: StorageAdapter,
  key: string,
  contentType: string,
  disposition: string,
  opts: { embed?: { pdf: boolean }; stillAllowed: () => boolean }
): Promise<Response> {
  const { embed } = opts;
  try {
    const result = await s3.getObject(key);
    if (!opts.stillAllowed()) return plain(410, "This link has expired");
    const csp = !embed
      ? "default-src 'none'; sandbox"
      : embed.pdf
        ? "frame-ancestors 'self'"
        : "default-src 'none'; frame-ancestors 'self'; sandbox";
    return new Response(result.body.slice(), {
      status: 200,
      headers: shareSecurityHeaders({
        "Content-Type": contentType,
        "Content-Length": String(result.body.length),
        "Content-Disposition": disposition,
        "Content-Security-Policy": csp,
        "Cross-Origin-Resource-Policy": "same-origin",
        ...(embed && { "X-Frame-Options": "SAMEORIGIN" }),
      }),
    });
  } catch (err: any) {
    if (isNotFound(err)) return plain(404, "This file is no longer available");
    throw err;
  }
}

async function buildBody(args: {
  s3: StorageAdapter;
  key: string;
  share: ShareRecord;
  filename: string;
  type: ShareFileType;
  size: number;
  token: string;
  grant: string | null;
}): Promise<{ body: ShareBody; embedSource: string | null } | null> {
  const { s3, key, share, filename, type, size, token, grant } = args;

  if (type.downloadOnly) {
    return {
      body: { kind: "none", reason: "This file type is not previewed for safety. Use Download to get it." },
      embedSource: null,
    };
  }

  if (isEmbeddable(type)) {
    const tag = type.kind === "pdf" ? "iframe" : type.kind === "image" ? "img" : type.kind === "audio" ? "audio" : "video";
    if (s3.capabilities.presignedUrls) {
      // Sized from the clock now, and never longer than the link has left.
      const ttl = capUrlTtlSeconds(share, EMBED_URL_TTL_SECONDS);
      if (ttl === null) return null;
      const url = await s3.getPresignedUrl(key, ttl, type.mime, contentDisposition("inline", filename));
      return { body: { kind: "embed", tag, src: url }, embedSource: new URL(url).origin };
    }
    return { body: { kind: "embed", tag, src: `/share/${token}/raw${grantQuery(grant)}` }, embedSource: "'self'" };
  }

  if (type.kind === "markdown" || type.kind === "text" || type.kind === "sniff") {
    if (size > MAX_PREVIEW_BYTES) {
      return {
        body: { kind: "none", reason: "This file is too large to preview. Use Download to get it." },
        embedSource: null,
      };
    }
    const { body: bytes } = await s3.getObject(key);
    let text: string | null;
    if (type.kind === "sniff") {
      text = decodeIndexableText(bytes, "application/octet-stream");
    } else {
      // Lenient decode: a preview with a replacement character beats no preview.
      text = new TextDecoder("utf-8").decode(bytes);
    }
    if (text === null) {
      return {
        body: { kind: "none", reason: "This file type can't be previewed here. Use Download to get it." },
        embedSource: null,
      };
    }
    if (type.kind === "markdown" && isMarkdownSafeToRender(text)) {
      return { body: { kind: "markdown", html: renderMarkdownSafe(text) }, embedSource: null };
    }
    return { body: { kind: "text", text }, embedSource: null };
  }

  return {
    body: { kind: "none", reason: "This file type can't be previewed here. Use Download to get it." },
    embedSource: null,
  };
}
