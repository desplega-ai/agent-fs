import { describe, test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../../../core/src/test-utils.js";
import { LocalStorageAdapter } from "../../../core/src/storage/local-adapter.js";
import { createApp } from "../app.js";
import { issueGuestCookie, verifyGuestCookie, GUEST_COOKIE_MAX_AGE_SECONDS } from "../share/guest-cookie.js";
import { PAGE_SHELL_CSP } from "../share/html-page-shell.js";
import { writeBudget } from "../routes/page.js";

process.env.AGENT_FS_SHARE_RATE_LIMIT = "0";
process.env.AGENT_FS_SITE_RATE_LIMIT = "0";

const ORIGIN = "http://localhost";

interface Harness {
  app: ReturnType<typeof createApp>;
  db: ReturnType<typeof createTestDb>;
  s3: LocalStorageAdapter;
  root: string;
  apiKey: string;
  orgId: string;
  driveId: string;
  userId: string;
}

async function setup(): Promise<Harness> {
  const db = createTestDb();
  const root = mkdtempSync(join(tmpdir(), "afs-page-test-"));
  const s3 = new LocalStorageAdapter({ root });
  const app = createApp(db, s3 as any);
  const reg = await app.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `page-${Math.random().toString(36).slice(2)}@example.com` }),
  });
  const { apiKey, orgId } = await reg.json();
  const me = await (await app.request("/auth/me", { headers: { Authorization: `Bearer ${apiKey}` } })).json();
  return { app, db, s3, root, apiKey, orgId, driveId: me.defaultDriveId, userId: me.userId };
}

function op(h: Harness, body: Record<string, unknown>) {
  return h.app.request(`/orgs/${h.orgId}/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${h.apiKey}` },
    body: JSON.stringify(body),
  });
}

async function write(h: Harness, path: string, content: string) {
  expect((await op(h, { op: "write", path, content })).status).toBe(200);
}

interface Created { id: string; sharePath: string; token: string; writable: boolean }

async function share(h: Harness, path: string, extra: Record<string, unknown> = { writable: true }): Promise<Created> {
  const res = await op(h, { op: "share-create", path, ...extra });
  expect(res.status).toBe(200);
  const body = await res.json();
  return { ...body, token: (body.sharePath as string).split("/")[2] };
}

const sqlite = (h: Harness) => (h.db as any).$client as import("bun:sqlite").Database;
const secretOf = (h: Harness, id: string) =>
  (sqlite(h).prepare("SELECT guest_secret FROM shares WHERE id = ?").get(id) as { guest_secret: string | null }).guest_secret;

/** A request as the shell makes it. */
function call(h: Harness, token: string, route: string, opts: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const method = opts.method ?? "POST";
  return h.app.request(`/page/${token}/${route}`, {
    method,
    headers: {
      Host: "localhost",
      Origin: ORIGIN,
      "X-Agent-FS-Page": "1",
      ...(method === "POST" && { "Content-Type": "application/json" }),
      ...(opts.cookie && { Cookie: `afs_guest=${opts.cookie}` }),
      ...opts.headers,
    },
    ...(method === "POST" && { body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body ?? {}) }),
  });
}

/** Holds the first storage write of a file ending in `suffix` (or, with `all`, every one) until released. */
function holdWrites(h: Harness, suffix: string, all = false) {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const startedP = new Promise<void>((r) => (started = r));
  const put = h.s3.putObject.bind(h.s3);
  let held = false;
  h.s3.putObject = (async (key: string, ...rest: unknown[]) => {
    if ((all || !held) && key.endsWith(suffix)) {
      held = true;
      started();
      await gate;
    }
    return (put as any)(key, ...rest);
  }) as typeof h.s3.putObject;
  return { release, started: startedP };
}

/** The guest cookie's value from a response, "" when it clears it. */
function cookieFrom(res: Response): string {
  const set = res.headers.get("set-cookie") ?? "";
  return /afs_guest=([^;]*)/.exec(set)![1];
}

async function signIn(h: Harness, token: string, guest = { name: "David Example", email: "david@example.com" }) {
  const res = await call(h, token, "guest", { body: guest });
  expect(res.status).toBe(200);
  return cookieFrom(res);
}

function expectPageHeaders(res: Response, what = `${res.status}`) {
  expect(res.headers.get("content-security-policy"), what).toBe(PAGE_SHELL_CSP);
  expect(res.headers.get("referrer-policy"), what).toBe("no-referrer");
  expect(res.headers.get("x-content-type-options"), what).toBe("nosniff");
  expect(res.headers.get("x-robots-tag"), what).toBe("noindex");
  expect(res.headers.get("cache-control"), what).toBe("no-store");
  expect(res.headers.get("access-control-allow-origin"), what).toBeNull();
}

let h: Harness;
let site: Created;

beforeEach(async () => {
  h = await setup();
  await write(h, "/site/index.html", "<!doctype html><p>tasks</p>");
  await write(h, "/site/<b>&.html", "<p>odd</p>");
  await write(h, "/site/sub/index.html", "<p>sub</p>");
  await write(h, "/site/app.js", "1");
  await write(h, "/other/data/x.json", "{}");
  site = await share(h, "/site");
});

afterEach(() => {
  setSystemTime();
  rmSync(h.root, { recursive: true, force: true });
});

describe("the shell", () => {
  test("frames the entry page of an active writable share, with its own CSP", async () => {
    expect(site.sharePath).toBe(`/page/${site.token}/`);
    expect(PAGE_SHELL_CSP).toMatch(
      /^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/]+=*'; style-src 'sha256-[A-Za-z0-9+/]+=*'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/
    );
    const res = await h.app.request(site.sharePath);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expectPageHeaders(res);
    const html = await res.text();
    expect(html).toContain(`src="../../site/${site.token}/index.html?__afs_page=1"`);
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"');
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<style>/g)).toHaveLength(1);
  });

  test("frames a named page, escaping its name", async () => {
    const res = await h.app.request(`/page/${site.token}/${encodeURIComponent("<b>&.html")}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>&lt;b&gt;&amp;.html</title>");
    expect(html).toContain(`src="../../site/${site.token}/%3Cb%3E%26.html?__afs_page=1"`);
    expect(html).not.toContain("<b>&");
  });

  test("without index.html opens the only page, and is 404 with several", async () => {
    await write(h, "/lone/radar.html", "<p>radar</p>");
    const lone = await share(h, "/lone");
    expect(await (await h.app.request(lone.sharePath)).text()).toContain(`/radar.html?__afs_page=1"`);
    await write(h, "/lone/other.htm", "<p>other</p>");
    expect((await h.app.request(lone.sharePath)).status).toBe(404);
  });

  test("is 404, with the same headers, for everything else", async () => {
    const file = await share(h, "/site/app.js", {});
    const readOnly = await share(h, "/site", {});
    const root = await share(h, "/", {});
    // Only the op refuses a writable root; a row that got in anyway is still refused.
    sqlite(h).prepare("UPDATE shares SET writable = 1, guest_secret = 'x' WHERE id = ?").run(root.id);
    const t = site.token;
    const paths = [
      `/page/${file.token}/`,
      `/page/${readOnly.token}/`,
      `/page/${root.token}/`,
      `/page/${t}`,
      `/page/${t}/sub/index.html`,
      `/page/${t}/sub%2Findex.html`,
      `/page/${t}/app.js`,
      `/page/${t}/missing.html`,
      `/page/${t}/..`,
      `/page/${"A".repeat(43)}/`,
      "/page/short/",
    ];
    for (const path of paths) {
      const res = await h.app.request(path);
      expect(res.status, path).toBe(404);
      expectPageHeaders(res, path);
    }
  });

  test("is 404 once revoked or expired", async () => {
    const expiring = await share(h, "/site", { writable: true, expiresIn: 60 });
    setSystemTime(new Date(Date.now() + 61_000));
    expect((await h.app.request(expiring.sharePath)).status).toBe(404);
    setSystemTime();
    expect((await op(h, { op: "share-revoke", token: site.sharePath })).status).toBe(200);
    expect((await h.app.request(site.sharePath)).status).toBe(404);
  });

  test("/health lists writable-shares", async () => {
    expect((await (await h.app.request("/health")).json()).features).toContain("writable-shares");
  });
});

describe("write budget bookkeeping", () => {
  test("a fresh budget is empty, and a share with no writes for a day is forgotten", () => {
    const budget = writeBudget();
    expect(budget.tracked()).toBe(0);
    const day1 = Date.UTC(2026, 10, 4, 12);
    expect(typeof budget.reserve("s1", 10, day1)).toBe("function");
    expect(typeof budget.reserve("s2", 10, day1)).toBe("function");
    expect(budget.tracked()).toBe(2);
    // The next day, the first reservation forgets the other share.
    expect(typeof budget.reserve("s1", 10, day1 + 86_400_000)).toBe("function");
    expect(budget.tracked()).toBe(1);
  });

  test("a refund returns the write and its bytes", () => {
    const budget = writeBudget();
    const now = Date.UTC(2026, 10, 4, 12);
    const refund = budget.reserve("s", 20 * 1024 * 1024, now);
    expect(budget.reserve("s", 1, now)).toContain("20 MB");
    (refund as () => void)();
    expect(typeof budget.reserve("s", 20 * 1024 * 1024, now)).toBe("function");
  });
});

describe("guest cookie", () => {
  const share1 = { id: "s1", guestSecret: "secret-1" };
  const guest = { name: "Ann", email: "ann@example.com" };

  test("verifies its own cookie", () => {
    const { value, claims } = issueGuestCookie(share1, guest, 1_000_000)!;
    expect(claims).toMatchObject({ v: 1, ...guest, share: "s1", iat: 1000, exp: 1000 + GUEST_COOKIE_MAX_AGE_SECONDS });
    expect(claims.gid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(verifyGuestCookie(value, share1, 2_000_000)).toEqual(claims);
  });

  test("refuses forged, expired, foreign, oversized and malformed cookies", () => {
    const { value } = issueGuestCookie(share1, guest, 1_000_000)!;
    const [payload, sig] = value.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), name: "Eve" })).toString("base64url");
    expect(verifyGuestCookie(`${forged}.${sig}`, share1, 2_000_000)).toBeNull();
    expect(verifyGuestCookie(value, share1, 1_000_000 + GUEST_COOKIE_MAX_AGE_SECONDS * 1000)).toBeNull();
    expect(verifyGuestCookie(value, { id: "s2", guestSecret: "secret-1" }, 2_000_000)).toBeNull();
    expect(verifyGuestCookie(value, { id: "s1", guestSecret: "secret-2" }, 2_000_000)).toBeNull();
    expect(verifyGuestCookie(value, { id: "s1", guestSecret: null }, 2_000_000)).toBeNull();
    expect(verifyGuestCookie(`${value}.x`, share1, 2_000_000)).toBeNull();
    expect(verifyGuestCookie(undefined, share1)).toBeNull();
    const sign = (payload: string) => `${payload}.${createHmac("sha256", "secret-1").update(payload).digest("base64url")}`;
    const claims = { v: 1, gid: "g", name: "n", email: "e", share: "s1", iat: 1, exp: 4_000_000_000, pad: "x".repeat(1600) };
    const big = sign(Buffer.from(JSON.stringify(claims)).toString("base64url"));
    expect(big.length).toBeGreaterThan(2048);
    expect(verifyGuestCookie(big, share1)).toBeNull();
  });

  test("issues no cookie longer than verification accepts", () => {
    // Longer than parseGuest allows: issuance refuses it rather than set a cookie /me would refuse.
    expect(issueGuestCookie(share1, { name: "n", email: `${"a".repeat(1600)}@example.com` })).toBeNull();
  });

  test("checks the payload's shape after the signature", () => {
    const sign = (claims: unknown) => {
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      return `${payload}.${createHmac("sha256", "secret-1").update(payload).digest("base64url")}`;
    };
    const good = { v: 1 as const, gid: "g", name: "n", email: "e@x.io", share: "s1", iat: 1, exp: 4_000_000_000 };
    expect(verifyGuestCookie(sign(good), share1)).toEqual(good);
    for (const bad of [{ ...good, v: 2 }, { ...good, gid: 1 }, { ...good, name: null }, { ...good, exp: "4000000000" }, [good], "x"]) {
      expect(verifyGuestCookie(sign(bad), share1)).toBeNull();
    }
  });
});

describe("/guest and /me", () => {
  test("validates the name and email", async () => {
    for (const body of [
      { name: "  ", email: "a@b.co" },
      { name: "x".repeat(81), email: "a@b.co" },
      { name: "a\nb", email: "a@b.co" },
      { name: "Ann", email: "not-an-email" },
      { name: "Ann", email: `${"a".repeat(250)}@b.co` },
      { name: "Ann" },
    ]) {
      const res = await call(h, site.token, "guest", { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toBe("VALIDATION_ERROR");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  test("sets an HttpOnly, SameSite=Strict cookie for this link, Secure on https", async () => {
    const res = await call(h, site.token, "guest", { body: { name: " Ann ", email: "ann@example.com" } });
    expect(await res.json()).toEqual({ name: "Ann", email: "ann@example.com" });
    const set = res.headers.get("set-cookie")!;
    expect(set).toContain(`Path=/page/${site.token}`);
    expect(set).toContain(`Max-Age=${180 * 24 * 3600}`);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    expect(set).not.toContain("Secure");
    expect(set).not.toContain("Domain");
    expectPageHeaders(res);

    const https = await call(h, site.token, "guest", {
      body: { name: "Ann", email: "ann@example.com" },
      headers: { Origin: "https://localhost", "X-Forwarded-Proto": "https" },
    });
    expect(https.headers.get("set-cookie")).toContain("Secure");
  });

  test("every name and email it accepts fits in a cookie that /me accepts", async () => {
    const longest = [
      { name: "N".repeat(80), email: `${"a".repeat(242)}@example.com` },
      // 80 four-byte characters and a 254-character email of them.
      { name: "😀".repeat(80), email: `${"😀".repeat(126)}@${"😀".repeat(124)}.io` },
    ];
    for (const guest of longest) {
      expect([...guest.email].length).toBe(254);
      const cookie = await signIn(h, site.token, guest);
      expect(cookie.length).toBeLessThanOrEqual(2048);
      expect(await (await call(h, site.token, "me", { cookie })).json()).toEqual(guest);
    }
  });

  test("issues at most 10 cookies a minute per address", async () => {
    for (let i = 0; i < 10; i++) await signIn(h, site.token);
    expect((await call(h, site.token, "guest", { body: { name: "Ann", email: "a@b.co" } })).status).toBe(429);
  });

  test("/me knows a valid cookie of this link only", async () => {
    const cookie = await signIn(h, site.token);
    const me = async (c?: string, token = site.token) => (await call(h, token, "me", { cookie: c })).json();
    expect(await me()).toBeNull();
    expect(await me(cookie)).toEqual({ name: "David Example", email: "david@example.com" });
    expect(await me(`${cookie.slice(0, -2)}AA`)).toBeNull();

    const other = await share(h, "/site");
    expect(await me(cookie, other.token)).toBeNull();

    const expired = issueGuestCookie({ id: site.id, guestSecret: secretOf(h, site.id) }, { name: "Old", email: "o@x.io" }, Date.now() - (GUEST_COOKIE_MAX_AGE_SECONDS + 1) * 1000)!;
    expect(await me(expired.value)).toBeNull();
  });

  test("DELETE clears the cookie", async () => {
    const res = await call(h, site.token, "guest", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`^afs_guest=; Max-Age=0; Path=/page/${site.token}; HttpOnly; SameSite=Strict`));
  });

  test("every guest route wants this origin, the page header and JSON, and sends no CORS headers", async () => {
    const cookie = await signIn(h, site.token);
    for (const [route, method] of [["me", "POST"], ["guest", "POST"], ["guest", "DELETE"], ["ops", "POST"]] as const) {
      const variants: Array<Record<string, string>> = [
        { Origin: "" },
        { Origin: "https://evil.example" },
        { Origin: "null" },
        { "X-Agent-FS-Page": "" },
        ...(method === "POST" ? [{ "Content-Type": "text/plain" }] : []),
      ];
      for (const headers of variants) {
        const res = await call(h, site.token, route, { method, cookie, headers, body: { name: "A", email: "a@b.co", op: "stat", path: "index.html" } });
        expect(res.status, `${method} ${route} ${JSON.stringify(headers)}`).toBe(403);
        expectPageHeaders(res);
        expect(res.headers.get("set-cookie")).toBeNull();
      }
    }
    const preflight = await h.app.request(`/page/${site.token}/ops`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("/ops", () => {
  let cookie: string;
  const ops = (body: Record<string, unknown>, c: string | undefined = cookie, token = site.token) => call(h, token, "ops", { body, cookie: c });
  const save = (path: string, content: string, expectedVersion = 0, message?: string) =>
    ops({ op: "write", path, content, expectedVersion, ...(message !== undefined && { message }) });

  beforeEach(async () => {
    cookie = await signIn(h, site.token);
  });

  test("reads without a guest cookie, but refuses a write", async () => {
    for (const c of ["", `${cookie.slice(0, -2)}AA`]) {
      expect(await (await ops({ op: "stat", path: "index.html" }, c)).json()).toMatchObject({ version: 1 });
      expect(await (await ops({ op: "read", path: "index.html" }, c)).json()).toMatchObject({ content: "<!doctype html><p>tasks</p>" });
      const res = await ops({ op: "write", path: "data/a.json", content: "{}", expectedVersion: 0 }, c);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("NOT_ALLOWED");
    }
  });

  test("a write runs as the creator, with the guest in the version message, log and events", async () => {
    const res = await save("data/state.json", '{"done":[1]}', 0, "Done: task 1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 1 });

    const log = await (await op(h, { op: "log", path: "/site/data/state.json" })).json();
    expect(log.versions[0]).toMatchObject({
      author: h.userId,
      message: "Guest David Example <david@example.com>: Done: task 1",
    });
    expect((await save("data/other.json", "{}")).status).toBe(200);
    const other = await (await op(h, { op: "log", path: "/site/data/other.json" })).json();
    expect(other.versions[0].message).toBe("Guest David Example <david@example.com>: Saved from the page");

    const event = sqlite(h).prepare("SELECT actor, resource_id, metadata FROM events WHERE type = 'share_guest_write' ORDER BY created_at").get() as any;
    expect(event.actor).toBe(h.userId);
    expect(event.resource_id).toBe(site.id);
    expect(JSON.parse(event.metadata)).toMatchObject({ email: "david@example.com", path: "/site/data/state.json", guestId: expect.any(String) });
  });

  test("read and stat resolve inside the folder", async () => {
    await save("data/state.json", "one");
    expect(await (await ops({ op: "read", path: "data/state.json" })).json()).toEqual({ content: "one", version: 1 });
    expect(await (await ops({ op: "read", path: "index.html" })).json()).toMatchObject({ content: "<!doctype html><p>tasks</p>" });
    expect(await (await ops({ op: "stat", path: "data/state.json" })).json()).toMatchObject({ version: 1, size: 3, modifiedAt: expect.any(String) });
    expect(await (await ops({ op: "stat", path: "data/none.json" })).json()).toBeNull();
    expect((await (await ops({ op: "read", path: "data/none.json" })).json()).error).toBe("NOT_FOUND");
    for (const path of ["../other/data/x.json", "/other/data/x.json", "%2e%2e/other/data/x.json", "a\\b"]) {
      const res = await ops({ op: "read", path });
      expect((await res.json()).error, path).toMatch(/NOT_ALLOWED|NOT_FOUND/);
    }
  });

  test("read pairs the bytes with their version when the file changes mid-read", async () => {
    await save("data/state.json", "one");
    const getObject = h.s3.getObject.bind(h.s3);
    let changed = false;
    h.s3.getObject = async (key: string, versionId?: string) => {
      const got = await getObject(key, versionId);
      if (!changed && key.endsWith("/data/state.json")) {
        changed = true;
        await write(h, "/site/data/state.json", "two");
      }
      return got;
    };
    expect(await (await ops({ op: "read", path: "data/state.json" })).json()).toEqual({ content: "two", version: 2 });
    expect(changed).toBe(true);
  });

  test("writes only data files under data/, within the limits", async () => {
    const refused = async (body: Record<string, unknown>, error: string, status = 400) => {
      const res = await ops(body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(status);
      expect((await res.json()).error).toBe(error);
    };
    await refused({ op: "write", path: "state.json", content: "{}", expectedVersion: 0 }, "NOT_ALLOWED");
    await refused({ op: "write", path: "index.html", content: "x", expectedVersion: 1 }, "NOT_ALLOWED");
    await refused({ op: "write", path: "data/evil.html", content: "x", expectedVersion: 0 }, "NOT_ALLOWED");
    await refused({ op: "write", path: "data/x.json", content: "x" }, "VALIDATION_ERROR");
    await refused({ op: "write", path: "data/x.json", content: "x", expectedVersion: -1 }, "VALIDATION_ERROR");
    await refused({ op: "write", path: "data/x.json", content: "x".repeat(256 * 1024 + 1), expectedVersion: 0 }, "NOT_ALLOWED");
    await refused({ op: "write", path: "data/x.json", content: "x".repeat(2 * 1024 * 1024 + 1), expectedVersion: 0 }, "NOT_ALLOWED", 413);
    await refused({ op: "rm", path: "data/x.json" }, "VALIDATION_ERROR");
    expect((await save("data/x.json", "x".repeat(256 * 1024))).status).toBe(200);
    // 256 KB of the characters JSON escapes most: the body is far larger, and still fits.
    const escaped = '"\\\u0001\n'.repeat(64 * 1024);
    expect(Buffer.byteLength(escaped)).toBe(256 * 1024);
    expect(JSON.stringify(escaped).length).toBeGreaterThan(640 * 1024);
    expect((await save("data/escaped.txt", escaped)).status).toBe(200);
    expect((await (await ops({ op: "read", path: "data/escaped.txt" })).json()).content).toBe(escaped);
  });

  test("an edit conflict passes through, and two concurrent writes of one version make one", async () => {
    expect((await save("data/state.json", "one")).status).toBe(200);
    const stale = await save("data/state.json", "two", 0);
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe("EDIT_CONFLICT");

    const [a, b] = await Promise.all([save("data/state.json", "a", 1), save("data/state.json", "b", 1)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await (await ops({ op: "read", path: "data/state.json" })).json()).toMatchObject({ version: 2 });
  });

  test("two links to one folder share one queue per file: one write wins, one conflicts", async () => {
    const second = await share(h, "/site");
    const secondCookie = await signIn(h, second.token);
    expect((await save("data/state.json", "one")).status).toBe(200);
    const [a, b] = await Promise.all([
      save("data/state.json", "a", 1),
      ops({ op: "write", path: "data/state.json", content: "b", expectedVersion: 1 }, secondCookie, second.token),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  test("holds at most 8 writes per file, refuses the rest at once, and frees the slots", async () => {
    const held = holdWrites(h, "/data/state.json");
    const pending = [save("data/state.json", "first", 0)];
    await held.started;
    for (let i = 1; i < 8; i++) pending.push(save("data/state.json", `w${i}`, 0));
    const refused = await save("data/state.json", "ninth", 0);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "NOT_ALLOWED", message: "Too many pending writes, try again" });
    // Another file has its own queue.
    expect((await save("data/other.json", "{}")).status).toBe(200);
    held.release();
    const statuses = (await Promise.all(pending)).map((r) => r.status);
    expect(statuses).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
    expect((await save("data/state.json", "after", 1)).status).toBe(200);
  });

  test("a revoke while a write waits in the queue refuses the waiting write", async () => {
    const held = holdWrites(h, "/data/state.json");
    const first = save("data/state.json", "first", 0);
    await held.started;
    const waiting = save("data/state.json", "second", 1);
    await Bun.sleep(10);
    expect((await op(h, { op: "share-revoke", id: site.id })).status).toBe(200);
    held.release();
    expect((await first).status).toBe(200);
    const refused = await waiting;
    expect(refused.status).toBe(404);
    expect((await refused.json()).error).toBe("NOT_FOUND");
  });

  test("stops after a revoke, and when the creator can no longer write", async () => {
    expect((await op(h, { op: "share-revoke", id: site.id })).status).toBe(200);
    expect((await save("data/state.json", "x")).status).toBe(404);

    const other = await share(h, "/site");
    const otherCookie = await signIn(h, other.token);
    sqlite(h).prepare("UPDATE drive_members SET role = 'viewer' WHERE user_id = ?").run(h.userId);
    const res = await ops({ op: "write", path: "data/state.json", content: "x", expectedVersion: 0 }, otherCookie, other.token);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("PERMISSION_DENIED");
  });

  const statuses = async (writes: Array<Response | Promise<Response>>) => (await Promise.all(writes)).map((r) => r.status).sort();

  test("keeps per-link budgets: 60 writes a minute, 20 MB a day, reserved before the write", async () => {
    const big = "x".repeat(256 * 1024);
    for (let i = 0; i < 58; i++) expect((await save(`data/${i}.txt`, big)).status).toBe(200);
    // Concurrent writes to different files run side by side: only two fit in the minute.
    expect(await statuses([58, 59, 60, 61].map((i) => save(`data/${i}.txt`, big)))).toEqual([200, 200, 429, 429]);
    const minute = await save("data/62.txt", "x");
    expect(minute.status).toBe(429);
    expect(await minute.json()).toMatchObject({ error: "NOT_ALLOWED", message: expect.stringContaining("a minute") });

    // A fresh cookie does not reset the budget.
    const fresh = await signIn(h, site.token, { name: "Eve", email: "eve@example.com" });
    expect((await ops({ op: "write", path: "data/63.txt", content: "x", expectedVersion: 0 }, fresh)).status).toBe(429);

    // 60 files of 256 KB are saved; 19 more leave room for exactly one in the 20 MB.
    setSystemTime(new Date(Date.now() + 61_000));
    for (let i = 100; i < 119; i++) expect((await save(`data/${i}.txt`, big)).status).toBe(200);
    expect(await statuses([119, 120, 121].map((i) => save(`data/${i}.txt`, big)))).toEqual([200, 429, 429]);
    const day = await save("data/122.txt", "x");
    expect(day.status).toBe(429);
    expect((await day.json()).message).toContain("20 MB");
  });

  test("a write that fails gives its budget back", async () => {
    expect((await save("data/state.json", "one")).status).toBe(200);
    for (let i = 1; i < 59; i++) expect((await save(`data/${i}.txt`, "x")).status).toBe(200);
    // 59 saved: a conflict does not use up the 60th.
    expect((await save("data/state.json", "stale", 0)).status).toBe(409);
    expect((await save("data/60.txt", "x")).status).toBe(200);
    expect((await save("data/61.txt", "x")).status).toBe(429);
  });

  test("holds at most 16 writes per link, whatever the files, and frees them", async () => {
    const held = holdWrites(h, "", true);
    const pending = Array.from({ length: 16 }, (_, i) => save(`data/${i}.txt`, "x"));
    await held.started;
    await Bun.sleep(20);
    const refused = await save("data/16.txt", "x");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "NOT_ALLOWED", message: "Too many pending writes, try again" });
    held.release();
    expect(await statuses(pending)).toEqual(Array(16).fill(200));
    expect((await save("data/16.txt", "x")).status).toBe(200);
  });

  test("the guest secret never appears in a response", async () => {
    const secret = secretOf(h, site.id)!;
    const responses = [
      await h.app.request(site.sharePath),
      await call(h, site.token, "guest", { body: { name: "Ann", email: "a@b.co" } }),
      await call(h, site.token, "me", { cookie }),
      await save("data/s.json", "{}"),
      await ops({ op: "read", path: "data/s.json" }),
      await op(h, { op: "share-create", path: "/site", writable: true }),
    ];
    for (const res of responses) {
      expect(await res.text()).not.toContain(secret);
      expect(JSON.stringify([...res.headers])).not.toContain(secret);
    }
  });
});
