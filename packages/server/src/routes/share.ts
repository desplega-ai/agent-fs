import { Hono } from "hono";
import {
  findShareByToken,
  getShareState,
  canServeShareAssets,
  consumeShareView,
  recordShareViewed,
  getS3Key,
} from "@/core";
import type { DB, StorageAdapter, ShareRecord } from "@/core";
import { decodeIndexableText, encodeRFC5987ValueChars } from "@/core/ops/mime.js";
import { ipRateLimitMiddleware } from "../middleware/ip-rate-limit.js";
import {
  buildCsp,
  classifyShareFile,
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
    const now = new Date();
    const share = findShareByToken(db, token);

    if (!share || getShareState(share, now) !== "active") return expired(share);

    // HEAD probes and link-preview crawlers must not spend a view.
    if (c.req.raw.method === "HEAD") return html(200, "");
    if (isLinkPreviewBot(c.req.header("user-agent"))) return html(200, renderPreviewBotPage());

    const key = getS3Key(share.orgId, share.driveId, share.path);
    const filename = filenameOf(share);
    const type = classifyShareFile(share.path);

    let head;
    try {
      head = await s3.headObject(key);
    } catch (err: any) {
      if (isNotFound(err)) return html(404, renderUnavailablePage());
      throw err;
    }

    // Spend the view. The guards are re-checked atomically inside the UPDATE, so
    // this is what decides a race for the last view.
    const spent = consumeShareView(db, token, now);
    if (!spent) return expired(share);
    recordShareViewed(db, spent);

    const viewsLeft = spent.maxViews === null ? null : Math.max(0, spent.maxViews - spent.views);

    let body: ShareBody;
    let embedSource: string | null = null;
    try {
      const built = await buildBody({ s3, key, share: spent, filename, type, size: head.size, token, now });
      body = built.body;
      embedSource = built.embedSource;
    } catch (err: any) {
      if (isNotFound(err)) return html(404, renderUnavailablePage());
      throw err;
    }

    return html(
      200,
      renderSharePage({
        token,
        filename,
        size: head.size,
        mime: type.mime,
        expiresAt: spent.expiresAt,
        now,
        viewsLeft,
        body,
      }),
      buildCsp(embedSource)
    );
  });

  // --- Inline bytes for the page's embed (backends without presigned URLs) ---

  router.get("/:token/raw", async (c) => {
    const share = findShareByToken(db, c.req.param("token"));
    if (!share || !canServeShareAssets(share)) return plain(share ? 410 : 404, "This link has expired");

    const type = classifyShareFile(share.path);
    // Only types the page embeds. Everything else, including HTML and SVG, is
    // reachable through /download only.
    if (!isEmbeddable(type)) return plain(404, "Not found");

    const key = getS3Key(share.orgId, share.driveId, share.path);
    const filename = filenameOf(share);

    if (s3.capabilities.presignedUrls) {
      const url = await s3.getPresignedUrl(key, DOWNLOAD_URL_TTL_SECONDS, type.mime, contentDisposition("inline", filename));
      return redirect(url);
    }
    return streamObject(s3, key, shareContentType(type), contentDisposition("inline", filename), {
      pdf: type.kind === "pdf",
    });
  });

  // --- Download (attachment) ---

  router.get("/:token/download", async (c) => {
    const share = findShareByToken(db, c.req.param("token"));
    if (!share || !canServeShareAssets(share)) return plain(share ? 410 : 404, "This link has expired");

    const type = classifyShareFile(share.path);
    const key = getS3Key(share.orgId, share.driveId, share.path);
    const filename = filenameOf(share);
    const disposition = contentDisposition("attachment", filename);

    try {
      if (s3.capabilities.presignedUrls) {
        await s3.headObject(key);
        const url = await s3.getPresignedUrl(key, DOWNLOAD_URL_TTL_SECONDS, shareContentType(type), disposition);
        return redirect(url);
      }
      return await streamObject(s3, key, shareContentType(type), disposition);
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
 * Stream the object through the server (backends without presigned URLs).
 * `embed` is set for the inline /raw route: the share page frames PDFs itself,
 * so it needs `SAMEORIGIN` rather than the blanket `DENY`. Chrome refuses to
 * show a PDF whose own response carries a restrictive CSP, so a PDF gets only
 * `frame-ancestors`; every other type is locked down completely.
 */
async function streamObject(
  s3: StorageAdapter,
  key: string,
  contentType: string,
  disposition: string,
  embed?: { pdf: boolean }
): Promise<Response> {
  try {
    const result = await s3.getObject(key);
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
  now: Date;
}): Promise<{ body: ShareBody; embedSource: string | null }> {
  const { s3, key, share, filename, type, size, token, now } = args;

  if (type.downloadOnly) {
    return {
      body: { kind: "none", reason: "This file type is not previewed for safety. Use Download to get it." },
      embedSource: null,
    };
  }

  if (isEmbeddable(type)) {
    const tag = type.kind === "pdf" ? "iframe" : type.kind === "image" ? "img" : type.kind === "audio" ? "audio" : "video";
    if (s3.capabilities.presignedUrls) {
      const remaining = Math.floor((share.expiresAt.getTime() - now.getTime()) / 1000);
      const ttl = Math.max(60, Math.min(EMBED_URL_TTL_SECONDS, remaining));
      const url = await s3.getPresignedUrl(key, ttl, type.mime, contentDisposition("inline", filename));
      return { body: { kind: "embed", tag, src: url }, embedSource: new URL(url).origin };
    }
    return { body: { kind: "embed", tag, src: `/share/${token}/raw` }, embedSource: "'self'" };
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
