import { expect, test, type Browser, type Page } from "@playwright/test"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// The writable-share shell against the real API server: a child process with
// its own AGENT_FS_HOME, a local storage root and a random port, like the
// daemons `scripts/e2e.ts` starts.

const EVIDENCE = process.env.EVIDENCE_DIR

// A task page as an author would write it: identity on load, a read, and a
// conditional write of its state.
const tasksPage = `<!doctype html><html><head><title>Tasks</title></head><body>
<h1>Tasks</h1>
<p>Viewer: <span id="who">-</span></p>
<p>State: <span id="state">-</span></p>
<p>Result: <span id="result">-</span></p>
<button id="done">Mark task 1 done</button>
<script>
var version = 0;
function show(id, v) { document.getElementById(id).textContent = v; }
function load() {
  return agentfs.read("data/state.json").then(function (r) { version = r.version; show("state", r.content); },
    function (e) { show("state", "error " + e.code); });
}
agentfs.ready.then(function () { return agentfs.requestIdentity(); }).then(function (v) {
  show("who", v ? v.name + " <" + v.email + "> (" + v.kind + ")" : "anonymous");
  return load();
});
document.getElementById("done").onclick = function () {
  agentfs.write("data/state.json", JSON.stringify({ done: [1], at: Date.now() }), { expectedVersion: version, message: "Done: task 1" })
    .then(function (r) { version = r.version; show("result", "saved v" + r.version); }, function (e) { show("result", "error " + e.code); });
};
</script></body></html>`

// Shows whether `agentfs` ever became ready.
const secondPage = `<!doctype html><p id="ready">waiting</p>
<script>agentfs.ready.then(function () { document.getElementById("ready").textContent = "ready"; });</script>`

let server: ChildProcess
let home: string
let api: string
let auth: { apiKey: string; orgId: string }
let pageUrl: string

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer()
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      if (!addr || typeof addr === "string") return fail(new Error("no port"))
      srv.close(() => done(addr.port))
    })
  })
}

async function op(body: Record<string, unknown>) {
  const res = await fetch(`${api}/orgs/${auth.orgId}/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.apiKey}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${body.op}: ${res.status} ${await res.text()}`)
  return res.json()
}

test.beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "afs-page-shell-"))
  const storage = join(home, "storage")
  mkdirSync(storage)
  const port = await freePort()
  api = `http://127.0.0.1:${port}`
  writeFileSync(join(home, "config.json"), JSON.stringify({
    s3: { provider: "local", root: storage },
    embedding: { provider: "local", model: "", apiKey: "" },
    server: { port, host: "127.0.0.1" },
    auth: { apiKey: "" },
    minio: { containerId: "", managed: false },
  }))
  server = spawn("bun", ["run", "packages/cli/src/index.ts", "server"], {
    cwd: resolve(".."),
    env: {
      ...process.env,
      AGENT_FS_HOME: home,
      AGENT_FS_STORAGE_PROVIDER: "local",
      AGENT_FS_LOCAL_ROOT: storage,
      ANONYMIZED_TELEMETRY: "false",
      EMBEDDING_API_KEY: "",
      OPENAI_API_KEY: "",
      S3_ENDPOINT: "",
      S3_BUCKET: "",
      AGENT_FS_PUBLIC_URL: "",
    },
    stdio: "ignore",
  })
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${api}/health`).then((r) => r.ok, () => false)) break
    await new Promise((r) => setTimeout(r, 200))
  }
  const reg = await fetch(`${api}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@page-shell.test" }),
  })
  auth = await reg.json()
  await op({ op: "write", path: "/tasks/index.html", content: tasksPage })
  await op({ op: "write", path: "/tasks/nav.html", content: '<!doctype html><script>location.href = "second.html?__afs_page=1"</script>' })
  await op({ op: "write", path: "/tasks/second.html", content: secondPage })
  await op({ op: "write", path: "/tasks/wrongack.html", content: secondPage })
  const share = await op({ op: "share-create", path: "/tasks", writable: true })
  expect(share.writable).toBe(true)
  pageUrl = `${api}${share.sharePath}`
})

test.afterAll(() => {
  server?.kill()
  if (home) rmSync(home, { recursive: true, force: true })
})

async function open(browser: Browser, name = "", init?: () => void, colorScheme: "light" | "dark" = "light"): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, colorScheme })
  if (init) await context.addInitScript(init)
  const page = await context.newPage()
  await page.goto(`${pageUrl}${name}`)
  return page
}

const frameOf = (page: Page) => page.frameLocator("#page")

async function giveName(page: Page, name: string, email: string) {
  const dialog = page.getByRole("dialog", { name: "Who is viewing?" })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel("Name").fill(name)
  await dialog.getByLabel("Email").fill(email)
  await dialog.getByRole("button", { name: "Continue" }).click()
  await expect(dialog).toBeHidden()
}

test("a guest names themselves once, saves, is remembered, and conflicts are caught", async ({ browser }) => {
  // A CSP violation in the shell would show up on the console.
  const violations: string[] = []
  const david = await open(browser)
  david.on("console", (m) => /Content Security Policy/i.test(m.text()) && violations.push(m.text()))
  await expect(david.getByRole("dialog", { name: "Who is viewing?" })).toBeVisible()
  if (EVIDENCE) await david.screenshot({ path: `${EVIDENCE}/guest-dialog.png` })
  await giveName(david, "David Example", "david@example.com")
  const frame = frameOf(david)
  await expect(frame.locator("#who")).toHaveText("David Example <david@example.com> (guest)")
  await expect(frame.locator("#state")).toHaveText("error NOT_FOUND")
  await expect(david.getByText("Saving as David Example")).toBeVisible()

  await frame.getByRole("button", { name: "Mark task 1 done" }).click()
  await expect(frame.locator("#result")).toHaveText("saved v1")
  if (EVIDENCE) await david.screenshot({ path: `${EVIDENCE}/page-after-guest-write.png` })
  const log = await op({ op: "log", path: "/tasks/data/state.json" })
  expect(log.versions[0].message).toBe("Guest David Example <david@example.com>: Done: task 1")

  // A reload remembers the guest: no dialog, and the saved state is read back.
  await david.reload()
  await expect(frameOf(david).locator("#who")).toHaveText("David Example <david@example.com> (guest)")
  await expect(frameOf(david).locator("#state")).toHaveText(/^\{"done":\[1\],"at":\d+\}$/)
  await expect(david.getByRole("dialog", { name: "Who is viewing?" })).toBeHidden()

  // A second browser reads version 1; David saves version 2 first, so Eve's
  // write of version 1 conflicts instead of overwriting it.
  const eve = await open(browser)
  await giveName(eve, "Eve", "eve@example.com")
  await expect(frameOf(eve).locator("#state")).toHaveText(/^\{"done":\[1\],"at":\d+\}$/)
  await frameOf(david).getByRole("button", { name: "Mark task 1 done" }).click()
  await expect(frameOf(david).locator("#result")).toHaveText("saved v2")
  await frameOf(eve).getByRole("button", { name: "Mark task 1 done" }).click()
  await expect(frameOf(eve).locator("#result")).toHaveText("error EDIT_CONFLICT")

  // "Not you?" forgets the guest: the page reloads and asks again.
  await david.getByRole("button", { name: "Not you?" }).click()
  const dialog = david.getByRole("dialog", { name: "Who is viewing?" })
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(frameOf(david).locator("#who")).toHaveText("anonymous")
  // Reads need no name: the folder is public through its link anyway.
  await expect(frameOf(david).locator("#state")).toHaveText(/^\{"done":\[1\],"at":\d+\}$/)
  await frameOf(david).getByRole("button", { name: "Mark task 1 done" }).click()
  await expect(frameOf(david).locator("#result")).toHaveText("error NOT_ALLOWED")
  expect(violations).toEqual([])
})

test("the shell's guest routes refuse requests from another origin", async ({ browser }) => {
  const page = await open(browser)
  await page.goto("about:blank")
  const status = await page.evaluate(async (url) => {
    try {
      const res = await fetch(`${url}me`, { method: "POST", headers: { "Content-Type": "application/json", "X-Agent-FS-Page": "1" }, body: "{}" })
      return res.status
    } catch {
      return "blocked"
    }
  }, pageUrl)
  // A cross-origin preflight gets no CORS headers, so the browser never sends it.
  expect(status).toBe("blocked")
})

test("a page that navigates its frame loses the bridge: the next document never becomes ready", async ({ browser }) => {
  const page = await open(browser, "nav.html")
  const frame = frameOf(page)
  await expect(frame.locator("#ready")).toHaveText("waiting")
  await page.waitForTimeout(1000)
  await expect(frame.locator("#ready")).toHaveText("waiting")
})

test("a wrong ack closes the port: later requests get no answer", async ({ browser }) => {
  // Runs before the bridge in the framed page and takes the port from it.
  const page = await open(browser, "wrongack.html", () => {
    if (window === window.top || !location.pathname.endsWith("/wrongack.html")) return
    const w = window as unknown as { replies: unknown[]; asked: boolean }
    w.replies = []
    addEventListener("message", (e) => {
      if (!e.data || e.data.type !== "agent-fs-page:host") return
      e.stopImmediatePropagation()
      const port = e.ports[0]
      port.onmessage = (m) => w.replies.push(m.data)
      port.postMessage({ type: "agent-fs-page:ack", nonce: "0".repeat(32) })
      port.postMessage({ id: 1, op: "stat", path: "index.html" })
      w.asked = true
    }, true)
  })
  const framed = () => page.frames().find((f) => f.url().includes("/site/") && f.url().includes("/wrongack.html"))
  await expect.poll(() => !!framed()).toBe(true)
  const frame = framed()!
  await expect.poll(() => frame.evaluate(() => (window as unknown as { asked?: boolean }).asked === true)).toBe(true)
  await page.waitForTimeout(1000)
  expect(await frame.evaluate(() => (window as unknown as { replies: unknown[] }).replies)).toEqual([])
  await expect(frameOf(page).locator("#ready")).toHaveText("waiting")
})

test("a guest write of 256 KB of control characters fits through the shell", async ({ browser }) => {
  const page = await open(browser)
  await giveName(page, "Cora Control", "cora@example.com")
  const frame = page.frames().find((f) => f.url().includes("/site/"))!
  const result = await frame.evaluate(() => {
    const a = (window as unknown as { agentfs: { write(p: string, c: string, o: object): Promise<unknown> } }).agentfs
    return a.write("data/control.txt", "\u0001".repeat(256 * 1024), { expectedVersion: 0 })
  })
  expect(result).toEqual({ version: 1 })
  const stat = await op({ op: "stat", path: "/tasks/data/control.txt" })
  expect(stat.size).toBe(256 * 1024)
})

test('"Not you?" keeps the guest and offers a retry when forgetting fails', async ({ browser }) => {
  const page = await open(browser)
  await giveName(page, "Dana Retry", "dana@example.com")
  await expect(page.getByText("Saving as Dana Retry")).toBeVisible()
  let failing = true
  await page.route("**/page/*/guest", (route) =>
    route.request().method() === "DELETE" && failing ? route.fulfill({ status: 500, body: "nope" }) : route.fallback())
  await page.evaluate(() => { (window as unknown as { marker: number }).marker = 1 })

  await page.getByRole("button", { name: "Not you?" }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Could not forget you. Try again." })).toBeVisible()
  // Not reloaded: the shell document is the same one, and the guest is still shown.
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1)
  await expect(page.getByText("Saving as Dana Retry")).toBeVisible()
  if (EVIDENCE) await page.screenshot({ path: `${EVIDENCE}/not-you-failed.png` })

  failing = false
  await page.getByRole("button", { name: "Not you?" }).click()
  await expect(page.getByRole("dialog", { name: "Who is viewing?" })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBeUndefined()
})

test("the guest dialog follows a dark system theme with the live app's colours", async ({ browser }) => {
  const page = await open(browser, "", undefined, "dark")
  const form = page.locator("#guest-form")
  await expect(form).toBeVisible()
  // --card of the app's dark theme (live/src/index.css).
  await expect(form).toHaveCSS("background-color", "oklch(0.18 0.004 60)")
  if (EVIDENCE) await page.screenshot({ path: `${EVIDENCE}/guest-dialog-dark.png` })
})
