import { afterEach, beforeEach, expect, test } from "bun:test"
import { createTestConfigDir, createTestContext } from "../../../../packages/core/src/test-utils.js"
import { createApp } from "../../../../packages/server/src/app.js"
import { resolveShareUrl } from "../share-url"

function newApp() {
  const { db, s3 } = createTestContext()
  return createApp(db, s3)
}

// The whole path: the server validates AGENT_FS_PUBLIC_URL, share-create builds
// the response, and the web app turns that response into the copied link.

let cleanup: () => void
let saved: string | undefined
beforeEach(() => {
  saved = process.env.AGENT_FS_PUBLIC_URL
  ;({ cleanup } = createTestConfigDir())
})
afterEach(() => {
  if (saved === undefined) delete process.env.AGENT_FS_PUBLIC_URL
  else process.env.AGENT_FS_PUBLIC_URL = saved
  cleanup()
})

/** share-create for a file and a folder, through the API, with a private Host. */
async function shareBoth(app = newApp()) {
  const reg = await app.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `path-${Math.random().toString(36).slice(2)}@example.com` }),
  })
  const { apiKey, orgId } = await reg.json()
  const op = async (body: Record<string, unknown>) => {
    const res = await app.request(`/orgs/${orgId}/ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, Host: "internal:7433" },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(200)
    return res.json()
  }
  await op({ op: "write", path: "/site/index.html", content: "<p>hi</p>" })
  return [await op({ op: "share-create", path: "/site/index.html" }), await op({ op: "share-create", path: "/site" })]
}

test("a configured prefix, normalized by the server, is copied as the server built it", async () => {
  process.env.AGENT_FS_PUBLIC_URL = "https://Example.com/a/./b/"
  for (const r of await shareBoth()) {
    expect(resolveShareUrl("http://internal:7433", r)).toBe(`https://example.com/a/b${r.sharePath}`)
  }
})

test("without one, the link is built on the endpoint the app talks to", async () => {
  delete process.env.AGENT_FS_PUBLIC_URL
  for (const r of await shareBoth()) {
    expect(resolveShareUrl("https://proxy.example/fs", r)).toBe(`https://proxy.example/fs${r.sharePath}`)
  }
})

// Every public URL the server starts with must give links the web app copies:
// one the server accepts but the app refuses breaks sharing for that server.
test("any AGENT_FS_PUBLIC_URL the server accepts gives copyable links, for both kinds", async () => {
  for (const configured of ["https://example.com", "https://example.com/", "https://example.com/a/./b/", "https://example.com/a//b", "https://example.com//a", "https://example.com/a%20b/", "https://Example.com:8443/x"]) {
    process.env.AGENT_FS_PUBLIC_URL = configured
    let app: ReturnType<typeof createApp>
    try {
      app = newApp()
    } catch (err) {
      expect(String(err), configured).toMatch(/Invalid AGENT_FS_PUBLIC_URL/)
      continue
    }
    for (const r of await shareBoth(app)) {
      expect(() => resolveShareUrl("http://internal:7433", r), `${configured} → ${r.url}`).not.toThrow()
    }
  }
})
