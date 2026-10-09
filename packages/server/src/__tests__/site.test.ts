import { describe, test, expect, beforeAll, afterAll, afterEach, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, MockS3Client } from "../../../core/src/test-utils.js";
import { LocalStorageAdapter } from "../../../core/src/storage/local-adapter.js";
import type { StorageAdapter } from "../../../core/src/storage/adapter.js";
import { generateShareToken } from "../../../core/src/ops/share.js";
import { createApp } from "../app.js";
import { SITE_MAX_OBJECT_BYTES } from "../routes/site.js";

// One app per harness, and these tests make far more than the default limits
// a minute from a single "IP". The limiter has its own test below.
process.env.AGENT_FS_SHARE_RATE_LIMIT = "0";
process.env.AGENT_FS_SITE_RATE_LIMIT = "0";

interface Harness {
  app: ReturnType<typeof createApp>;
  db: ReturnType<typeof createTestDb>;
  s3: StorageAdapter;
  apiKey: string;
  orgId: string;
  driveId: string;
}

type Backend = { presigned: boolean } | { localRoot: string };

async function setup(backend: Backend = { presigned: true }): Promise<Harness> {
  const db = createTestDb();
  const s3: StorageAdapter = "localRoot" in backend
    ? new LocalStorageAdapter({ root: backend.localRoot })
    : new MockS3Client({ capabilities: { presignedUrls: backend.presigned } });
  const app = createApp(db, s3 as any);
  const email = `site-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const { apiKey, orgId } = await reg.json();
  const me = await (await app.request("/auth/me", { headers: { Authorization: `Bearer ${apiKey}` } })).json();
  return { app, db, s3, apiKey, orgId, driveId: me.defaultDriveId };
}

function op(h: Harness, body: Record<string, unknown>) {
  return h.app.request(`/orgs/${h.orgId}/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${h.apiKey}` },
    body: JSON.stringify(body),
  });
}

async function write(h: Harness, path: string, content: string) {
  const res = await op(h, { op: "write", path, content });
  expect(res.status).toBe(200);
}

interface Created {
  id: string; kind: string; url: string; sharePath: string; token: string; maxViews: number | null;
}

async function share(h: Harness, path: string, extra: Record<string, unknown> = {}): Promise<Created> {
  const res = await op(h, { op: "share-create", path, ...extra });
  expect(res.status).toBe(200);
  const body = await res.json();
  const token = (body.sharePath as string).replace(/^\/(share|site)\//, "").replace(/\/$/, "");
  return { ...body, token };
}

const get = (h: Harness, path: string, init?: RequestInit) => h.app.request(path, init);
const sqlite = (h: Harness) => (h.db as any).$client as import("bun:sqlite").Database;

/** The fixed security headers every /site response carries, whatever its status. */
function expectSiteHeaders(res: Response, what = `${res.status}`) {
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(csp, what).toBe(
    "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals; frame-ancestors *"
  );
  expect(csp, what).not.toContain("allow-same-origin");
  expect(res.headers.get("referrer-policy"), what).toBe("no-referrer");
  expect(res.headers.get("x-content-type-options"), what).toBe("nosniff");
  expect(res.headers.get("x-robots-tag"), what).toBe("noindex");
  expect(res.headers.get("cache-control"), what).toBe("no-store");
  expect(res.headers.get("access-control-allow-origin"), what).toBe("*");
  expect(res.headers.get("x-frame-options"), what).toBeNull();
}

/** A site with an index, a nested folder, data and a page that is not in the folder. */
async function seed(h: Harness) {
  await write(h, "/site/index.html", '<!doctype html><img src="pic.png"><script>fetch("data.json")</script>');
  await write(h, "/site/data.json", '{"ok":true}');
  await write(h, "/site/app.js", "console.log(1)");
  await write(h, "/site/sub/index.html", "<p>sub index</p>");
  await write(h, "/site/noindex/readme.txt", "no index here");
  await write(h, "/site/a b/c#d.txt", "spaced");
  await write(h, "/site/%2e%2e/other.txt", "literal dots folder");
  await write(h, "/other.txt", "SECRET-OUTSIDE");
  await write(h, "/site-other/x.txt", "SECRET-SIBLING");
}

// The mock S3 with and without presigned URLs (site responses are proxied
// either way), plus the real local-filesystem backend, whose folders are
// directories: headObject answers for them and reading one fails with EISDIR.
const backends: Array<{ label: string; make: () => Backend }> = [
  { label: "presignedUrls: false", make: () => ({ presigned: false }) },
  { label: "presignedUrls: true", make: () => ({ presigned: true }) },
  { label: "local filesystem", make: () => ({ localRoot: mkdtempSync(join(tmpdir(), "afs-site-test-")) }) },
];

for (const { label, make } of backends) {
  describe(`site shares (${label})`, () => {
    let h: Harness;
    let site: Created;
    const backend = make();

    beforeAll(async () => {
      h = await setup(backend);
      await seed(h);
      site = await share(h, "/site");
    });

    afterAll(() => {
      if ("localRoot" in backend) rmSync(backend.localRoot, { recursive: true, force: true });
    });

    describe("share-create", () => {
      test("a folder share returns kind site and a /site/<token>/ URL", async () => {
        expect(site.kind).toBe("site");
        expect(site.sharePath).toBe(`/site/${site.token}/`);
        // Absolute when the server knows its public address; relative here.
        expect(site.url.endsWith(site.sharePath)).toBe(true);
        expect(site.maxViews).toBeNull();
        const file = await share(h, "/site/data.json");
        expect(file.kind).toBe("file");
        expect(file.sharePath).toBe(`/share/${file.token}`);
      });

      test("a missing folder is 404", async () => {
        const res = await op(h, { op: "share-create", path: "/nope/" });
        expect(res.status).toBe(404);
        expect((await res.json()).message).toContain("File or folder not found");
      });

      test("maxViews on a folder is rejected", async () => {
        const res = await op(h, { op: "share-create", path: "/site", maxViews: 1 });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe("VALIDATION_ERROR");
      });
    });

    describe("path resolution", () => {
      test("/site/<t>/ serves index.html as text/html", async () => {
        const res = await get(h, `/site/${site.token}/`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(await res.text()).toContain('fetch("data.json")');
        expectSiteHeaders(res);
      });

      test("HEAD answers like GET without a body", async () => {
        const res = await get(h, `/site/${site.token}/`, { method: "HEAD" });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(await res.text()).toBe("");
        expectSiteHeaders(res);
      });

      test("/site/<t> redirects to /site/<t>/", async () => {
        const res = await get(h, `/site/${site.token}`);
        expect(res.status).toBe(301);
        expect(res.headers.get("location")).toBe(`/site/${site.token}/`);
        expectSiteHeaders(res);
      });

      test("/site/<t>/sub with sub/index.html redirects to sub/, which serves it", async () => {
        const res = await get(h, `/site/${site.token}/sub?x=1`);
        expect(res.status).toBe(301);
        expect(res.headers.get("location")).toBe(`/site/${site.token}/sub/?x=1`);
        expectSiteHeaders(res);
        const index = await get(h, `/site/${site.token}/sub/`);
        expect(index.status).toBe(200);
        expect(await index.text()).toBe("<p>sub index</p>");
      });

      test("a folder without index.html is 404, with or without the slash", async () => {
        for (const path of ["noindex", "noindex/", "missing.html", "missing/"]) {
          const res = await get(h, `/site/${site.token}/${path}`);
          expect(res.status, path).toBe(404);
          expectSiteHeaders(res, path);
        }
      });

      test("serves JSON, JavaScript and encoded names", async () => {
        const json = await get(h, `/site/${site.token}/data.json`);
        expect(json.status).toBe(200);
        expect(json.headers.get("content-type")).toBe("application/json; charset=utf-8");
        expect(await json.json()).toEqual({ ok: true });

        const js = await get(h, `/site/${site.token}/app.js`);
        expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");

        const spaced = await get(h, `/site/${site.token}/a%20b/c%23d.txt`);
        expect(spaced.status).toBe(200);
        expect(await spaced.text()).toBe("spaced");
      });
    });

    describe("escapes", () => {
      test("positive control: the outside file exists and a drive-root site serves it", async () => {
        const root = await share(h, "/");
        const res = await get(h, `/site/${root.token}/other.txt`);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("SECRET-OUTSIDE");
      });

      test("dot segments, encoded dots, encoded slashes and NUL never leave the folder", async () => {
        const attempts = [
          "../other.txt",
          "%2e%2e/other.txt",
          "%2E%2E/other.txt",
          "..%2Fother.txt",
          "..%2fother.txt",
          "sub%2F..%2F..%2Fother.txt",
          "..%2F..%2Fother.txt",
          "%2e%2e%2fother.txt",
          "..%5Cother.txt",
          "%252e%252e%252fother.txt",
          "..%2Fsite-other%2Fx.txt",
          "other.txt%00",
          "%00",
          "a%00b/../other.txt",
          "%E0%A4%A",
        ];
        for (const attempt of attempts) {
          const res = await get(h, `/site/${site.token}/${attempt}`);
          const body = await res.text();
          expect([400, 404], attempt).toContain(res.status);
          expect(body, attempt).not.toContain("SECRET");
          expectSiteHeaders(res, attempt);
        }
      });

      test("a double-encoded %2e%2e is decoded once: it names the literal folder, not ..", async () => {
        const res = await get(h, `/site/${site.token}/%252e%252e/other.txt`);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("literal dots folder");
      });

      test("an encoded dot-dot that reaches the route is refused with 400", async () => {
        for (const attempt of ["..%2Fother.txt", "sub%2F..%2F..%2Fother.txt", "a%00b"]) {
          const res = await get(h, `/site/${site.token}/${attempt}`);
          expect(res.status, attempt).toBe(400);
        }
      });
    });

    test("views write no share_viewed event and leave views at 0", async () => {
      const fresh = await share(h, "/site");
      for (const path of ["", "data.json", "sub", "sub/", "missing"]) {
        await get(h, `/site/${fresh.token}/${path}`);
      }
      // Through /share/<t> too: the redirect must not spend a view either.
      await get(h, `/share/${fresh.token}`);
      const row = sqlite(h).prepare("SELECT views, last_viewed_at FROM shares WHERE id = ?").get(fresh.id) as any;
      expect(row.views).toBe(0);
      expect(row.last_viewed_at).toBeNull();
      const events = sqlite(h)
        .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'share_viewed' AND resource_id = ?")
        .get(fresh.id) as { n: number };
      expect(events.n).toBe(0);
    });

    test("OPTIONS answers the preflight with 204 and the CORS headers", async () => {
      const res = await get(h, `/site/${site.token}/data.json`, {
        method: "OPTIONS",
        headers: { Origin: "null", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-a" },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toBe("GET, HEAD");
      expect(res.headers.get("access-control-allow-headers")).toBe("*");
      expectSiteHeaders(res);
    });

    describe("kind separation", () => {
      test("a file share token on /site/ is 404", async () => {
        const file = await share(h, "/site/data.json");
        for (const path of [`/site/${file.token}/`, `/site/${file.token}/data.json`]) {
          const res = await get(h, path);
          expect(res.status, path).toBe(404);
          expect(await res.text()).not.toContain("ok");
        }
      });

      test("a site token on /share/<t> redirects to /site/<t>/; /raw and /download are 404", async () => {
        const res = await get(h, `/share/${site.token}`);
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(`/site/${site.token}/`);
        for (const sub of ["raw", "download"]) {
          const bytes = await get(h, `/share/${site.token}/${sub}`);
          expect(bytes.status, sub).toBe(404);
        }
      });

      test("an unknown token is 404", async () => {
        const res = await get(h, `/site/${generateShareToken()}/`);
        expect(res.status).toBe(404);
        expectSiteHeaders(res);
        expect((await get(h, "/site/junk/")).status).toBe(404);
      });
    });

    describe("lifecycle", () => {
      afterEach(() => setSystemTime());

      test("an expired share is 410", async () => {
        const s = await share(h, "/site", { expiresIn: 60 });
        expect((await get(h, `/site/${s.token}/`)).status).toBe(200);
        setSystemTime(new Date(Date.now() + 61_000));
        const res = await get(h, `/site/${s.token}/`);
        expect(res.status).toBe(410);
        expectSiteHeaders(res);
      });

      test("a revoked share is 410", async () => {
        // Its own folder, so the path revoke leaves the other tests' /site shares alone.
        const s = await share(h, "/site/sub");
        expect((await get(h, `/site/${s.token}/`)).status).toBe(200);
        expect((await op(h, { op: "share-revoke", path: "site/sub/" })).status).toBe(200);
        const res = await get(h, `/site/${s.token}/`);
        expect(res.status).toBe(410);
        expect(await res.text()).not.toContain("sub index");
      });

      test("a share revoked while storage is read releases nothing", async () => {
        const s = await share(h, "/site");
        const s3 = h.s3 as any;
        const original = s3.getObject.bind(s3);
        s3.getObject = async (...args: unknown[]) => {
          const result = await original(...args);
          sqlite(h).prepare("UPDATE shares SET revoked_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), s.id);
          return result;
        };
        try {
          const res = await get(h, `/site/${s.token}/data.json`);
          expect(res.status).toBe(410);
          expect(await res.text()).not.toContain("ok");
        } finally {
          s3.getObject = original;
        }
      });

      test("a share that expires while storage is read releases nothing", async () => {
        const s = await share(h, "/site", { expiresIn: 60 });
        const s3 = h.s3 as any;
        const original = s3.getObject.bind(s3);
        s3.getObject = async (...args: unknown[]) => {
          const result = await original(...args);
          setSystemTime(new Date(Date.now() + 120_000));
          return result;
        };
        try {
          expect((await get(h, `/site/${s.token}/data.json`)).status).toBe(410);
        } finally {
          s3.getObject = original;
        }
      });
    });

    test("an object over 25 MB is refused with 413", async () => {
      const key = `${h.orgId}/drives/${h.driveId}/site/big.bin`;
      await h.s3.putObject(key, new Uint8Array(SITE_MAX_OBJECT_BYTES + 1));
      const res = await get(h, `/site/${site.token}/big.bin`);
      expect(res.status).toBe(413);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expectSiteHeaders(res);

      await h.s3.putObject(`${h.orgId}/drives/${h.driveId}/site/edge.bin`, new Uint8Array(SITE_MAX_OBJECT_BYTES));
      const edge = await get(h, `/site/${site.token}/edge.bin`);
      expect(edge.status).toBe(200);
      expect(edge.headers.get("content-length")).toBe(String(SITE_MAX_OBJECT_BYTES));
    });

    test("a drive-root site serves the root index.html", async () => {
      await write(h, "/index.html", "<p>root</p>");
      const root = await share(h, "/");
      expect(root.kind).toBe("site");
      const res = await get(h, `/site/${root.token}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<p>root</p>");
      const nested = await get(h, `/site/${root.token}/site/sub`);
      expect(nested.status).toBe(301);
      expect(nested.headers.get("location")).toBe(`/site/${root.token}/site/sub/`);
    });
  });
}

describe("site route plumbing", () => {
  test("/health advertises html-sites", async () => {
    const h = await setup();
    const res = await h.app.request("/health");
    expect((await res.json()).features).toContain("html-sites");
  });

  test("has its own per-IP limit, and the 429 carries the site headers", async () => {
    const saved = process.env.AGENT_FS_SITE_RATE_LIMIT;
    process.env.AGENT_FS_SITE_RATE_LIMIT = "2";
    try {
      const h = await setup();
      await seed(h);
      const s = await share(h, "/site");
      const statuses: number[] = [];
      let refused: Response | null = null;
      for (let i = 0; i < 3; i++) {
        const res = await get(h, `/site/${s.token}/data.json`);
        statuses.push(res.status);
        if (res.status === 429) refused ??= res;
      }
      expect(statuses).toEqual([200, 200, 429]);
      expectSiteHeaders(refused!);
      // The /share limit is separate (disabled here).
      expect((await get(h, `/share/${s.token}`)).status).toBe(302);
    } finally {
      if (saved === undefined) delete process.env.AGENT_FS_SITE_RATE_LIMIT;
      else process.env.AGENT_FS_SITE_RATE_LIMIT = saved;
    }
  });

  test("an internal error is a generic 500 with the site headers", async () => {
    const h = await setup();
    await seed(h);
    const s = await share(h, "/site");
    (h.s3 as any).getObject = async () => {
      throw new Error("bucket secret-bucket at https://internal.example unreachable");
    };
    const res = await get(h, `/site/${s.token}/data.json`);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Something went wrong");
    expectSiteHeaders(res);
  });
});
