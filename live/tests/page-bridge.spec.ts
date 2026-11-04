import { expect, test, type Frame, type Page } from "@playwright/test"
import { mkdir } from "node:fs/promises"
import { injectHtmlCommentOverlay } from "../../packages/server/src/share/html-comment-overlay"
import { injectHtmlPageBridge } from "../../packages/server/src/share/html-page-bridge"

const EVIDENCE = process.env.PAGE_BRIDGE_EVIDENCE

// The page shows what `window.agentfs` answered; the test drives it with
// `frame.evaluate`, as the page's own buttons would.
const tasksPage = [
  "<!doctype html><html><head><title>Tasks</title></head><body>",
  "<h1>Task list</h1>",
  "<p>Viewer: <span id=\"who\">-</span></p>",
  "<p>Read: <span id=\"read\">-</span></p>",
  "<p>Stat: <span id=\"stat\">-</span></p>",
  "<p>Write: <span id=\"write\">-</span></p>",
  "<script>",
  "window.show = function (id, promise) {",
  "  return promise.then(function (v) { document.getElementById(id).textContent = JSON.stringify(v) },",
  "    function (e) { document.getElementById(id).textContent = 'error ' + e.code });",
  "};",
  "</script>",
  "<p><a id=\"away\" href=\"other.html?__afs_page=1\">Other page</a></p>",
  "</body></html>",
].join("\n")

// Where the frame navigates: it records every message it gets.
const otherPage = "<!doctype html><p id=\"other\">Other page</p><script>window.__msgs = []; addEventListener('message', function (e) { __msgs.push(e.data) })</script>"

// A page that uses the API from its own inline script in <head>, as authors
// write them: a call before `ready` is refused, then identity, me() and a write.
const inlinePage = [
  "<!doctype html><html><head><title>Inline</title><script>",
  "window.R = {};",
  "function mark(k, v) { R[k] = v; var el = document.getElementById(k); if (el) el.textContent = v; }",
  "agentfs.read('notes.md').then(function () { mark('early', 'ok') }, function (e) { mark('early', 'error ' + e.code) });",
  "agentfs.ready",
  "  .then(function () { return agentfs.requestIdentity() })",
  "  .then(function (v) {",
  "    mark('who', JSON.stringify(v)); mark('me', JSON.stringify(agentfs.me()));",
  "    return agentfs.write('data/state.json', '{\"done\":[0]}', { expectedVersion: 1, message: 'Done: task 0' });",
  "  })",
  "  .then(function (r) { mark('write', JSON.stringify(r)) }, function (e) { mark('write', 'error ' + e.code) });",
  "document.addEventListener('DOMContentLoaded', function () { for (var k in R) mark(k, R[k]) });",
  "</script></head><body>",
  "<p>Early: <span id=\"early\">-</span></p><p>Viewer: <span id=\"who\">-</span></p>",
  "<p>me(): <span id=\"me\">-</span></p><p>Write: <span id=\"write\">-</span></p>",
  "</body></html>",
].join("\n")

// A page whose own first script reports whether the API exists, after `doctype`.
const doctypePage = (doctype: string) =>
  `${doctype}<html><head><script>document.title = typeof agentfs</script></head><body><p>doctype</p></body></html>`

// A page that says hello a second time and counts the host answers it sees.
const twicePage = [
  "<!doctype html><html><head><script>",
  "window.hosts = 0;",
  "addEventListener('message', function (e) { if (e.data && e.data.type === 'agent-fs-page:host') hosts++ });",
  "parent.postMessage({ type: 'agent-fs-page:hello', v: 1, nonce: '0123456789abcdef0123456789abcdef' }, '*');",
  "agentfs.ready.then(function () { return agentfs.read('notes.md') }).then(function (r) { document.getElementById('read').textContent = r.content });",
  "</script></head><body><p>Read: <span id=\"read\">-</span></p></body></html>",
].join("\n")

interface StoredFile { content: string; version: number }

interface Fixture {
  features: string[]
  files: Record<string, StoredFile>
  ops: Array<Record<string, unknown>>
  /** Extra pages under /reports, by file name. */
  pages: Record<string, string>
  /** Version the viewer's own stat reports for the page. */
  pageVersion: number
  /** File names /site/ served to a GET, in order. */
  siteLoads: string[]
  /** Ops on these paths wait until released. */
  hold?: { path: string; release: Promise<void> }
}

async function installFixture(page: Page, f: Fixture) {
  await page.addInitScript(() => {
    // Init scripts also run in the sandboxed frame, which has no localStorage.
    if (window !== window.top) return
    localStorage.setItem("agent-fs-credentials", JSON.stringify([
      { id: "qa", name: "QA", endpoint: "http://fixture.test", apiKey: "fixture" },
      { id: "qa2", name: "QA Two", endpoint: "http://fixture.test", apiKey: "fixture2" },
    ]))
    localStorage.setItem("agent-fs-active-credential", "qa")
  })
  await page.route("http://fixture.test/**", async route => {
    const url = new URL(route.request().url())
    let json: unknown
    const second = route.request().headers()["authorization"] === "Bearer fixture2"
    if (url.pathname === "/auth/me") {
      json = second
        ? { userId: "qa2", email: "robin@example.test", displayName: "Robin Two", defaultOrgId: "org", defaultDriveId: "drive" }
        : { userId: "qa", email: "qa@example.test", displayName: "Quinn QA", defaultOrgId: "org", defaultDriveId: "drive" }
    } else if (url.pathname === "/orgs") json = { orgs: [{ id: "org", name: "QA" }, { id: "org2", name: "QA Org 2" }] }
    else if (url.pathname === "/orgs/org2/drives") json = { drives: [{ id: "drive3", name: "Org 2 drive", orgId: "org2" }] }
    else if (url.pathname.endsWith("/drives")) json = { drives: [{ id: "drive", name: "QA", orgId: "org" }, { id: "drive2", name: "QA 2", orgId: "org" }] }
    else if (url.pathname === "/content") return route.fulfill({ body: pageHtml(f, url.searchParams.get("path") ?? ""), contentType: "text/plain" })
    else if (url.pathname.startsWith("/site/")) {
      const name = url.pathname.split("/").pop() ?? ""
      if (route.request().method() === "GET") f.siteLoads.push(name)
      let bytes = new TextEncoder().encode(pageHtml(f, name))
      if (url.searchParams.get("__afs_comments") === "1") bytes = injectHtmlCommentOverlay(bytes)
      if (url.searchParams.get("__afs_page") === "1") bytes = injectHtmlPageBridge(bytes)
      return route.fulfill({ body: Buffer.from(bytes), contentType: "text/html" })
    } else if (url.pathname.endsWith("/ops")) {
      const body = route.request().postDataJSON()
      const file = f.files[body.path]
      if (typeof body.path === "string" && body.path.startsWith("/reports/")) {
        f.ops.push(body)
        if (f.hold?.path === body.path) await f.hold.release
      }
      const etag = (s: StoredFile) => `"v${s.version}"`
      switch (body.op) {
        case "stat":
          if (file) json = { path: body.path, size: file.content.length, author: "qa", currentVersion: file.version, createdAt: "2026-11-01", modifiedAt: "2026-11-04T10:00:00.000Z", isDeleted: false, etag: etag(file) }
          else if (body.path.startsWith("/reports/")) return route.fulfill({ status: 404, json: { error: "NOT_FOUND", message: `File not found: ${body.path}` } })
          else json = { path: body.path, size: tasksPage.length, contentType: "text/html", author: "qa", currentVersion: f.pageVersion, createdAt: "2026-01-01", modifiedAt: "2026-01-01", isDeleted: false }
          break
        case "cat":
          if (!file) return route.fulfill({ status: 404, json: { error: "NOT_FOUND", message: `File not found: ${body.path}` } })
          json = { content: file.content, totalLines: file.content.split("\n").length, truncated: false, etag: etag(file) }
          break
        case "write": {
          if (body.path.endsWith("/data/locked.json")) {
            return route.fulfill({ status: 403, json: { error: "PERMISSION_DENIED", message: "Viewer role cannot write" } })
          }
          const current = file?.version ?? 0
          if (body.expectedVersion !== current) {
            return route.fulfill({ status: 409, json: { error: "EDIT_CONFLICT", message: `Expected version ${body.expectedVersion}, current is ${current}` } })
          }
          f.files[body.path] = { content: body.content, version: current + 1 }
          json = { version: current + 1, path: body.path, size: body.content.length }
          break
        }
        case "signed-url": json = { url: `http://fixture.test/content?path=${body.path}` }; break
        case "share-create": json = { id: "tok", kind: "site", url: "/site/tok/", sharePath: "/site/tok/", path: body.path, expiresIn: 900, expiresAt: new Date(Date.now() + 900_000).toISOString(), maxViews: null }; break
        case "comment-list": json = { comments: [] }; break
        case "comment-notification-list": json = { notifications: [], unreadCount: 0 }; break
        case "ls": json = { entries: [] }; break
        case "tree": json = { tree: [] }; break
        default: return route.abort()
      }
    } else if (url.pathname === "/health") json = { ok: true, version: "test", features: f.features }
    else return route.abort()
    await route.fulfill({ json })
  })
}

function pageHtml(f: Fixture, path: string): string {
  const name = path.split("/").pop() ?? ""
  return f.pages[name] ?? (name === "other.html" ? otherPage : tasksPage)
}

function fixture(over: Partial<Fixture> = {}): Fixture {
  return {
    features: ["share-links", "html-sites", "page-bridge"],
    files: {
      "/reports/notes.md": { content: "# Notes\n\nhello\n", version: 2 },
      "/reports/data/state.json": { content: "{\"done\":[]}", version: 1 },
    },
    ops: [],
    pages: {
      "inline.html": inlinePage,
      "twice.html": twicePage,
      "legacy.html": doctypePage('<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">'),
      "quoted.html": doctypePage('<!DOCTYPE html SYSTEM "a>b">'),
    },
    pageVersion: 1,
    siteLoads: [],
    ...over,
  }
}

const FRAME = 'iframe[title="reports/page.html"]'
const SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"

async function pageFrame(page: Page, file = "page.html"): Promise<Frame> {
  await expect.poll(() => page.frames().some((fr) => fr.url().includes(`/site/tok/${file}`))).toBe(true)
  return page.frames().find((fr) => fr.url().includes(`/site/tok/${file}`))!
}

/** Starts `call` in the page (after `ready`) and shows its answer in `#<id>`. */
async function run(frame: Frame, id: string, call: string) {
  await frame.evaluate(([id, call]) => {
    const w = window as unknown as { show: (id: string, p: Promise<unknown>) => void; agentfs: { ready: Promise<void> } }
    w.show(id, w.agentfs.ready.then(() => new Function(`return agentfs.${call}`)()))
  }, [id, call])
}

const shown = (page: Page, id: string, file = "page.html") => page.frameLocator(`iframe[title="reports/${file}"]`).locator(`#${id}`)

async function evidence(page: Page, name: string) {
  if (!EVIDENCE) return
  await mkdir(EVIDENCE, { recursive: true })
  await page.screenshot({ path: `${EVIDENCE}/${name}` })
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
})

test("Allow gives the page the viewer and lets it read, stat and write data files", async ({ page }) => {
  const f = fixture()
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/page.html")

  const frameEl = page.locator(FRAME)
  await expect(frameEl).toHaveAttribute("src", "http://fixture.test/site/tok/page.html?__afs_page=1")
  await expect(frameEl).toHaveAttribute("sandbox", SANDBOX)
  const frame = await pageFrame(page)

  // Reads need no consent.
  await run(frame, "read", "read('notes.md')")
  await expect(shown(page, "read")).toHaveText(JSON.stringify({ content: "# Notes\n\nhello\n", version: 2 }))
  await run(frame, "stat", "stat('data/missing.json')")
  await expect(shown(page, "stat")).toHaveText("null")

  await run(frame, "who", "requestIdentity()")
  const banner = page.getByRole("region", { name: "Page access" })
  await expect(banner).toContainText("This page, and any page or script in /reports, will know your name and email and can save data files under /reports/data/ as you, until you revoke it.")
  await evidence(page, "page-bridge-consent.png")
  await banner.getByRole("button", { name: "Allow" }).click()
  await expect(shown(page, "who")).toHaveText(JSON.stringify({ name: "Quinn QA", email: "qa@example.test", kind: "member" }))
  await expect(banner).toHaveCount(0)
  await expect(page.getByText("This page can save data files as you")).toBeVisible()
  await evidence(page, "page-bridge-allowed.png")

  await run(frame, "write", "write('data/state.json', '{\"done\":[1]}', { expectedVersion: 1, message: 'Done: task 1' })")
  await expect(shown(page, "write")).toHaveText(JSON.stringify({ version: 2 }))
  expect(f.ops.find((o) => o.op === "write")).toMatchObject({
    op: "write", path: "/reports/data/state.json", content: "{\"done\":[1]}", expectedVersion: 1, message: "Done: task 1", driveId: "drive",
  })
  await run(frame, "stat", "stat('data/state.json')")
  await expect(shown(page, "stat")).toHaveText(JSON.stringify({ version: 2, size: 12, modifiedAt: "2026-11-04T10:00:00.000Z" }))
  await evidence(page, "page-bridge-after-write.png")

  // A stale version is the server's EDIT_CONFLICT; outside data/ never reaches the server.
  const writesBefore = f.ops.filter((o) => o.op === "write").length
  await run(frame, "write", "write('data/state.json', '{}', { expectedVersion: 1 })")
  await expect(shown(page, "write")).toHaveText("error EDIT_CONFLICT")
  await run(frame, "write", "write('index.html', 'pwned', { expectedVersion: 1 })")
  await expect(shown(page, "write")).toHaveText("error NOT_ALLOWED")
  await run(frame, "write", "write('../other/data/x.json', '{}', { expectedVersion: 0 })")
  await expect(shown(page, "write")).toHaveText("error NOT_ALLOWED")
  expect(f.ops.filter((o) => o.op === "write")).toHaveLength(writesBefore + 1)

  // The choice is remembered across reloads until revoked.
  await page.reload()
  const again = await pageFrame(page)
  await run(again, "who", "requestIdentity()")
  await expect(shown(page, "who")).toHaveText(JSON.stringify({ name: "Quinn QA", email: "qa@example.test", kind: "member" }))
  await page.getByRole("button", { name: "Revoke" }).click()
  await expect(page.getByText("This page can save data files as you")).toHaveCount(0)
  await run(again, "write", "write('data/state.json', '{}', { expectedVersion: 2 })")
  await expect(shown(page, "write")).toHaveText("error NOT_ALLOWED")
  await run(again, "who", "requestIdentity()")
  await expect(page.getByRole("region", { name: "Page access" })).toBeVisible()
  await expect(frameEl).toHaveAttribute("sandbox", SANDBOX)
})

test("Keep read-only answers null and refuses writes", async ({ page }) => {
  const f = fixture()
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/page.html")
  const frame = await pageFrame(page)

  await run(frame, "who", "requestIdentity()")
  await page.getByRole("button", { name: "Keep read-only" }).click()
  await expect(shown(page, "who")).toHaveText("null")
  await expect(page.getByRole("region", { name: "Page access" })).toHaveCount(0)
  await run(frame, "write", "write('data/state.json', '{}', { expectedVersion: 1 })")
  await expect(shown(page, "write")).toHaveText("error NOT_ALLOWED")
  expect(f.ops.filter((o) => o.op === "write")).toHaveLength(0)
  // Asking again in the same view does not nag.
  await run(frame, "who", "requestIdentity()")
  await expect(shown(page, "who")).toHaveText("null")
  await expect(page.getByRole("region", { name: "Page access" })).toHaveCount(0)
})

test("a page that navigates mid-request never gets the reply, and the next page gets no bridge", async ({ page }) => {
  let release!: () => void
  const f = fixture({ hold: { path: "/reports/notes.md", release: new Promise<void>((r) => { release = r }) } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/page.html")
  const frame = await pageFrame(page)

  await run(frame, "read", "read('notes.md')")
  await expect.poll(() => f.ops.some((o) => o.path === "/reports/notes.md")).toBe(true)
  await page.frameLocator(FRAME).locator("#away").click()
  const other = await pageFrame(page, "other.html")
  await expect(page.frameLocator(FRAME).locator("#other")).toBeVisible()
  // Let the held read finish and the host try to answer.
  release()
  await expect.poll(() => f.ops.filter((o) => o.path === "/reports/notes.md").length).toBeGreaterThan(1)
  await page.waitForTimeout(300)
  const state = await other.evaluate(() => {
    const w = window as unknown as { __msgs: unknown[]; agentfs?: { ready: Promise<void> } }
    return Promise.race([
      w.agentfs!.ready.then(() => "ready"),
      new Promise((r) => setTimeout(() => r("pending"), 300)),
    ]).then((ready) => ({ ready, msgs: w.__msgs.length }))
  })
  expect(state).toEqual({ ready: "pending", msgs: 0 })
  // The app is unharmed: no errors, no banner, and the viewer still works.
  expect(errors).toEqual([])
  await expect(page.getByRole("region", { name: "Page access" })).toHaveCount(0)
  await expect(page.getByText("page.html").first()).toBeVisible()
})

test("coexists with the comment overlay; old servers get neither flag", async ({ page }) => {
  const f = fixture({ features: ["share-links", "html-sites", "html-comments", "page-bridge"] })
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/page.html")
  await expect(page.locator(FRAME)).toHaveAttribute("src", "http://fixture.test/site/tok/page.html?__afs_comments=1&__afs_page=1")
  const frame = await pageFrame(page)
  await run(frame, "read", "read('notes.md')")
  await expect(shown(page, "read")).toHaveText(JSON.stringify({ content: "# Notes\n\nhello\n", version: 2 }))

  const old = await page.context().newPage()
  await installFixture(old, fixture({ features: ["share-links", "html-sites"] }))
  await old.goto("/file/~/org/drive/reports/page.html")
  await expect(old.locator(FRAME)).toHaveAttribute("src", "http://fixture.test/site/tok/page.html")
})

test("a page's own inline script uses the API: refused before ready, then identity, me() and a write", async ({ page }) => {
  const f = fixture()
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/inline.html")

  await expect(shown(page, "early", "inline.html")).toHaveText("error NOT_ALLOWED")
  await page.getByRole("region", { name: "Page access" }).getByRole("button", { name: "Allow" }).click()
  const viewer = JSON.stringify({ name: "Quinn QA", email: "qa@example.test", kind: "member" })
  await expect(shown(page, "who", "inline.html")).toHaveText(viewer)
  await expect(shown(page, "me", "inline.html")).toHaveText(viewer)
  await expect(shown(page, "write", "inline.html")).toHaveText(JSON.stringify({ version: 2 }))
  expect(f.files["/reports/data/state.json"]).toEqual({ content: "{\"done\":[0]}", version: 2 })
  // The bridge goes after the doctype, so the page keeps standards mode.
  const frame = await pageFrame(page, "inline.html")
  expect(await frame.evaluate(() => document.compatMode)).toBe("CSS1Compat")
  await evidence(page, "page-bridge-inline-script.png")
})

test("a page that says hello twice gets one port", async ({ page }) => {
  const f = fixture()
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/twice.html")
  await expect(shown(page, "read", "twice.html")).toHaveText(/# Notes/)
  const frame = await pageFrame(page, "twice.html")
  await page.waitForTimeout(300)
  expect(await frame.evaluate(() => (window as unknown as { hosts: number }).hosts)).toBe(1)
})

test("the client refuses the 17th request in flight and unserializable requests; server errors keep their code", async ({ page }) => {
  let release!: () => void
  const f = fixture({ hold: { path: "/reports/notes.md", release: new Promise<void>((r) => { release = r }) } })
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/page.html")
  const frame = await pageFrame(page)
  type Api = { ready: Promise<void>; read(p: string): Promise<unknown>; write(p: string, c: unknown, o: unknown): Promise<unknown> }

  const seventeenth = await frame.evaluate(async () => {
    const agentfs = (window as unknown as { agentfs: Api }).agentfs
    await agentfs.ready
    const held = []
    for (let i = 0; i < 16; i++) held.push(agentfs.read("notes.md").catch(() => {}))
    ;(window as unknown as { held: unknown[] }).held = held
    return agentfs.read("notes.md").then(() => "ok", (e: { code: string }) => e.code)
  })
  expect(seventeenth).toBe("NOT_ALLOWED")
  release()
  await frame.evaluate(() => Promise.all((window as unknown as { held: unknown[] }).held))

  const unserializable = await frame.evaluate(() => {
    const agentfs = (window as unknown as { agentfs: Api }).agentfs
    return agentfs.write("data/a.json", () => 1, { expectedVersion: 0 }).then(() => "ok", (e: { code: string }) => e.code)
  })
  expect(unserializable).toBe("VALIDATION_ERROR")

  await run(frame, "who", "requestIdentity()")
  await page.getByRole("button", { name: "Allow" }).click()
  await run(frame, "write", "write('data/locked.json', '{}', { expectedVersion: 0 })")
  await expect(shown(page, "write")).toHaveText("error PERMISSION_DENIED")
})

test("a same-URL reload gives the new document a working bridge", async ({ page }) => {
  const f = fixture()
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/page.html")
  const first = await pageFrame(page)
  await run(first, "read", "read('notes.md')")
  await expect(shown(page, "read")).toHaveText(/Notes/)
  const oldFrame = await page.locator(FRAME).elementHandle()

  // A newer version of the page (noticed by the viewer's 15 s poll): it
  // reloads the frame at the same URL.
  f.pageVersion = 2
  const load = page.getByRole("button", { name: "Load latest" })
  await expect.poll(async () => f.siteLoads.length > 1 || (await load.count()) > 0, { timeout: 25_000 }).toBe(true)
  if (f.siteLoads.length === 1) await load.click()
  await expect.poll(() => f.siteLoads).toEqual(["page.html", "page.html"])
  expect(await oldFrame!.evaluate((el) => el.isConnected)).toBe(false)

  await expect(shown(page, "read")).toHaveText("-")
  const second = await pageFrame(page)
  await run(second, "read", "read('notes.md')")
  await expect(shown(page, "read")).toHaveText(JSON.stringify({ content: "# Notes\n\nhello\n", version: 2 }))
})

const QUINN = JSON.stringify({ name: "Quinn QA", email: "qa@example.test", kind: "member" })

/**
 * Opens the page, starts a `requestIdentity()` that the consent banner holds,
 * runs `change`, and checks the banner closes, the old document never gets a
 * viewer, no consent is stored, and the page in the new context asks again
 * and works through Allow, answering `viewer`.
 */
async function changeWhileAsking(page: Page, change: () => Promise<void>, viewer: string) {
  const f = fixture()
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/page.html")
  const before = await pageFrame(page)
  // The page reports how its pending request settles to the app window, which outlives it.
  await page.evaluate(() => {
    const w = window as unknown as { probes: unknown[] }
    w.probes = []
    addEventListener("message", (e) => { if (e.data && "probe" in e.data) w.probes.push(e.data.probe) })
  })
  await before.evaluate(() => {
    const a = (window as unknown as { agentfs: { ready: Promise<void>; requestIdentity(): Promise<unknown> } }).agentfs
    a.ready.then(() => a.requestIdentity()).then(
      (v) => parent.postMessage({ probe: v }, "*"),
      (e) => parent.postMessage({ probe: `rejected ${e.code}` }, "*"),
    )
  })
  const banner = page.getByRole("region", { name: "Page access" })
  await expect(banner.getByRole("button", { name: "Allow" })).toBeVisible()

  await change()
  await expect(banner).toHaveCount(0)
  await expect.poll(() => f.siteLoads.filter((n) => n === "page.html").length).toBe(2)
  // The old document's request rejected as it unloaded, or never settled: it never got a viewer.
  const probes = await page.evaluate(() => (window as unknown as { probes: unknown[] }).probes)
  expect(probes.every((p) => typeof p === "string" && p.startsWith("rejected"))).toBe(true)
  expect(await page.evaluate(() => localStorage.getItem("liveui:page-access"))).toBeNull()

  const after = await pageFrame(page)
  await run(after, "who", "requestIdentity()")
  await banner.getByRole("button", { name: "Allow" }).click()
  await expect(shown(page, "who")).toHaveText(viewer)
}

/** In-app navigation, as the app's own links do. */
const navigate = (page: Page, path: string) => page.evaluate((path) => {
  history.pushState({}, "", path)
  dispatchEvent(new PopStateEvent("popstate"))
}, path)

test("a drive change while the consent banner is open closes it, and the new document gets a bridge", async ({ page }) => {
  await changeWhileAsking(page, () => navigate(page, "/file/~/org/drive2/reports/page.html"), QUINN)
})

test("an org change while the consent banner is open closes it, and the new document gets a bridge", async ({ page }) => {
  await changeWhileAsking(page, () => navigate(page, "/file/~/org2/drive3/reports/page.html"), QUINN)
})

test("switching account while the consent banner is open closes it, and the next page asks the new member", async ({ page }) => {
  await changeWhileAsking(page, async () => {
    await page.locator("[data-slot=dropdown-menu-trigger]", { hasText: "Quinn QA" }).click()
    await page.getByRole("menuitem", { name: /QA Two/ }).click()
    // The switch lands on the drive root; open the page again as the new member.
    await expect(page.locator(FRAME)).toHaveCount(0)
    await navigate(page, "/file/~/org/drive/reports/page.html")
  }, JSON.stringify({ name: "Robin Two", email: "robin@example.test", kind: "member" }))
})

test("when the browser will not store Allow, it holds for this view only", async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === "liveui:page-access") throw new DOMException("full", "QuotaExceededError")
      return setItem.call(this, key, value)
    }
  })
  const f = fixture()
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/page.html")
  const frame = await pageFrame(page)
  await run(frame, "who", "requestIdentity()")
  await page.getByRole("region", { name: "Page access" }).getByRole("button", { name: "Allow" }).click()
  await expect(page.getByText("This page can save data files as you for this view only")).toBeVisible()
  await run(frame, "write", "write('data/state.json', '{}', { expectedVersion: 1 })")
  await expect(shown(page, "write")).toHaveText(JSON.stringify({ version: 2 }))
  await page.getByRole("button", { name: "Revoke" }).click()
  await run(frame, "write", "write('data/state.json', '{}', { expectedVersion: 2 })")
  await expect(shown(page, "write")).toHaveText("error NOT_ALLOWED")
})

for (const [file, label] of [["legacy.html", "quoted identifiers"], ["quoted.html", "a quoted >"]] as const) {
  test(`a doctype with ${label} keeps the browser's own mode and the API`, async ({ page }) => {
    await installFixture(page, fixture())
    await page.goto(`/file/~/org/drive/reports/${file}`)
    const frame = await pageFrame(page, file)
    await expect.poll(() => frame.evaluate(() => document.title)).toBe("object")
    // The mode the same bytes get without the bridge: the injection must not change it.
    const plain = await page.context().newPage()
    await plain.setContent(fixture().pages[file])
    const expected = await plain.evaluate(() => document.compatMode)
    expect(expected).toBe(file === "legacy.html" ? "CSS1Compat" : "BackCompat")
    expect(await frame.evaluate(() => document.compatMode)).toBe(expected)
  })
}

test("a revoke the browser will not store holds for this view and says so", async ({ page }) => {
  const f = fixture()
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/page.html")
  const frame = await pageFrame(page)
  await run(frame, "who", "requestIdentity()")
  await page.getByRole("region", { name: "Page access" }).getByRole("button", { name: "Allow" }).click()
  await expect(page.getByText("This page can save data files as you")).toBeVisible()
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === "liveui:page-access") throw new DOMException("full", "QuotaExceededError")
      return setItem.call(this, key, value)
    }
  })
  await page.getByRole("button", { name: "Revoke" }).click()
  await expect(page.getByText("Access revoked in this view.")).toBeVisible()
  await run(frame, "write", "write('data/state.json', '{}', { expectedVersion: 1 })")
  await expect(shown(page, "write")).toHaveText("error NOT_ALLOWED")
  await evidence(page, "page-bridge-revoked-this-view.png")
})

test("a write of 256 KB of control characters fits through the bridge", async ({ page }) => {
  const f = fixture()
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/page.html")
  const frame = await pageFrame(page)
  await run(frame, "who", "requestIdentity()")
  await page.getByRole("region", { name: "Page access" }).getByRole("button", { name: "Allow" }).click()
  await run(frame, "write", "write('data/state.json', '\\u0001'.repeat(256 * 1024), { expectedVersion: 1 })")
  await expect(shown(page, "write")).toHaveText(JSON.stringify({ version: 2 }))
  expect(f.files["/reports/data/state.json"].content).toBe("\u0001".repeat(256 * 1024))
})
