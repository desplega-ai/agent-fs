import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestConfigDir, createTestContext } from "../../../core/src/test-utils.js";
import { createApp } from "../app.js";
import { normalizePublicUrl } from "../public-url.js";
import { getConfig } from "../../../core/src/config.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

let cleanup: () => void;
let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.AGENT_FS_PUBLIC_URL;
  ({ cleanup, dir: home } = createTestConfigDir());
});
afterEach(() => {
  if (saved === undefined) delete process.env.AGENT_FS_PUBLIC_URL;
  else process.env.AGENT_FS_PUBLIC_URL = saved;
  cleanup();
});

describe("AGENT_FS_PUBLIC_URL", () => {
  test("is normalized: root, path prefix, trailing slash", () => {
    expect(normalizePublicUrl("https://files.example.com")).toBe("https://files.example.com");
    expect(normalizePublicUrl("https://files.example.com/")).toBe("https://files.example.com");
    expect(normalizePublicUrl("http://example.com:8080/agent-fs/")).toBe("http://example.com:8080/agent-fs");
  });

  test("empty means unset", () => {
    expect(normalizePublicUrl(undefined)).toBeUndefined();
    expect(normalizePublicUrl("")).toBeUndefined();
    expect(normalizePublicUrl("  ")).toBeUndefined();
  });

  test("the error never repeats the value, which may hold a secret", () => {
    for (const bad of ["https://user:s3cret@x.example", "https://x.example/?token=s3cret", "ftp://s3cret.example"]) {
      expect(() => normalizePublicUrl(bad)).toThrow(/Invalid AGENT_FS_PUBLIC_URL/);
      try {
        normalizePublicUrl(bad);
      } catch (err) {
        expect(String((err as Error).message)).not.toContain("s3cret");
      }
    }
  });

  test("a path prefix is kept in the canonical form the web app accepts", () => {
    expect(normalizePublicUrl("https://example.com/a/./b/")).toBe("https://example.com/a/b");
    expect(normalizePublicUrl("https://Example.COM/a b")).toBe("https://example.com/a%20b");
  });

  test("anything else is refused, and the server does not start", () => {
    for (const bad of ["ftp://files.example.com", "files.example.com", "https://x.example?tenant=a", "https://x.example/#home", "https://user:pw@x.example", "https://", "https://example.com/a//b", "https://example.com//a"]) {
      expect(() => normalizePublicUrl(bad), bad).toThrow(/Invalid AGENT_FS_PUBLIC_URL/);
    }
    process.env.AGENT_FS_PUBLIC_URL = "https://x.example?tenant=a";
    const { db, s3 } = createTestContext();
    expect(() => createApp(db, s3)).toThrow(/Invalid AGENT_FS_PUBLIC_URL/);
  });
});

describe("AGENT_FS_PUBLIC_URL loading", () => {
  const writeConfig = (dir: string, publicUrl: string) =>
    writeFileSync(join(dir, "config.json"), JSON.stringify({ server: { publicUrl } }));

  test("a config-file value is used, and an invalid one reaches validation", () => {
    delete process.env.AGENT_FS_PUBLIC_URL;
    writeConfig(home, "https://file.example/");
    expect(getConfig().server.publicUrl).toBe("https://file.example/");
    writeConfig(home, "https://file.example?x=1");
    const { db, s3 } = createTestContext();
    expect(() => createApp(db, s3)).toThrow(/Invalid AGENT_FS_PUBLIC_URL/);
  });

  test("the environment wins over the config file, unless it is empty or whitespace", () => {
    writeConfig(home, "https://file.example");
    process.env.AGENT_FS_PUBLIC_URL = "https://env.example";
    expect(getConfig().server.publicUrl).toBe("https://env.example");
    process.env.AGENT_FS_PUBLIC_URL = "nope";
    expect(getConfig().server.publicUrl).toBe("nope"); // passed through, then refused at startup
    for (const empty of ["", "   "]) {
      process.env.AGENT_FS_PUBLIC_URL = empty;
      expect(getConfig().server.publicUrl).toBe("https://file.example");
    }
  });
});

/** share-create for a file and a folder, through the API, with a rewritten Host. */
async function shareBoth() {
  const { db, s3 } = createTestContext();
  const app = createApp(db, s3);
  const reg = await app.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `pub-${Math.random().toString(36).slice(2)}@example.com` }),
  });
  const { apiKey, orgId } = await reg.json();
  const op = async (body: Record<string, unknown>) => {
    const res = await app.request(`/orgs/${orgId}/ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, Host: "internal:7433" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return res.json();
  };
  await op({ op: "write", path: "/site/index.html", content: "<p>hi</p>" });
  return [await op({ op: "share-create", path: "/site/index.html" }), await op({ op: "share-create", path: "/site" })];
}

describe("share-create urlSource", () => {
  test("configured: url is built on AGENT_FS_PUBLIC_URL, for a file and a site", async () => {
    process.env.AGENT_FS_PUBLIC_URL = "https://example.com/agent-fs/";
    for (const r of await shareBoth()) {
      expect(r.urlSource).toBe("configured");
      expect(r.url).toBe(`https://example.com/agent-fs${r.sharePath}`);
    }
  });

  test("request: url comes from the Host header, for a file and a site", async () => {
    delete process.env.AGENT_FS_PUBLIC_URL;
    const [file, site] = await shareBoth();
    expect(site.sharePath.endsWith("/")).toBe(true);
    for (const r of [file, site]) {
      expect(r.urlSource).toBe("request");
      expect(r.url).toBe(`http://internal:7433${r.sharePath}`);
    }
  });
});
