import { describe, test, expect, beforeAll, afterAll, setSystemTime } from "bun:test";
import { createTestDb, MockS3Client } from "../../../core/src/test-utils.js";
import { createUser, setDriveMember } from "../../../core/src/index.js";
import { generateShareToken, hashShareToken } from "../../../core/src/ops/share.js";
import { AgentS3Client } from "../../../core/src/s3/client.js";
import { createApp } from "../app.js";

// One app per harness, and this file makes far more than the default 120
// requests a minute from a single "IP". The limiter has its own tests below,
// which set their own limit.
process.env.AGENT_FS_SHARE_RATE_LIMIT = "0";

interface Harness {
  app: ReturnType<typeof createApp>;
  db: ReturnType<typeof createTestDb>;
  s3: MockS3Client;
  apiKey: string;
  orgId: string;
  driveId: string;
  email: string;
}

async function setup(opts?: { presigned?: boolean }): Promise<Harness> {
  const db = createTestDb();
  const s3 = new MockS3Client({ capabilities: { presignedUrls: opts?.presigned ?? true } });
  const app = createApp(db, s3 as any);
  const email = `share-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const { apiKey, orgId } = await reg.json();
  const me = await (await app.request("/auth/me", { headers: { Authorization: `Bearer ${apiKey}` } })).json();
  return { app, db, s3, apiKey, orgId, driveId: me.defaultDriveId, email };
}

function op(h: Harness, body: Record<string, unknown>, key = h.apiKey) {
  return h.app.request(`/orgs/${h.orgId}/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

async function write(h: Harness, path: string, content: string) {
  const res = await op(h, { op: "write", path, content });
  expect(res.status).toBe(200);
}

async function share(h: Harness, path: string, extra: Record<string, unknown> = {}) {
  const res = await op(h, { op: "share-create", path, ...extra });
  expect(res.status).toBe(200);
  const body = await res.json();
  return { ...body, token: (body.sharePath as string).replace("/share/", "") } as {
    id: string; url: string; sharePath: string; token: string; expiresAt: string; maxViews: number | null;
  };
}

const sqlite = (h: Harness) => (h.db as any).$client as import("bun:sqlite").Database;
const shareRow = (h: Harness, id: string) =>
  sqlite(h).prepare("SELECT * FROM shares WHERE id = ?").get(id) as Record<string, any>;
const setShare = (h: Harness, id: string, column: "expires_at" | "last_viewed_at", date: Date) =>
  sqlite(h).prepare(`UPDATE shares SET ${column} = ? WHERE id = ?`).run(Math.floor(date.getTime() / 1000), id);

const get = (h: Harness, path: string, headers?: Record<string, string>) => h.app.request(path, { headers });

/** The grant a view-limited page hands to its Download link (`?g=`), or null. */
const grantOf = (page: string) => /\/download\?g=([A-Za-z0-9_-]{43})"/.exec(page)?.[1] ?? null;
const withGrant = (path: string, grant: string | null) => (grant ? `${path}?g=${grant}` : path);
const grantCount = (h: Harness, shareId: string) =>
  (sqlite(h).prepare("SELECT COUNT(*) AS n FROM share_view_grants WHERE share_id = ?").get(shareId) as { n: number }).n;
const urlTtl = (location: string) => Number(new URL(location).searchParams.get("e"));

/**
 * Make one storage call slow: `jumpTo` runs inside it, so the clock has moved
 * (or a revoke has landed) by the time the call returns. Returns the undo.
 */
function slowStorage(h: Harness, method: "headObject" | "getObject", jumpTo: () => void | Promise<void>) {
  const s3 = h.s3 as any;
  const original = s3[method].bind(s3);
  s3[method] = async (...args: unknown[]) => {
    const result = await original(...args);
    await jumpTo();
    return result;
  };
  return () => {
    s3[method] = original;
    setSystemTime();
  };
}
const jumpClockTo = (date: Date) => () => {
  setSystemTime(date);
};

let h: Harness;
beforeAll(async () => {
  h = await setup();
  await write(h, "/notes/readme.md", "# Title\n\nSome **bold** text and a [link](https://example.com).");
  await write(h, "/notes/plain.txt", "line one\n<b>not bold</b> & <script>alert(1)</script>\n");
  await write(h, "/notes/page.html", "<html><script>alert(1)</script></html>");
  await write(h, "/notes/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
  await write(h, "/notes/pic.png", "fake-png-bytes");
  await write(h, "/notes/doc.pdf", "fake-pdf-bytes");
  await write(h, "/notes/clip.mp4", "fake-mp4-bytes");
  await write(h, "/notes/data.bin", "\u0000\u0001\u0002binary");
  await write(h, "/notes/Makefile", "all:\n\techo hi\n");
});

describe("share-create over HTTP", () => {
  test("returns an absolute link on the API host derived from the request", async () => {
    const res = await h.app.request(`/orgs/${h.orgId}/ops`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${h.apiKey}`,
        Host: "agent-fs-acme.fly.dev",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({ op: "share-create", path: "/notes/readme.md" }),
    });
    const body = await res.json();
    expect(body.url).toBe(`https://agent-fs-acme.fly.dev${body.sharePath}`);
    expect(body.maxViews).toBeNull();
  });

  test("requires authentication", async () => {
    const res = await h.app.request(`/orgs/${h.orgId}/ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "share-create", path: "/notes/readme.md" }),
    });
    expect(res.status).toBe(401);
  });

  test("/health advertises the capability", async () => {
    const body = await (await get(h, "/health")).json();
    expect(body.features).toContain("share-links");
    // existing fields untouched
    expect(body.ok).toBe(true);
    expect(typeof body.maxUploadBytes).toBe("number");
  });
});

describe("GET /share/:token — page", () => {
  test("is public, renders markdown, and carries the hardening headers", async () => {
    const s = await share(h, "/notes/readme.md");
    const res = await get(h, s.sharePath); // no Authorization header
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("script-src");
    expect(csp).not.toContain("unsafe-eval");

    const body = await res.text();
    expect(body).toContain("<h1>readme.md</h1>");
    expect(body).toContain("<h1>Title</h1>");
    expect(body).toContain("<strong>bold</strong>");
    expect(body).toContain('href="https://example.com"');
    expect(body).toContain(`href="/share/${s.token}/download"`);
    expect(body).toContain("Expires");
    expect(body).not.toContain("<script");
  });

  test("leaks no credentials, org or member details", async () => {
    const s = await share(h, "/notes/readme.md");
    const body = await (await get(h, s.sharePath)).text();
    for (const secret of [h.apiKey, h.orgId, h.driveId, h.email, "admin", "Bearer"]) {
      expect(body).not.toContain(secret);
    }
    const org = sqlite(h).prepare("SELECT name FROM orgs WHERE id = ?").get(h.orgId) as { name: string };
    expect(body).not.toContain(org.name);
  });

  test("markdown cannot inject script, handlers, javascript: links or remote images", async () => {
    await write(
      h,
      "/notes/evil.md",
      [
        "# Hi <script>alert(1)</script>",
        "",
        '<img src=x onerror="alert(1)">',
        "",
        "[a](javascript:alert(1)) [b](JaVaScRiPt:alert(1)) [c](java\tscript:alert(1)) [d](data:text/html,<script>1</script>)",
        "[e](vbscript:msgbox) [f](/relative/path) [g](https://ok.example/x?a=1&b=2)",
        "",
        "![tracking](https://evil.example/pixel.png)",
        "",
        '<iframe src="https://evil.example"></iframe>',
        '<a href="javascript:alert(1)" onclick="alert(1)">raw anchor</a>',
        "",
        "```html",
        "<script>alert(2)</script>",
        "```",
      ].join("\n")
    );
    const s = await share(h, "/notes/evil.md");
    const body = await (await get(h, s.sharePath)).text();
    const article = body.slice(body.indexOf("<article>"), body.indexOf("</article>"));

    expect(article).not.toMatch(/<script/i);
    expect(article).not.toMatch(/<img/i);
    expect(article).not.toMatch(/<iframe/i);
    expect(article).not.toMatch(/href="(javascript|vbscript|data|\/)/i);
    // no real tag carries an event-handler attribute (the escaped source text may mention one)
    expect(article).not.toMatch(/<[a-z][^>]*\son\w+=/i);
    // raw HTML is shown as text, escaped
    expect(article).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(article).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    // remote images become alt text
    expect(article).toContain('<span class="img-alt">[image: tracking]</span>');
    // safe links survive, escaped, with the opener locked down
    expect(article).toContain('href="https://ok.example/x?a=1&amp;b=2" rel="noopener noreferrer nofollow"');
  });

  test("pathological markdown is shown as source instead of being parsed", async () => {
    await write(h, "/notes/deep.md", ">".repeat(50_000) + " x");
    const s = await share(h, "/notes/deep.md");
    const started = performance.now();
    const res = await get(h, s.sharePath);
    expect(performance.now() - started).toBeLessThan(2000);
    const body = await res.text();
    expect(body).toContain("<pre>&gt;&gt;&gt;");
    expect(body).not.toContain("<blockquote>");
  });

  test("text files are shown escaped in <pre>", async () => {
    const s = await share(h, "/notes/plain.txt");
    const body = await (await get(h, s.sharePath)).text();
    expect(body).toContain("<pre>line one\n&lt;b&gt;not bold&lt;/b&gt; &amp; &lt;script&gt;alert(1)&lt;/script&gt;\n</pre>");
    expect(body).not.toContain("<b>not bold</b>");
  });

  test("extensionless text is sniffed and shown; binary is not", async () => {
    const mk = await (await get(h, (await share(h, "/notes/Makefile")).sharePath)).text();
    expect(mk).toContain("<pre>all:");
    const bin = await (await get(h, (await share(h, "/notes/data.bin")).sharePath)).text();
    expect(bin).toContain("No preview available");
    expect(bin).toContain('href="/share/');
  });

  test("HTML and SVG are never previewed: no-preview card and download only", async () => {
    for (const path of ["/notes/page.html", "/notes/logo.svg"]) {
      const s = await share(h, path);
      const res = await get(h, s.sharePath);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("No preview available");
      expect(body).not.toContain("alert(1)");
      expect(body).not.toContain("<iframe");
      expect(body).not.toContain("<img");
      expect(res.headers.get("content-security-policy")).not.toContain("img-src");

      // the raw route refuses them
      expect((await get(h, `${s.sharePath}/raw`)).status).toBe(404);
    }
  });

  test("images, PDFs and video embed a short-lived presigned URL and open only that origin in the CSP", async () => {
    const cases: Array<[string, RegExp]> = [
      ["/notes/pic.png", /<img class="media" src="https:\/\/mock\.local\//],
      ["/notes/doc.pdf", /<iframe class="media" src="https:\/\/mock\.local\//],
      ["/notes/clip.mp4", /<video class="media" src="https:\/\/mock\.local\//],
    ];
    for (const [path, pattern] of cases) {
      const s = await share(h, path);
      const res = await get(h, s.sharePath);
      const body = await res.text();
      expect(body).toMatch(pattern);
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("img-src https://mock.local");
      expect(csp).toContain("media-src https://mock.local");
      expect(csp).toContain("frame-src https://mock.local");
      // inline disposition + explicit content type on the presigned URL
      const src = /src="([^"]+)"/.exec(body.slice(body.indexOf("<main>")))![1].replace(/&amp;/g, "&");
      const u = new URL(src);
      expect(Number(u.searchParams.get("e"))).toBeLessThanOrEqual(3600);
      expect(u.searchParams.get("cd")).toMatch(/^inline;/);
    }
  });

  test("download is a redirect to a short-lived attachment URL", async () => {
    const s = await share(h, "/notes/plain.txt");
    const res = await get(h, `${s.sharePath}/download`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("cd")).toMatch(/^attachment;/);
    expect(Number(loc.searchParams.get("e"))).toBeLessThanOrEqual(300);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("download of HTML forces an opaque content type", async () => {
    const s = await share(h, "/notes/page.html");
    const loc = new URL((await get(h, `${s.sharePath}/download`)).headers.get("location")!);
    expect(loc.searchParams.get("ct")).toBe("application/octet-stream");
  });

  test("a deleted file shows 'unavailable' and does not spend a view", async () => {
    await write(h, "/notes/gone.txt", "bye");
    const s = await share(h, "/notes/gone.txt", { maxViews: 1 });
    await op(h, { op: "rm", path: "/notes/gone.txt" });
    const res = await get(h, s.sharePath);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("no longer available");
    expect(shareRow(h, s.id).views).toBe(0);
  });
});

describe("expiry, one-off, revoke", () => {
  const EXPIRED_TEXT = "This link has expired";

  test("unknown and malformed tokens get the same expired page", async () => {
    const a = await get(h, `/share/${"A".repeat(43)}`);
    const b = await get(h, "/share/short");
    const c = await get(h, "/share/%27%20OR%201%3D1--");
    for (const res of [a, b, c]) {
      expect(res.status).toBe(404);
      expect(await res.text()).toContain(EXPIRED_TEXT);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  test("an expired link renders 'link expired' on every route", async () => {
    const s = await share(h, "/notes/readme.md");
    setShare(h, s.id, "expires_at", new Date(Date.now() - 5000));
    for (const path of [s.sharePath, `${s.sharePath}/download`, `${s.sharePath}/raw`]) {
      const res = await get(h, path);
      expect(res.status).toBe(410);
    }
    expect(await (await get(h, s.sharePath)).text()).toContain(EXPIRED_TEXT);
  });

  test("concurrent opens of a one-off link: exactly one wins", async () => {
    const s = await share(h, "/notes/readme.md", { maxViews: 1 });
    const results = await Promise.all(Array.from({ length: 8 }, () => get(h, s.sharePath)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 410)).toHaveLength(7);
  });

  test("maxViews=3 allows exactly three views", async () => {
    const s = await share(h, "/notes/readme.md", { maxViews: 3 });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await get(h, s.sharePath)).status);
    expect(statuses).toEqual([200, 200, 200, 410, 410]);
  });

  test("revoked links stop working immediately, including bytes", async () => {
    const s = await share(h, "/notes/plain.txt");
    expect((await get(h, s.sharePath)).status).toBe(200);
    expect((await get(h, `${s.sharePath}/download`)).status).toBe(302);

    const rev = await op(h, { op: "share-revoke", id: s.id });
    expect(rev.status).toBe(200);
    expect(await rev.json()).toEqual({ revoked: 1, ids: [s.id] });

    expect((await get(h, s.sharePath)).status).toBe(410);
    expect((await get(h, `${s.sharePath}/download`)).status).toBe(410);
  });

  test("revoking needs viewer+ and the right to revoke that link", async () => {
    const s = await share(h, "/notes/readme.md");
    const viewer = createUser(h.db, { email: "revoker@example.com" });
    setDriveMember(h.db, { driveId: h.driveId, userId: viewer.user.id, role: "viewer" });
    const denied = await op(h, { op: "share-revoke", id: s.id }, viewer.apiKey);
    expect(denied.status).toBe(403);
    expect((await get(h, s.sharePath)).status).toBe(200);
  });
});

describe("byte routes are bound to the counted page view", () => {
  test("a view-limited link serves nothing before its page was opened", async () => {
    const s = await share(h, "/notes/pic.png", { maxViews: 1 });
    expect((await get(h, `${s.sharePath}/download`)).status).toBe(403);
    expect((await get(h, `${s.sharePath}/raw`)).status).toBe(403);
  });

  test("maxViews=1: the spent token cannot fetch bytes, only the view's own grant can", async () => {
    const s = await share(h, "/notes/pic.png", { maxViews: 1 });

    const first = await get(h, s.sharePath);
    expect(first.status).toBe(200);
    const page = await first.text();
    const grant = grantOf(page)!;
    expect(grant).toBeTruthy();
    expect(grantCount(h, s.id)).toBe(1);
    expect((await get(h, s.sharePath)).status).toBe(410); // the page itself is used up

    // Someone who only holds the (now used-up) link: no /raw, no /download, however often they ask.
    for (let i = 0; i < 4; i++) {
      expect((await get(h, `${s.sharePath}/raw`)).status).toBe(410);
      expect((await get(h, `${s.sharePath}/download`)).status).toBe(410);
    }
    expect(shareRow(h, s.id).views).toBe(1);

    // The page that spent the view can still load its file.
    expect((await get(h, withGrant(`${s.sharePath}/download`, grant))).status).toBe(302);
    expect((await get(h, withGrant(`${s.sharePath}/raw`, grant))).status).toBe(302);
  });

  test("a grant opens only its own share, and a made-up one opens nothing", async () => {
    const a = await share(h, "/notes/plain.txt", { maxViews: 1 });
    const b = await share(h, "/notes/plain.txt", { maxViews: 1 });
    const grantA = grantOf(await (await get(h, a.sharePath)).text())!;
    await get(h, b.sharePath);

    expect((await get(h, withGrant(`${b.sharePath}/download`, grantA))).status).toBe(410);
    expect((await get(h, withGrant(`${a.sharePath}/download`, grantA))).status).toBe(302);

    for (const bad of [generateShareToken(), "short", "' OR 1=1 --", a.token, grantA.slice(0, 42), "%00"]) {
      expect((await get(h, withGrant(`${a.sharePath}/download`, bad))).status).toBe(410);
    }
  });

  test("a grant stops at its own expiry and when the link is revoked", async () => {
    const s = await share(h, "/notes/plain.txt", { maxViews: 3 });
    const grant = grantOf(await (await get(h, s.sharePath)).text())!;
    expect((await get(h, withGrant(`${s.sharePath}/download`, grant))).status).toBe(302);

    sqlite(h).prepare("UPDATE share_view_grants SET expires_at = ? WHERE share_id = ?")
      .run(Math.floor(Date.now() / 1000) - 5, s.id);
    // Still has views left, but the bytes need a live grant.
    expect((await get(h, withGrant(`${s.sharePath}/download`, grant))).status).toBe(403);

    const fresh = grantOf(await (await get(h, s.sharePath)).text())!;
    expect((await get(h, withGrant(`${s.sharePath}/download`, fresh))).status).toBe(302);
    await op(h, { op: "share-revoke", id: s.id });
    expect((await get(h, withGrant(`${s.sharePath}/download`, fresh))).status).toBe(410);
    expect((await get(h, withGrant(`${s.sharePath}/raw`, fresh))).status).toBe(410);
  });

  test("every counted view gets its own grant, at most maxViews of them", async () => {
    const s = await share(h, "/notes/plain.txt", { maxViews: 2 });
    const pages = await Promise.all([get(h, s.sharePath), get(h, s.sharePath), get(h, s.sharePath)]);
    const grants = (await Promise.all(pages.filter((r) => r.status === 200).map((r) => r.text()))).map(grantOf);
    expect(grants).toHaveLength(2);
    expect(new Set(grants).size).toBe(2);
    expect(grantCount(h, s.id)).toBe(2);
  });

  test("concurrent: one winner for the last view, and bytes only for that winner", async () => {
    const s = await share(h, "/notes/pic.png", { maxViews: 1 });

    // Eight independent clients race for the single view.
    const pages = await Promise.all(Array.from({ length: 8 }, () => get(h, s.sharePath)));
    const winners = pages.filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    expect(grantCount(h, s.id)).toBe(1);
    const grant = grantOf(await winners[0].text())!;

    // Sixteen concurrent byte fetches from clients that only hold the link: all refused.
    const bare = await Promise.all(
      Array.from({ length: 8 }, (_, i) => [
        get(h, `${s.sharePath}/raw`, { "Fly-Client-IP": `10.0.0.${i}` }),
        get(h, `${s.sharePath}/download`, { "User-Agent": `client-${i}` }),
      ]).flat()
    );
    expect(bare.map((r) => r.status)).toEqual(Array(16).fill(410));

    // The winner's page fetches concurrently and everything is served.
    const owned = await Promise.all(
      Array.from({ length: 8 }, () => [
        get(h, withGrant(`${s.sharePath}/raw`, grant)),
        get(h, withGrant(`${s.sharePath}/download`, grant)),
      ]).flat()
    );
    expect(owned.map((r) => r.status)).toEqual(Array(16).fill(302));
    expect(shareRow(h, s.id).views).toBe(1);
  });

  test("an unlimited link keeps serving bytes on the token alone, with no grant in its page", async () => {
    const s = await share(h, "/notes/pic.png");
    const page = await (await get(h, s.sharePath)).text();
    expect(grantOf(page)).toBeNull();
    expect(page).toContain(`href="/share/${s.token}/download"`);
    expect(grantCount(h, s.id)).toBe(0);
    expect((await get(h, `${s.sharePath}/download`)).status).toBe(302);
    expect((await get(h, `${s.sharePath}/raw`)).status).toBe(302);
  });

  test("the grant is never echoed in logs and never leaves in a Referer", async () => {
    const s = await share(h, "/notes/plain.txt", { maxViews: 1 });
    const res = await get(h, s.sharePath);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const grant = grantOf(await res.text())!;
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      await get(h, withGrant(`${s.sharePath}/download`, grant));
    } finally {
      console.log = orig;
    }
    expect(lines.join("\n")).not.toContain(grant);
  });

  test("backends without presigned URLs: the embed and download carry the grant, bare token gets nothing", async () => {
    const local = await setup({ presigned: false });
    await write(local, "/pic.png", "fake-png-bytes");
    const s = await share(local, "/pic.png", { maxViews: 1 });

    const res = await get(local, s.sharePath);
    const page = await res.text();
    const grant = grantOf(page)!;
    expect(page).toContain(`<img class="media" src="/share/${s.token}/raw?g=${grant}"`);

    expect((await get(local, `${s.sharePath}/raw`)).status).toBe(410);
    expect((await get(local, `${s.sharePath}/download`)).status).toBe(410);
    const raw = await get(local, withGrant(`${s.sharePath}/raw`, grant));
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe("fake-png-bytes");
    const dl = await get(local, withGrant(`${s.sharePath}/download`, grant));
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment;/);
  });
});

describe("time is read fresh at every authorization and presign point", () => {
  let t: Harness;
  beforeAll(async () => {
    t = await setup();
    await write(t, "/pic.png", "fake-png-bytes");
    await write(t, "/notes.txt", "some text");
    await write(t, "/doc.pdf", "fake-pdf-bytes");
  });
  afterAll(() => setSystemTime());

  const expiresAtMs = (id: string) => shareRow(t, id).expires_at * 1000;

  test("every URL is capped to what is left of the link (no 60 / 300 second floor)", async () => {
    const s = await share(t, "/pic.png", { expiresIn: 60 });
    setShare(t, s.id, "expires_at", new Date(Math.floor(Date.now() / 1000) * 1000 + 6000));

    const page = await (await get(t, s.sharePath)).text();
    const embed = /src="([^"]+)"/.exec(page.slice(page.indexOf("<main>")))![1].replace(/&amp;/g, "&");
    const raw = (await get(t, `${s.sharePath}/raw`)).headers.get("location")!;
    const download = (await get(t, `${s.sharePath}/download`)).headers.get("location")!;

    for (const ttl of [urlTtl(embed), urlTtl(raw), urlTtl(download)]) {
      expect(ttl).toBeGreaterThanOrEqual(1);
      expect(ttl).toBeLessThanOrEqual(6);
    }
  });

  test("far from expiry the fixed ceilings still apply", async () => {
    const s = await share(t, "/pic.png");
    const page = await (await get(t, s.sharePath)).text();
    const embed = /src="([^"]+)"/.exec(page.slice(page.indexOf("<main>")))![1].replace(/&amp;/g, "&");
    expect(urlTtl(embed)).toBe(3600);
    expect(urlTtl((await get(t, `${s.sharePath}/raw`)).headers.get("location")!)).toBe(300);
    expect(urlTtl((await get(t, `${s.sharePath}/download`)).headers.get("location")!)).toBe(300);
  });

  test("a page whose storage call outlasts the link is refused and spends no view", async () => {
    const s = await share(t, "/notes.txt", { maxViews: 3 });
    const undo = slowStorage(t, "headObject", jumpClockTo(new Date(expiresAtMs(s.id) + 1000)));
    try {
      const res = await get(t, s.sharePath);
      expect(res.status).toBe(410);
      expect(await res.text()).not.toContain("some text");
    } finally {
      undo();
    }
    expect(shareRow(t, s.id).views).toBe(0);
    expect(grantCount(t, s.id)).toBe(0);
    const events = sqlite(t).prepare("SELECT COUNT(*) AS n FROM events WHERE resource_id = ?").get(s.id) as { n: number };
    expect(events.n).toBe(0);
  });

  test("a preview that finishes reading after the link ended is not released", async () => {
    const s = await share(t, "/notes.txt", { maxViews: 3 });
    const undo = slowStorage(t, "getObject", jumpClockTo(new Date(expiresAtMs(s.id) + 1000)));
    try {
      const res = await get(t, s.sharePath);
      expect(res.status).toBe(410);
      expect(await res.text()).not.toContain("some text");
    } finally {
      undo();
    }
  });

  test("a page whose link is revoked while it reads storage is not released", async () => {
    const s = await share(t, "/notes.txt");
    const undo = slowStorage(t, "getObject", async () => {
      await op(t, { op: "share-revoke", id: s.id });
    });
    try {
      const res = await get(t, s.sharePath);
      expect(res.status).toBe(410);
      expect(await res.text()).not.toContain("some text");
    } finally {
      undo();
    }
  });

  test("download: a storage call that outlasts the link issues no URL", async () => {
    const s = await share(t, "/notes.txt");
    const undo = slowStorage(t, "headObject", jumpClockTo(new Date(expiresAtMs(s.id) + 1000)));
    try {
      const res = await get(t, `${s.sharePath}/download`);
      expect(res.status).toBe(410);
      expect(res.headers.get("location")).toBeNull();
    } finally {
      undo();
    }
  });

  test("download: a revoke that lands during the storage call issues no URL", async () => {
    const s = await share(t, "/notes.txt");
    const undo = slowStorage(t, "headObject", async () => {
      await op(t, { op: "share-revoke", id: s.id });
    });
    try {
      const res = await get(t, `${s.sharePath}/download`);
      expect(res.status).toBe(410);
      expect(res.headers.get("location")).toBeNull();
    } finally {
      undo();
    }
  });

  test("a view-limited download re-checks its grant after the storage call too", async () => {
    const s = await share(t, "/notes.txt", { maxViews: 1 });
    const grant = grantOf(await (await get(t, s.sharePath)).text())!;
    const undo = slowStorage(t, "headObject", () => {
      sqlite(t).prepare("UPDATE share_view_grants SET expires_at = ? WHERE share_id = ?")
        .run(Math.floor(Date.now() / 1000) - 1, s.id);
    });
    try {
      const res = await get(t, withGrant(`${s.sharePath}/download`, grant));
      expect(res.status).toBe(410);
      expect(res.headers.get("location")).toBeNull();
    } finally {
      undo();
    }
  });

  test("streaming backends do not release bytes read after the link ended", async () => {
    const local = await setup({ presigned: false });
    await write(local, "/pic.png", "fake-png-bytes");
    await write(local, "/notes.txt", "some text");
    const s = await share(local, "/pic.png");
    const n = await share(local, "/notes.txt");
    const jump = new Date(Date.parse(s.expiresAt) + 1000);
    const undo = slowStorage(local, "getObject", jumpClockTo(jump));
    try {
      const raw = await get(local, `${s.sharePath}/raw`);
      expect(raw.status).toBe(410);
      expect(await raw.text()).not.toContain("fake-png-bytes");
      setSystemTime();
      const dl = await get(local, `${n.sharePath}/download`);
      expect(dl.status).toBe(410);
      expect(await dl.text()).not.toContain("some text");
    } finally {
      undo();
    }
  });

  test("a stored path that leaves its drive is never turned into a storage read", async () => {
    // A row that got in some way other than share-create. The literal key exists
    // in the mock, so without the guard this would be served.
    const key = `${t.orgId}/drives/${t.driveId}/../secret.png`;
    await t.s3.putObject(key, "OUTSIDE-BYTES");
    const token = generateShareToken();
    sqlite(t).prepare(
      "INSERT INTO shares (id, org_id, drive_id, path, token_hash, expires_at, max_views, views, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).run(
      crypto.randomUUID(), t.orgId, t.driveId, "/../secret.png", hashShareToken(token),
      Math.floor(Date.now() / 1000) + 3600, null, 0, "someone", Math.floor(Date.now() / 1000)
    );
    for (const path of [`/share/${token}`, `/share/${token}/raw`, `/share/${token}/download`]) {
      const res = await get(t, path);
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).not.toContain("OUTSIDE-BYTES");
    }
  });
});

describe("a slow presigner cannot extend a link past its expiry", () => {
  // The real signer (dummy credentials, nothing leaves the process), behind a
  // wrapper that lets the clock move, or a revoke land, before it signs.
  const signer = new AgentS3Client({
    provider: "minio",
    bucket: "test-bucket",
    region: "us-east-1",
    endpoint: "https://s3.example.test",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
  });

  type Surface = "page" | "raw" | "download";
  const surfaces: Surface[] = ["page", "raw", "download"];
  const OK: Record<Surface, number> = { page: 200, raw: 302, download: 302 };

  let p: Harness;
  beforeAll(async () => {
    p = await setup();
    await write(p, "/pic.png", "fake-png-bytes");
  });
  afterAll(() => setSystemTime());

  /** Route every presign through the real signer, after `during` has run. */
  function slowSigner(
    during: () => void | Promise<void>,
    call: (...args: Parameters<AgentS3Client["getPresignedUrl"]>) => Promise<string> = (...args) =>
      signer.getPresignedUrl(...args)
  ) {
    const s3 = p.s3 as any;
    const original = s3.getPresignedUrl;
    s3.getPresignedUrl = async (...args: Parameters<AgentS3Client["getPresignedUrl"]>) => {
      await during();
      return call(...args);
    };
    return () => {
      s3.getPresignedUrl = original;
      setSystemTime();
    };
  }

  /** Independent of the code under test: SigV4 signing time + lifetime, in ms. */
  function signedAtMs(url: string): number {
    const d = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(new URL(url).searchParams.get("X-Amz-Date")!)!;
    return Date.UTC(+d[1], +d[2] - 1, +d[3], +d[4], +d[5], +d[6]);
  }
  const deadlineMs = (url: string) => signedAtMs(url) + Number(new URL(url).searchParams.get("X-Amz-Expires")) * 1000;

  /** Ask for a URL through one of the three issuance paths. */
  async function issue(surface: Surface, sharePath: string, grant: string | null = null) {
    const res = await get(p, withGrant(surface === "page" ? sharePath : `${sharePath}/${surface}`, grant));
    if (surface !== "page") return { res, url: res.headers.get("location") };
    const page = await res.text();
    const main = page.indexOf("<main>");
    const src = main < 0 ? null : /src="([^"]+)"/.exec(page.slice(main))?.[1];
    return { res, url: src ? src.replace(/&amp;/g, "&") : null };
  }

  /** A link that ends six seconds after `t0`, on a whole second. */
  async function shortLink(opts: Record<string, unknown> = {}) {
    const t0 = Math.floor(Date.now() / 1000) * 1000;
    const s = await share(p, "/pic.png", { expiresIn: 60, ...opts });
    setShare(p, s.id, "expires_at", new Date(t0 + 6000));
    return { s, t0, expiresAt: t0 + 6000 };
  }

  test.each(surfaces)("%s: signing that lands inside the link still dies with it", async (surface) => {
    const { s, t0, expiresAt } = await shortLink();
    const undo = slowSigner(() => {
      setSystemTime(new Date(t0 + 2000));
    });
    try {
      const { res, url } = await issue(surface, s.sharePath);
      expect(res.status).toBe(OK[surface]);
      expect(url).toBeTruthy();
      expect(deadlineMs(url!)).toBeLessThanOrEqual(expiresAt);
      // Signed when it was asked for, not when the signer got round to it.
      expect(signedAtMs(url!)).toBeLessThan(t0 + 2000);
    } finally {
      undo();
    }
  });

  test.each(surfaces)("%s: signing that ends after the link is refused, with no URL", async (surface) => {
    const { s, t0 } = await shortLink();
    const undo = slowSigner(() => {
      setSystemTime(new Date(t0 + 7000));
    });
    try {
      const { res, url } = await issue(surface, s.sharePath);
      expect(res.status).toBe(410);
      expect(res.headers.get("location")).toBeNull();
      expect(url).toBeNull();
    } finally {
      undo();
    }
  });

  test.each(surfaces)("%s: a revoke that lands while signing releases no URL", async (surface) => {
    const s = await share(p, "/pic.png");
    const undo = slowSigner(async () => {
      await op(p, { op: "share-revoke", id: s.id });
    });
    try {
      const { res, url } = await issue(surface, s.sharePath);
      expect(res.status).toBe(410);
      expect(res.headers.get("location")).toBeNull();
      expect(url).toBeNull();
    } finally {
      undo();
    }
  });

  test.each(["raw", "download"] as const)("%s: a view grant that lapses while signing releases no URL", async (surface) => {
    const s = await share(p, "/pic.png", { maxViews: 1 });
    // The counted page view is what earns the grant for the byte routes.
    const page = await (await get(p, s.sharePath)).text();
    const grant = grantOf(page);
    expect(grant).not.toBeNull();
    const undo = slowSigner(() => {
      sqlite(p).prepare("UPDATE share_view_grants SET expires_at = ? WHERE share_id = ?")
        .run(Math.floor(Date.now() / 1000) - 1, s.id);
    });
    try {
      const { res, url } = await issue(surface, s.sharePath, grant);
      expect(res.status).toBe(410);
      expect(url).toBeNull();
    } finally {
      undo();
    }
  });

  test.each(surfaces)("%s: a signer that ignores the pinned timestamp is refused, not trusted", async (surface) => {
    const { s, t0 } = await shortLink();
    // Same signer, but the timestamp it was given is dropped: the shape of the
    // original overshoot, where the URL is stamped whenever signing happens.
    const undo = slowSigner(
      () => {
        setSystemTime(new Date(t0 + 2000));
      },
      (key, ttl, ct, cd) => signer.getPresignedUrl(key, ttl, ct, cd)
    );
    try {
      const { res, url } = await issue(surface, s.sharePath);
      expect(res.status).toBe(410);
      expect(res.headers.get("location")).toBeNull();
      expect(url).toBeNull();
    } finally {
      undo();
    }
  });

  test.each(surfaces)("%s: with no delay the URL is unchanged: the ceiling, minus nothing", async (surface) => {
    const s = await share(p, "/pic.png");
    const { res, url } = await issue(surface, s.sharePath);
    expect(res.status).toBe(OK[surface]);
    const ttl = Number(new URL(url!).searchParams.get("X-Amz-Expires"));
    expect(ttl).toBe(surface === "page" ? 3600 : 300);
  });
});

describe("every share response carries the security baseline", () => {
  const BASELINE = ["cache-control", "x-content-type-options", "referrer-policy", "x-robots-tag", "x-frame-options"];

  /** CSP present and locked down: nothing loads by default and nothing frames it. */
  function expectLockedDown(res: Response, what: string) {
    const csp = res.headers.get("content-security-policy");
    expect(csp, `${what}: content-security-policy`).toBeTruthy();
    expect(csp, what).toContain("default-src 'none'");
    expect(csp, what).toContain("frame-ancestors 'none'");
    expect(csp, what).not.toContain("script-src");
    expect(csp, what).not.toContain("unsafe-eval");
    for (const name of BASELINE) expect(res.headers.get(name), `${what}: ${name}`).toBeTruthy();
    expect(res.headers.get("x-content-type-options"), what).toBe("nosniff");
  }

  test("success, redirect, 403, 404 and 410 across every route", async () => {
    const open = await share(h, "/notes/pic.png");
    const limited = await share(h, "/notes/pic.png", { maxViews: 1 });
    await get(h, limited.sharePath); // spend it
    const dead = await share(h, "/notes/pic.png");
    await op(h, { op: "share-revoke", id: dead.id });
    const unseen = await share(h, "/notes/pic.png", { maxViews: 2 });
    const unknown = `/share/${generateShareToken()}`;

    const cases: Array<[string, number, Response]> = [
      ["page 200", 200, await get(h, open.sharePath)],
      ["HEAD 200", 200, await h.app.request(open.sharePath, { method: "HEAD" })],
      ["crawler 200", 200, await get(h, open.sharePath, { "User-Agent": "Slackbot 1.0" })],
      ["raw 302", 302, await get(h, `${open.sharePath}/raw`)],
      ["download 302", 302, await get(h, `${open.sharePath}/download`)],
      ["page 404 unknown", 404, await get(h, unknown)],
      ["page 404 malformed", 404, await get(h, "/share/short")],
      ["raw 404 unknown", 404, await get(h, `${unknown}/raw`)],
      ["download 404 unknown", 404, await get(h, `${unknown}/download`)],
      ["unmatched sub-route 404", 404, await get(h, `${open.sharePath}/nope/deeper`)],
      ["page 410 used up", 410, await get(h, limited.sharePath)],
      ["raw 410 used up", 410, await get(h, `${limited.sharePath}/raw`)],
      ["download 410 used up", 410, await get(h, `${limited.sharePath}/download`)],
      ["page 410 revoked", 410, await get(h, dead.sharePath)],
      ["raw 410 revoked", 410, await get(h, `${dead.sharePath}/raw`)],
      ["raw 403 no grant", 403, await get(h, `${unseen.sharePath}/raw`)],
      ["download 403 no grant", 403, await get(h, `${unseen.sharePath}/download`)],
    ];
    for (const [what, status, res] of cases) {
      expect(res.status, what).toBe(status);
      expectLockedDown(res, what);
    }
  });

  test("the preview page keeps its own CSP and the PDF route its deliberate override", async () => {
    const png = await get(h, (await share(h, "/notes/pic.png")).sharePath);
    const csp = png.headers.get("content-security-policy")!;
    expect(csp).toContain("img-src https://mock.local");
    expect(csp).not.toContain("sandbox"); // the page itself is not sandboxed

    const local = await setup({ presigned: false });
    await write(local, "/doc.pdf", "fake-pdf-bytes");
    const pdf = await get(local, `${(await share(local, "/doc.pdf")).sharePath}/raw`);
    expect(pdf.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(pdf.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  test("the 429 from the rate limiter carries it too", async () => {
    const saved = process.env.AGENT_FS_SHARE_RATE_LIMIT;
    process.env.AGENT_FS_SHARE_RATE_LIMIT = "2";
    try {
      const limited = await setup();
      await write(limited, "/a.md", "# a");
      const s = await share(limited, "/a.md");
      const statuses: number[] = [];
      let refused: Response | null = null;
      for (let i = 0; i < 4; i++) {
        const res = await get(limited, s.sharePath);
        statuses.push(res.status);
        if (res.status === 429) refused ??= res;
      }
      expect(statuses).toEqual([200, 200, 429, 429]);
      expectLockedDown(refused!, "429");
      expect(refused!.headers.get("retry-after")).toBeTruthy();
      expect(await refused!.text()).toBe("Too many requests");
    } finally {
      if (saved === undefined) delete process.env.AGENT_FS_SHARE_RATE_LIMIT;
      else process.env.AGENT_FS_SHARE_RATE_LIMIT = saved;
    }
  });

  test("an internal error is a generic 500 with the baseline, and leaks nothing", async () => {
    const broken = await setup();
    await write(broken, "/a.md", "# a");
    const s = await share(broken, "/a.md");
    const original = console.error;
    console.error = () => {};
    (broken.s3 as any).headObject = async () => {
      throw new Error("bucket agent-fs-prod-secret at https://internal.example exploded");
    };
    try {
      for (const path of [s.sharePath, `${s.sharePath}/download`]) {
        const res = await get(broken, path);
        expect(res.status, path).toBe(500);
        expectLockedDown(res, `500 ${path}`);
        const body = await res.text();
        expect(body).toBe("Something went wrong");
        expect(body).not.toContain("secret");
      }
    } finally {
      console.error = original;
    }
  });
});

describe("audit trail and privacy of the token", () => {
  test("writes one share_viewed event per counted view, and none for HEAD or crawlers", async () => {
    const s = await share(h, "/notes/readme.md", { maxViews: 2 });
    const count = () =>
      sqlite(h)
        .prepare("SELECT * FROM events WHERE resource_id = ? AND type = 'share_viewed'")
        .all(s.id) as Array<Record<string, any>>;

    await h.app.request(s.sharePath, { method: "HEAD" });
    await get(h, s.sharePath, { "User-Agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" });
    await get(h, s.sharePath, { "User-Agent": "WhatsApp/2.23" });
    expect(count()).toHaveLength(0);
    expect(shareRow(h, s.id).views).toBe(0);

    await get(h, s.sharePath);
    await get(h, s.sharePath);
    await get(h, s.sharePath); // over the limit: no event
    const events = count();
    expect(events).toHaveLength(2);
    expect(events[0].resource_type).toBe("share");
    expect(JSON.parse(events[0].metadata!)).toMatchObject({ anonymous: true, path: "/notes/readme.md", viewNumber: 1 });
  });

  test("a crawler gets a generic page with no file details", async () => {
    const s = await share(h, "/notes/readme.md");
    const res = await get(h, s.sharePath, { "User-Agent": "Twitterbot/1.0" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("A file was shared with you");
    expect(body).not.toContain("readme.md");
  });

  test("the token is redacted from request logs", async () => {
    const s = await share(h, "/notes/readme.md");
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      await get(h, s.sharePath);
      await get(h, `${s.sharePath}/download`);
    } finally {
      console.log = orig;
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(s.token);
    expect(lines.join("\n")).toContain("/share/<token>");
  });
});

describe("backends without presigned URLs", () => {
  let local: Harness;
  beforeAll(async () => {
    local = await setup({ presigned: false });
    await write(local, "/pic.png", "fake-png-bytes");
    await write(local, "/notes.md", "# Hi");
  });

  test("embeds through the token-scoped raw route and pins the CSP to 'self'", async () => {
    const s = await share(local, "/pic.png");
    const res = await get(local, s.sharePath);
    const body = await res.text();
    expect(body).toContain(`<img class="media" src="/share/${s.token}/raw"`);
    expect(res.headers.get("content-security-policy")).toContain("img-src 'self'");

    const raw = await get(local, `${s.sharePath}/raw`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("image/png");
    expect(raw.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
    expect(raw.headers.get("content-security-policy")).toContain("sandbox");
    expect(await raw.text()).toBe("fake-png-bytes");
  });

  test("the share page can frame its own PDF, and nothing else can frame the page", async () => {
    await write(local, "/doc.pdf", "fake-pdf-bytes");
    const s = await share(local, "/doc.pdf");
    const page = await get(local, s.sharePath);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(await page.text()).toContain(`<iframe class="media" src="/share/${s.token}/raw"`);
    const raw = await get(local, `${s.sharePath}/raw`);
    expect(raw.headers.get("content-type")).toBe("application/pdf");
    expect(raw.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(raw.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
  });

  test("download streams an attachment", async () => {
    const s = await share(local, "/notes.md");
    const res = await get(local, `${s.sharePath}/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''notes.md");
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await res.text()).toBe("# Hi");
  });

  test("non-embeddable types are refused by the raw route", async () => {
    const s = await share(local, "/notes.md");
    expect((await get(local, `${s.sharePath}/raw`)).status).toBe(404);
  });
});

describe("per-IP rate limit", () => {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.AGENT_FS_SHARE_RATE_LIMIT;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.AGENT_FS_SHARE_RATE_LIMIT;
    else process.env.AGENT_FS_SHARE_RATE_LIMIT = saved;
  });

  test("limits anonymous traffic and cannot be dodged by rotating Authorization headers", async () => {
    process.env.AGENT_FS_SHARE_RATE_LIMIT = "5";
    const limited = await setup();
    await write(limited, "/a.md", "# a");
    const s = await share(limited, "/a.md");

    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await limited.app.request(s.sharePath, { headers: { Authorization: `Bearer fake-key-${i}` } });
      statuses.push(res.status);
      if (res.status === 429) expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    }
    expect(statuses.filter((x) => x === 200)).toHaveLength(5);
    expect(statuses.filter((x) => x === 429)).toHaveLength(3);
  });
});
