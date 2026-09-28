import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, MockS3Client } from "../../../core/src/test-utils.js";
import { createUser, setDriveMember } from "../../../core/src/index.js";
import { createApp } from "../app.js";

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

  test("maxViews=1: one page view, then expired; bytes stay reachable only for the grace window", async () => {
    const s = await share(h, "/notes/plain.txt", { maxViews: 1 });

    // Nothing is served before the page was opened.
    expect((await get(h, `${s.sharePath}/download`)).status).toBe(410);

    const first = await get(h, s.sharePath);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("used up");

    const second = await get(h, s.sharePath);
    expect(second.status).toBe(410);
    expect(await second.text()).toContain(EXPIRED_TEXT);

    // The page can still fetch its file right after the view...
    expect((await get(h, `${s.sharePath}/download`)).status).toBe(302);
    // ...but not for long.
    setShare(h, s.id, "last_viewed_at", new Date(Date.now() - 2 * 3600 * 1000));
    expect((await get(h, `${s.sharePath}/download`)).status).toBe(410);
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
