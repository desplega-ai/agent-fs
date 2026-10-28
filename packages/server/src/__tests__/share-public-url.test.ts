import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestConfigDir, createTestContext } from "../../../core/src/test-utils.js";
import { createApp } from "../app.js";
import { normalizePublicUrl } from "../public-url.js";

let cleanup: () => void;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.AGENT_FS_PUBLIC_URL;
  ({ cleanup } = createTestConfigDir());
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

  test("anything else is refused, and the server does not start", () => {
    for (const bad of ["ftp://files.example.com", "files.example.com", "https://x.example?tenant=a", "https://x.example/#home", "https://user:pw@x.example", "https://"]) {
      expect(() => normalizePublicUrl(bad), bad).toThrow(/Invalid AGENT_FS_PUBLIC_URL/);
    }
    process.env.AGENT_FS_PUBLIC_URL = "https://x.example?tenant=a";
    const { db, s3 } = createTestContext();
    expect(() => createApp(db, s3)).toThrow(/Invalid AGENT_FS_PUBLIC_URL/);
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
