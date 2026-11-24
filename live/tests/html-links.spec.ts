import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { expect, test, type Page } from "@playwright/test"
import { injectHtmlLinkHandler } from "../../packages/server/src/share/html-link-handler"

const SITE_HOST = "fixture.test"
// Worker launch options can only be set for the whole file.
test.use({
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: [`--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1`],
  },
})

const SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"
const enc = (s: string) => new TextEncoder().encode(s)

// ---------------------------------------------------------------------------
// The page's handler: which links it hands over, against a minimal parent.
// `http://docs.test` plays the app's host; the fixture adds the handler to a
// page loaded in a frame, as `/site` does.
// ---------------------------------------------------------------------------

const DOCS = "http://docs.test"
const SHARE = "/fs/site/TOKEN/"

const linksPage = `<!doctype html><body>
<a id="same" href="notes.html">same folder</a>
<a id="sub" href="sub/x.html">sub-folder</a>
<a id="up-in" href="../top.html">parent folder, still shared</a>
<a id="hash" href="#part">anchor</a>
<a id="query" href="?view=2">query</a>
<a id="abs-in" href="${DOCS}${SHARE}other.html">absolute, shared</a>
<a id="up-out" href="../../x.html">parent folder, out of the share</a>
<a id="docs" href="${DOCS}/file/acme/context/plan.md">docs, another drive</a>
<a id="ext" href="https://linear.example/issue/ENG-1">external</a>
<a id="nested" href="${DOCS}/page/acme/work/slides.html"><span id="nested-span">nested</span></a>
<a id="self" href="${DOCS}/file/acme/work/a.md" target="_self">target _self</a>
<a id="empty" href="${DOCS}/file/acme/work/a.md" target="">empty target</a>
<a id="blank" href="${DOCS}/file/acme/work/a.md" target="_blank">target _blank</a>
<a id="top" href="${DOCS}/file/acme/work/a.md" target="_top">target _top</a>
<a id="named" href="${DOCS}/file/acme/work/a.md" target="other">named target</a>
<a id="download" href="${DOCS}/file/acme/work/a.md" download>download</a>
<a id="mailto" href="mailto:a@example.test">mail</a>
<a id="js" href="javascript:void(0)">javascript</a>
<a id="handled" href="${DOCS}/file/acme/work/a.md" onclick="event.preventDefault()">page handles it</a>
<map name="m"><area id="area" href="https://external.example/area" shape="rect" coords="0,0,10,10"></map>
</body>`

/** Pages with `<base target>`, by name. */
const BASE_TARGETS: Record<string, string> = { "base-self.html": "_self", "base-empty.html": "", "base-blank.html": "_blank" }
const basePage = (target: string) => `<!doctype html><head><base target="${target}"></head><body>
<a id="docs" href="${DOCS}/file/acme/context/plan.md">docs</a>
<a id="ext" href="https://linear.example/issue/ENG-1">external</a></body>`

// After the handler: notes when the parent has answered the handler (this
// listener runs after the handler's), and records whether each click was
// cancelled, then cancels it so no link leaves the page under test.
const recorder = `<script>window.__clicks = {};
addEventListener("message", function (e) { if (e.data && e.data.type === "agent-fs-links:host") window.__hosted = true });
addEventListener("click", function (e) { var a = e.target.closest("a,area"); __clicks[a.id] = e.defaultPrevented; e.preventDefault() })</script>`

/** A parent that frames `page` and, unless `silent`, answers the handler as the viewer does. */
function parentPage(page: string, silent: boolean) {
  return `<!doctype html><body><script>
    window.__navs = []; window.__hello = false;
    addEventListener("message", function (e) {
      var f = document.getElementById("f").contentWindow;
      if (e.source !== f || !e.data) return;
      if (e.data.type === "agent-fs-links:hello") { __hello = true; if (!${silent}) f.postMessage({ type: "agent-fs-links:host", v: 1 }, "*"); }
      if (e.data.type === "agent-fs-links:navigate") __navs.push(e.data.href);
    });
  </script><iframe id="f" sandbox="${SANDBOX}" src="${SHARE}dir/${page}"></iframe></body>`
}

async function installHarness(page: Page) {
  await page.route(`${DOCS}/**`, async route => {
    const url = new URL(route.request().url())
    if (url.pathname === "/viewer") {
      const body = parentPage(url.searchParams.get("page") ?? "a.html", url.searchParams.has("silent"))
      return route.fulfill({ body, contentType: "text/html" })
    }
    const name = url.pathname.slice(`${SHARE}dir/`.length)
    const html = name === "a.html" ? linksPage : name in BASE_TARGETS ? basePage(BASE_TARGETS[name]) : null
    if (!html) return route.fulfill({ status: 404, body: "Not found" })
    const body = injectHtmlLinkHandler(enc(html), "/site/TOKEN/")
    await route.fulfill({ body: Buffer.concat([Buffer.from(body), Buffer.from(recorder)]), contentType: "text/html" })
  })
}

const frameOf = (page: Page) => page.frames().find((f) => f.url().includes(SHARE))!

/** Dispatch a click on each element in the frame, the way a user's left click arrives unless overridden. */
async function clickAll(page: Page, ids: string[], init: MouseEventInit = {}) {
  await frameOf(page).evaluate(({ ids, init }) => {
    for (const id of ids) document.getElementById(id)!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }))
  }, { ids, init })
}

const navs = (page: Page) => page.evaluate(() => (window as unknown as { __navs: string[] }).__navs)

const clicks = (page: Page) => frameOf(page).evaluate(() => (window as unknown as { __clicks: Record<string, boolean> }).__clicks)

/** Waits until the parent has answered the handler. */
async function waitForHost(page: Page) {
  await expect.poll(() => frameOf(page)?.evaluate(() => (window as unknown as { __hosted?: boolean }).__hosted === true) ?? false).toBe(true)
}

test("the page hands over plain clicks on links that leave its shared folder, and only those", async ({ page }) => {
  await installHarness(page)
  await page.goto(`${DOCS}/viewer`)
  await waitForHost(page)

  const all = ["same", "sub", "up-in", "hash", "query", "abs-in", "up-out", "docs", "ext", "nested-span", "self", "empty", "blank", "top", "named", "download", "mailto", "js", "handled", "area"]
  await clickAll(page, all)
  await expect.poll(() => navs(page)).toEqual([
    `${DOCS}/fs/site/x.html`,
    `${DOCS}/file/acme/context/plan.md`,
    "https://linear.example/issue/ENG-1",
    `${DOCS}/page/acme/work/slides.html`,
    "https://external.example/area",
  ])
  // Cancelled by the handler exactly when handed over; `handled` by the page itself.
  const cancelled = await clicks(page)
  expect(Object.keys(cancelled).filter((id) => cancelled[id])).toEqual(["up-out", "docs", "ext", "nested", "handled", "area"])

  // Modifier keys and other buttons are left to the browser.
  for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    await clickAll(page, ["docs", "ext"], init)
  }
  await page.waitForTimeout(300)
  expect(await navs(page)).toHaveLength(5)
})

for (const [name, target] of Object.entries(BASE_TARGETS)) {
  test(`links follow the page's <base target="${target}">`, async ({ page }) => {
    await installHarness(page)
    await page.goto(`${DOCS}/viewer?page=${name}`)
    await waitForHost(page)
    await clickAll(page, ["docs", "ext"])
    await page.waitForTimeout(300)
    expect(await navs(page)).toEqual([])
    expect(await clicks(page)).toEqual({ docs: false, ext: false })
  })
}

test("a parent that never answers keeps the page's links as they were", async ({ page }) => {
  await installHarness(page)
  await page.goto(`${DOCS}/viewer?silent`)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __hello: boolean }).__hello)).toBe(true)
  await page.waitForTimeout(300)
  await clickAll(page, ["docs", "ext"])
  await page.waitForTimeout(300)
  expect(await navs(page)).toEqual([])
  expect(await clicks(page)).toEqual({ docs: false, ext: false })
})

// ---------------------------------------------------------------------------
// The viewer: the app opens what the page hands over.
// ---------------------------------------------------------------------------

function viewerPage(app: string) {
  return `<!doctype html><title>QA page</title>
<h1 id="hello">Hello from the page</h1>
<a id="docs" href="${app}/file/QA/QA2/notes/other.html">another drive</a>
<a id="ext" href="https://external.test/issue/1">external</a>
<a id="same" href="notes.html">same folder</a>`
}
const notesPage = (app: string) => `<!doctype html><p id="notes">Notes</p><a id="docs" href="${app}/file/QA/QA2/notes/other.html">another drive</a>`

// The real server's `/site` serves the pages. The browser reaches it as
// `fixture.test`, which it maps to 127.0.0.1 and does not count as a secure
// host, so as with a remote plain-HTTP API it sends no `Sec-Fetch-Dest`.
const READY = "SITE_SERVER "

type Site = { endpoint: string; sharePaths: Record<string, string>; stop: () => void }

/** Starts `support/site-server.ts` with these files, sharing each of `folders`. */
async function startSite(files: Record<string, string>, folders: string[]): Promise<Site> {
  const child = spawn("bun", [fileURLToPath(new URL("./support/site-server.ts", import.meta.url))], { stdio: ["pipe", "pipe", "inherit"] })
  child.stdin.end(JSON.stringify({ files, folders }))
  // Keeps reading after the ready line, so the server's request log never fills the pipe.
  const lines = createInterface({ input: child.stdout })
  const ready = await new Promise<string>((resolve, reject) => {
    lines.on("line", (line) => { if (line.startsWith(READY)) resolve(line.slice(READY.length)) })
    child.once("exit", (code) => reject(new Error(`site server exited with ${code}`)))
  })
  const { port, sharePaths } = JSON.parse(ready)
  return { endpoint: `http://${SITE_HOST}:${port}`, sharePaths, stop: () => child.kill() }
}

// Production app shell against deterministic API fixtures; no live account.
async function installApp(page: Page, app: string, site: Site) {
  await page.addInitScript((endpoint) => {
    localStorage.setItem("agent-fs-credentials", JSON.stringify([
      { id: "qa", name: "QA", endpoint, apiKey: "fixture" },
    ]))
    localStorage.setItem("agent-fs-active-credential", "qa")
  }, site.endpoint)
  await page.context().route("https://external.test/**", route =>
    route.fulfill({ body: "<p id=ext>External site</p>", contentType: "text/html", headers: { "X-Frame-Options": "DENY" } }))
  await page.route(`${site.endpoint}/**`, async route => {
    const url = new URL(route.request().url())
    let json: unknown
    if (url.pathname === "/auth/me") json = { userId: "qa", email: "qa@example.test", defaultOrgId: "org", defaultDriveId: "drive" }
    else if (url.pathname === "/orgs") json = { orgs: [{ id: "org", name: "QA" }] }
    else if (url.pathname.endsWith("/drives")) json = { drives: [{ id: "drive", name: "QA", orgId: "org" }, { id: "drive2", name: "QA2", orgId: "org" }] }
    else if (url.pathname === "/content") return route.fulfill({ body: viewerPage(app), contentType: "text/plain" })
    else if (url.pathname.startsWith("/site/")) return route.continue()
    else if (url.pathname.endsWith("/ops")) {
      const { op, path } = route.request().postDataJSON()
      switch (op) {
        case "stat": json = { path, size: 100, contentType: "text/html", author: "qa", currentVersion: 1, createdAt: "2026-01-01", modifiedAt: "2026-01-01", isDeleted: false }; break
        case "signed-url": json = { url: `${site.endpoint}/content?path=${path}` }; break
        case "share-create": json = { id: "tok", kind: "site", url: site.sharePaths[path], sharePath: site.sharePaths[path], path, expiresIn: 900, expiresAt: new Date(Date.now() + 900_000).toISOString(), maxViews: null }; break
        case "comment-list": json = { comments: [] }; break
        case "comment-notification-list": json = { notifications: [], unreadCount: 0 }; break
        case "ls": json = { entries: [] }; break
        case "tree": json = { tree: [] }; break
        default: return route.abort()
      }
    } else if (url.pathname === "/health") json = { ok: true, version: "test", features: ["share-links", "html-sites"] }
    else return route.abort()
    await route.fulfill({ json })
  })
}

const FRAME = 'iframe[title="reports/page.html"]'

test.describe("the viewer", () => {
  let site: Site

  test.beforeAll(async ({}, testInfo) => {
    const app = testInfo.project.use.baseURL!
    site = await startSite(
      { "/reports/page.html": viewerPage(app), "/reports/notes.html": notesPage(app), "/notes/other.html": viewerPage(app) },
      ["/reports", "/notes"],
    )
  })
  test.afterAll(() => site?.stop())

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 844 })
  })

  for (const view of ["file", "page"]) {
    test(`a docs link in the page opens in the app, from the ${view} view`, async ({ page, baseURL }) => {
      await installApp(page, baseURL!, site)
      await page.goto(`/${view}/~/org/drive/reports/page.html`)
      await expect(page.frameLocator(FRAME).locator("#hello")).toHaveText("Hello from the page")
      const popups: string[] = []
      page.context().on("page", (p) => popups.push(p.url()))

      await page.frameLocator(FRAME).locator("#docs").click()
      await expect(page).toHaveURL(`${baseURL}/file/QA/QA2/notes/other.html`)
      await expect(page.frameLocator('iframe[title="notes/other.html"]').locator("#hello")).toHaveText("Hello from the page")
      expect(popups).toEqual([])
    })
  }

  test("an external link opens in a new tab without an opener; the viewer stays", async ({ page, baseURL }) => {
    await installApp(page, baseURL!, site)
    await page.goto("/file/~/org/drive/reports/page.html")
    await expect(page.frameLocator(FRAME).locator("#hello")).toHaveText("Hello from the page")

    const popup = page.context().waitForEvent("page")
    await page.frameLocator(FRAME).locator("#ext").click()
    const tab = await popup
    await expect(tab.locator("#ext")).toHaveText("External site")
    expect(tab.url()).toBe("https://external.test/issue/1")
    expect(await tab.evaluate(() => window.opener)).toBeNull()
    await expect(page).toHaveURL(`${baseURL}/file/QA/QA/reports/page.html`)
    await expect(page.frameLocator(FRAME).locator("#hello")).toHaveText("Hello from the page")
  })

  test("a same-folder link stays in the frame, and that page's docs links still open in the app", async ({ page, baseURL }) => {
    await installApp(page, baseURL!, site)
    await page.goto("/file/~/org/drive/reports/page.html")
    await page.frameLocator(FRAME).locator("#same").click()
    await expect(page.frameLocator(FRAME).locator("#notes")).toHaveText("Notes")
    await expect(page).toHaveURL(`${baseURL}/file/QA/QA/reports/page.html`)

    await page.frameLocator(FRAME).locator("#docs").click()
    await expect(page).toHaveURL(`${baseURL}/file/QA/QA2/notes/other.html`)
  })

  test("a navigate message from anything but the frame is ignored", async ({ page, baseURL }) => {
    await installApp(page, baseURL!, site)
    await page.goto("/file/~/org/drive/reports/page.html")
    await expect(page.frameLocator(FRAME).locator("#hello")).toHaveText("Hello from the page")
    await page.evaluate((app) => {
      window.postMessage({ type: "agent-fs-links:navigate", v: 1, href: `${app}/file/QA/QA2/notes/other.html` }, "*")
    }, baseURL)
    await page.waitForTimeout(300)
    await expect(page).toHaveURL(`${baseURL}/file/QA/QA/reports/page.html`)
  })
})
