import { expect, test, type Page } from "@playwright/test"
import { injectHtmlLinkTarget } from "../../packages/server/src/share/html-link-target"

const DOCS_LINK = "http://127.0.0.1:4173/file/~/org/other-drive/notes.md"

const linksPage = [
  "<!doctype html><title>Links</title>",
  `<p><a id="docs" href="${DOCS_LINK}">Another drive</a></p>`,
  "<p><a id=\"external\" href=\"https://example.com/\">External</a></p>",
  "<p><a id=\"sibling\" href=\"other.html\">Same folder</a></p>",
  "<p><a id=\"self\" href=\"https://example.com/self\" target=\"_self\">Explicit target</a></p>",
  "<p><a id=\"moved\" href=\"other.html\" onclick=\"this.href = 'https://example.com/moved'\">Moved by the page</a></p>",
].join("\n")
// The CSP `/site` sends (`SITE_CSP` in the server's `routes/site.ts`).
const SITE_CSP = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals; frame-ancestors *"
const otherPage = "<!doctype html><p id=\"other\">Other page</p>"

// Production app shell against deterministic API fixtures. `/site/` serves
// pages through the server's real link script.
async function installFixture(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("agent-fs-credentials", JSON.stringify([
      { id: "qa", name: "QA", endpoint: "http://fixture.test", apiKey: "fixture" },
    ]))
    localStorage.setItem("agent-fs-active-credential", "qa")
  })
  await page.context().route("https://example.com/**", route => route.fulfill({ body: "<p>example</p>", contentType: "text/html" }))
  await page.route("http://fixture.test/**", async route => {
    const url = new URL(route.request().url())
    let json: unknown
    if (url.pathname === "/auth/me") json = { userId: "qa", email: "qa@example.test", defaultOrgId: "org", defaultDriveId: "drive" }
    else if (url.pathname === "/orgs") json = { orgs: [{ id: "org", name: "QA" }] }
    else if (url.pathname.endsWith("/drives")) json = { drives: [{ id: "drive", name: "QA", orgId: "org" }] }
    else if (url.pathname === "/content") return route.fulfill({ body: linksPage, contentType: "text/plain" })
    else if (url.pathname.startsWith("/site/tok/")) {
      const bytes = new TextEncoder().encode(url.pathname.endsWith("/other.html") ? otherPage : linksPage)
      return route.fulfill({ body: Buffer.from(injectHtmlLinkTarget(bytes, "/site/tok/")), contentType: "text/html", headers: { "Content-Security-Policy": SITE_CSP } })
    } else if (url.pathname.endsWith("/ops")) {
      const { op, path } = route.request().postDataJSON()
      switch (op) {
        case "stat": json = { path, size: linksPage.length, contentType: "text/html", author: "qa", currentVersion: 1, createdAt: "2026-01-01", modifiedAt: "2026-01-01", isDeleted: false }; break
        case "signed-url": json = { url: `http://fixture.test/content?path=${path}` }; break
        case "share-create": json = { id: "tok", kind: "site", url: "/site/tok/", sharePath: "/site/tok/", path, expiresIn: 900, expiresAt: new Date(Date.now() + 900_000).toISOString(), maxViews: null }; break
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
const VIEW = "/file/~/org/drive/reports/page.html"

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await installFixture(page)
})

for (const [id, href] of [["docs", DOCS_LINK], ["external", "https://example.com/"], ["moved", "https://example.com/moved"]]) {
  test(`a link that leaves the shared folder (${id}) opens in a new tab`, async ({ page }) => {
    await page.goto(VIEW)
    const frame = page.frameLocator(FRAME)
    await expect(frame.locator(`#${id}`)).toBeVisible()
    const viewer = page.url()
    const popup = page.waitForEvent("popup")
    await frame.locator(`#${id}`).click()
    expect((await popup).url()).toBe(href)
    // The viewer and its page stay where they were.
    expect(page.url()).toBe(viewer)
    await expect(frame.locator(`#${id}`)).not.toHaveAttribute("target")
  })
}

test("a link inside the shared folder, and one with its own target, stay in the frame", async ({ page }) => {
  let popups = 0
  page.on("popup", () => popups++)
  await page.goto(VIEW)
  const frame = page.frameLocator(FRAME)
  await frame.locator("#sibling").click()
  await expect(frame.locator("#other")).toHaveText("Other page")

  await page.goto(VIEW)
  await page.frameLocator(FRAME).locator("#self").click()
  await expect(page.frameLocator(FRAME).locator("text=example")).toBeVisible()
  expect(popups).toBe(0)
})
