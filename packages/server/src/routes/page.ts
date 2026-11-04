import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  AgentFSError,
  NotFoundError,
  assertPageDataWrite,
  dispatchOp,
  findShareByToken,
  getShareState,
  isWellFormedShareToken,
  PAGE_MAX_READ_BYTES,
  recordShareGuestWrite,
  resolveContext,
  resolvePagePath,
  siteObjectKey,
} from "@/core";
import type { DB, StorageAdapter, EmbeddingProvider, ShareRecord, OpContext } from "@/core";
import type { CatResult, StatResult, WriteResult } from "@/core/ops/types.js";
import { ipRateLimitMiddleware } from "../middleware/ip-rate-limit.js";
import { handleError } from "../middleware/error.js";
import { resolveApiUrl } from "../public-url.js";
import { htmlPagesIn, isHtmlName, isMissing } from "./site.js";
import { PAGE_SHELL_CSP, renderPageShell } from "../share/html-page-shell.js";
import {
  GUEST_COOKIE,
  GUEST_COOKIE_MAX_AGE_SECONDS,
  issueGuestCookie,
  parseGuest,
  verifyGuestCookie,
} from "../share/guest-cookie.js";
import type { GuestClaims } from "../share/guest-cookie.js";

/**
 * Room for 256 KB of content after JSON escaping (a control character takes
 * six bytes as `\u00XX`); the content itself is still held to 256 KB of UTF-8.
 */
const MAX_BODY = 2 * 1024 * 1024;
const MAX_MESSAGE = 1000;
const READ_RETRIES = 3;
const WRITES_PER_MINUTE = 60;
const BYTES_PER_DAY = 20 * 1024 * 1024;
const GUESTS_PER_MINUTE = 10;
/** Writes waiting for, or running on, one file; the rest are refused at once. */
const MAX_PENDING_PER_FILE = 8;
/** The same for one share, whatever files its writes name. */
const MAX_PENDING_PER_SHARE = 16;

/** Sent on every /page response, errors included. No CORS headers, ever. */
export function pageSecurityHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "Content-Security-Policy": PAGE_SHELL_CSP,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
    "Cache-Control": "no-store",
    ...extra,
  };
}

const notFound = () =>
  new Response("Not found", { status: 404, headers: pageSecurityHeaders({ "Content-Type": "text/plain; charset=utf-8" }) });

const refuse = (c: Context, status: 403 | 404 | 429, error: string, message: string) => c.json({ error, message }, status);

/** An active, writable share of a folder other than the root, or null. */
function writableShare(db: DB, token: string): ShareRecord | null {
  const share = findShareByToken(db, token);
  if (!share || share.kind !== "site" || !share.writable || share.path === "/") return null;
  return getShareState(share) === "active" ? share : null;
}

/**
 * Runs `fn` after every earlier call with the same key has settled, or returns
 * null when `limit` calls for the key are already pending. The server's
 * `expectedVersion` check is not atomic, so guest writes to one file go one at
 * a time whichever link they come through. In memory: agent-fs runs as one
 * process per deployment.
 */
function serialized(limit: number) {
  const queues = new Map<string, { tail: Promise<void>; pending: number }>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> | null => {
    const q = queues.get(key) ?? { tail: Promise.resolve(), pending: 0 };
    if (q.pending >= limit) return null;
    q.pending++;
    queues.set(key, q);
    const run = q.tail.then(fn);
    // Every outcome frees the slot.
    q.tail = run.then(
      () => {},
      () => {}
    ).then(() => {
      if (--q.pending === 0 && queues.get(key) === q) queues.delete(key);
    });
    return run;
  };
}

/**
 * Per-share write budgets: a fresh cookie does not reset them. In memory, so
 * per process (agent-fs runs one per deployment) and reset by a restart.
 */
export function writeBudget() {
  const usage = new Map<string, { writes: number[]; day: string; bytes: number }>();
  const entry = (shareId: string, now: number) => {
    const day = new Date(now).toISOString().slice(0, 10);
    // Forget shares with no writes today and none in the last minute.
    for (const [id, u] of usage) {
      if (u.day !== day && u.writes.every((t) => t <= now - 60_000)) usage.delete(id);
    }
    let u = usage.get(shareId);
    if (!u || u.day !== day) {
      u = { writes: u?.writes ?? [], day, bytes: 0 };
      usage.set(shareId, u);
    }
    u.writes = u.writes.filter((t) => t > now - 60_000);
    return u;
  };
  return {
    /**
     * Takes one write and `bytes` from the share's budget, synchronously, so
     * concurrent writes cannot all pass. Returns why it is over budget, or the
     * refund for a write that then fails.
     */
    reserve(shareId: string, bytes: number, now = Date.now()): string | (() => void) {
      const u = entry(shareId, now);
      if (u.writes.length >= WRITES_PER_MINUTE) return `This link saves at most ${WRITES_PER_MINUTE} files a minute. Try again shortly.`;
      if (u.bytes + bytes > BYTES_PER_DAY) return "This link has saved its 20 MB for today. Try again tomorrow.";
      u.writes.push(now);
      u.bytes += bytes;
      return () => {
        const i = u.writes.indexOf(now);
        if (i >= 0) u.writes.splice(i, 1);
        u.bytes -= bytes;
      };
    },
    /** Shares with an entry; for tests of the eviction. */
    tracked(): number {
      return usage.size;
    },
  };
}

/** The JSON body, or null when it is not JSON. A body over the route's limit still throws, for `bodyLimit` to answer. */
function jsonBody(c: Context): Promise<unknown> {
  return c.req.json().catch((err) => {
    if (err instanceof SyntaxError) return null;
    throw err;
  });
}

function isNotFound(err: unknown): boolean {
  return err instanceof AgentFSError && err.code === "NOT_FOUND";
}

/**
 * Writable site shares: `/page/<token>/` frames the folder's page in a shell
 * that hosts the page protocol for public viewers. A guest gives a name and
 * email once (`/guest`), remembered in a cookie signed for this share; `/ops`
 * then reads the folder and writes data files under `<folder>/data/` as the
 * share's creator, whose role is checked on every call. Registered before
 * `authMiddleware`: the token and the cookie are the only credentials.
 */
export function pageRoutes(
  db: DB,
  s3: StorageAdapter,
  opts: { requestsPerMinute: number; publicUrl?: string; embeddingProvider?: EmbeddingProvider | null }
) {
  const router = new Hono();
  const oneAtATime = serialized(MAX_PENDING_PER_FILE);
  const pendingPerShare = new Map<string, number>();
  const budget = writeBudget();

  router.use("*", async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(pageSecurityHeaders())) {
      if (!c.res.headers.has(name)) c.res.headers.set(name, value);
    }
  });

  if (opts.requestsPerMinute > 0) router.use("*", ipRateLimitMiddleware(opts.requestsPerMinute));

  // The app's own body limit skips /page: this one is the only one, so its answer is the one sent.
  router.use("*", bodyLimit({
    maxSize: MAX_BODY,
    onError: (c) => c.json({ error: "NOT_ALLOWED", message: "Request is larger than 2 MB" }, 413),
  }));

  router.onError((err, c) => {
    if (err instanceof AgentFSError) return handleError(err, c);
    // Never echo internal errors on a public route.
    console.error(`page route error: ${err instanceof Error ? err.message : String(err)}`);
    return c.json({ error: "INTERNAL_ERROR", message: "Something went wrong" }, 500);
  });

  /** The API's own address as the browser sees it. */
  const apiUrl = (c: Context) => resolveApiUrl(c, opts.publicUrl);

  /**
   * Only the shell may call the guest routes: same origin (so a cross-site
   * form or fetch is refused even before SameSite), the page header, JSON.
   */
  const fromShell = async (c: Context, next: () => Promise<void>) => {
    const own = apiUrl(c);
    if (!own || c.req.header("origin") !== new URL(own).origin) {
      return refuse(c, 403, "PERMISSION_DENIED", "Requests must come from this page");
    }
    if (c.req.header("x-agent-fs-page") !== "1") return refuse(c, 403, "PERMISSION_DENIED", "Missing X-Agent-FS-Page header");
    if (c.req.method === "POST" && !/^application\/json\b/i.test(c.req.header("content-type") ?? "")) {
      return refuse(c, 403, "PERMISSION_DENIED", "Content-Type must be application/json");
    }
    await next();
  };

  const cookieOptions = (c: Context, token: string) => {
    const base = new URL(apiUrl(c)!);
    return {
      path: `${base.pathname.replace(/\/+$/, "")}/page/${token}`,
      secure: base.protocol === "https:",
      httpOnly: true,
      sameSite: "Strict" as const,
    };
  };

  const shareOf = (c: Context) => {
    const token = c.req.param("token") ?? "";
    return isWellFormedShareToken(token) ? writableShare(db, token) : null;
  };

  const guestOf = (c: Context, share: ShareRecord) => verifyGuestCookie(getCookie(c, GUEST_COOKIE), share);

  router.post("/:token/me", fromShell, (c) => {
    const share = shareOf(c);
    if (!share) return refuse(c, 404, "NOT_FOUND", "Not found");
    const guest = guestOf(c, share);
    return c.json(guest ? { name: guest.name, email: guest.email } : null);
  });

  router.post(
    "/:token/guest",
    fromShell,
    ipRateLimitMiddleware(GUESTS_PER_MINUTE),
    async (c) => {
      const share = shareOf(c);
      if (!share) return refuse(c, 404, "NOT_FOUND", "Not found");
      const guest = parseGuest(await jsonBody(c));
      if (typeof guest === "string") return c.json({ error: "VALIDATION_ERROR", message: guest }, 400);
      const issued = issueGuestCookie(share, guest);
      if (!issued) return c.json({ error: "VALIDATION_ERROR", message: "Name and email are too long" }, 400);
      setCookie(c, GUEST_COOKIE, issued.value, { ...cookieOptions(c, c.req.param("token")), maxAge: GUEST_COOKIE_MAX_AGE_SECONDS });
      return c.json(guest);
    }
  );

  router.delete("/:token/guest", fromShell, (c) => {
    if (!shareOf(c)) return refuse(c, 404, "NOT_FOUND", "Not found");
    deleteCookie(c, GUEST_COOKIE, cookieOptions(c, c.req.param("token")!));
    return c.body(null, 204);
  });

  router.post(
    "/:token/ops",
    fromShell,
    async (c) => {
      const token = c.req.param("token")!;
      const share = shareOf(c);
      if (!share) return refuse(c, 404, "NOT_FOUND", "Not found");

      const body = await jsonBody(c);
      if (!body || typeof body !== "object") return c.json({ error: "VALIDATION_ERROR", message: "Body must be a JSON object" }, 400);
      const { op, path: relative, content, expectedVersion, message } = body as Record<string, unknown>;
      if (op !== "read" && op !== "stat" && op !== "write") return c.json({ error: "VALIDATION_ERROR", message: "Unknown op" }, 400);
      if (typeof relative !== "string") return c.json({ error: "VALIDATION_ERROR", message: "path must be a string" }, 400);
      // The folder is the share's; the page only names a path inside it.
      const path = resolvePagePath(share.path, relative);

      const ctx = (): OpContext => {
        let resolved;
        try {
          resolved = resolveContext(db, { userId: share.createdBy, orgId: share.orgId, driveId: share.driveId });
        } catch {
          // The creator left the drive: the link no longer has anyone's rights.
          throw new AgentFSError("NOT_ALLOWED", "This link can no longer reach its folder");
        }
        return { db, s3, orgId: resolved.orgId, driveId: resolved.driveId, userId: share.createdBy, embeddingProvider: opts.embeddingProvider };
      };

      if (op === "stat") {
        const s = await statOrNull(ctx(), path);
        return c.json(s && { version: s.currentVersion ?? null, size: s.size, modifiedAt: s.modifiedAt });
      }
      if (op === "read") return c.json(await readFile(ctx(), path));

      // Reads are public through /site anyway; a write needs the guest.
      const guest = guestOf(c, share);
      if (!guest) return refuse(c, 403, "NOT_ALLOWED", "Give your name and email on this page first");
      if (typeof content !== "string") return c.json({ error: "VALIDATION_ERROR", message: "content must be a string" }, 400);
      if (typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
        return c.json({ error: "VALIDATION_ERROR", message: "expectedVersion is required: the version you read, or 0 to create" }, 400);
      }
      if (message !== undefined && (typeof message !== "string" || message.length > MAX_MESSAGE)) {
        return c.json({ error: "VALIDATION_ERROR", message: `message must be a string of at most ${MAX_MESSAGE} characters` }, 400);
      }
      assertPageDataWrite(share.path, path, content);
      const bytes = Buffer.byteLength(content, "utf8");

      // Admission first, so distinct file names cannot start unbounded work.
      const pending = pendingPerShare.get(share.id) ?? 0;
      if (pending >= MAX_PENDING_PER_SHARE) return refuse(c, 429, "NOT_ALLOWED", "Too many pending writes, try again");
      pendingPerShare.set(share.id, pending + 1);
      const release = () => {
        const left = (pendingPerShare.get(share.id) ?? 1) - 1;
        if (left > 0) pendingPerShare.set(share.id, left);
        else pendingPerShare.delete(share.id);
      };

      const queued = oneAtATime(`${share.driveId}:${path}`, async () => {
        // A revoke that landed while this write waited stops it here.
        const current = writableShare(db, token);
        if (!current || current.id !== guest.share || !verifyGuestCookie(getCookie(c, GUEST_COOKIE), current)) {
          return refuse(c, 404, "NOT_FOUND", "This link has expired");
        }
        const refund = budget.reserve(current.id, bytes);
        if (typeof refund === "string") return refuse(c, 429, "NOT_ALLOWED", refund);
        let written: WriteResult;
        try {
          written = (await dispatchOp(ctx(), "write", {
            path,
            content,
            expectedVersion,
            message: guestMessage(guest, message as string | undefined),
          })) as WriteResult;
        } catch (err) {
          refund(); // nothing was saved
          throw err;
        }
        recordShareGuestWrite(db, current, guest, path);
        return c.json({ version: written.version });
      });
      if (!queued) {
        release();
        return refuse(c, 429, "NOT_ALLOWED", "Too many pending writes, try again");
      }
      return queued.finally(release);
    }
  );

  // The shell: `/page/<token>/` and `/page/<token>/<name>.html`.
  router.get("*", async (c) => {
    // The raw path: the page name is decoded once here, never twice.
    const match = /^\/page\/([^/]+)\/([^/]*)$/.exec(new URL(c.req.url).pathname);
    if (!match || !isWellFormedShareToken(match[1])) return notFound();
    const [, token, rawName] = match;
    const share = writableShare(db, token);
    if (!share) return notFound();

    let name: string;
    if (rawName === "") {
      const index = siteObjectKey(share, "index.html");
      if (!index) return notFound();
      try {
        await s3.headObject(index);
        name = "index.html";
      } catch (err) {
        if (!isMissing(err)) throw err;
        const pages = await htmlPagesIn(s3, index.slice(0, -"index.html".length));
        if (pages.length !== 1) return notFound();
        name = pages[0];
      }
    } else {
      try {
        name = decodeURIComponent(rawName);
      } catch {
        return notFound();
      }
      const key = /[/\\\0]/.test(name) || !isHtmlName(name) ? null : siteObjectKey(share, rawName);
      if (!key) return notFound();
      try {
        await s3.headObject(key);
      } catch (err) {
        if (!isMissing(err)) throw err;
        return notFound();
      }
    }
    return new Response(renderPageShell(token, name), {
      status: 200,
      headers: pageSecurityHeaders({ "Content-Type": "text/html; charset=utf-8" }),
    });
  });

  router.all("*", () => notFound());

  return router;
}

/** The version message of a guest's write: who, by their own account, and why. */
function guestMessage(guest: GuestClaims, message: string | undefined): string {
  return `Guest ${guest.name} <${guest.email}>: ${message || "Saved from the page"}`;
}

async function statOrNull(ctx: OpContext, path: string): Promise<StatResult | null> {
  try {
    return (await dispatchOp(ctx, "stat", { path })) as StatResult;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * A complete read and the version of those bytes, as the live host does it:
 * `cat` and the `stat` after it must name the same object, or the file changed
 * in between and we retry.
 */
async function readFile(ctx: OpContext, path: string): Promise<{ content: string; version: number | null }> {
  const tooLarge = () => new AgentFSError("NOT_ALLOWED", "File is larger than 1 MB");
  for (let attempt = 0; attempt <= READ_RETRIES; attempt++) {
    const before = await statOrNull(ctx, path);
    if (!before) throw new NotFoundError("File not found");
    if (before.size > PAGE_MAX_READ_BYTES) throw tooLarge();
    // A line is at least one byte, so this limit covers any file under the cap.
    const got = (await dispatchOp(ctx, "cat", { path, limit: PAGE_MAX_READ_BYTES + 1 })) as CatResult;
    if (got.truncated) throw tooLarge();
    const after = await statOrNull(ctx, path);
    if (!after || !got.etag || after.etag !== got.etag) continue;
    if (after.size > PAGE_MAX_READ_BYTES || Buffer.byteLength(got.content, "utf8") > PAGE_MAX_READ_BYTES) throw tooLarge();
    return { content: got.content, version: after.currentVersion ?? null };
  }
  throw new AgentFSError("CONFLICT", "The file kept changing while it was read");
}
