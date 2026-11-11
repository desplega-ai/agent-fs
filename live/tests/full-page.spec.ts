import { expect, test, type Page } from "@playwright/test"

const html = "<!doctype html><title>QA page</title><h1 id=\"hello\">Hello from the page</h1>"
const NOTES = "# Notes\n"
// Every character a URL could take for something else.
const ODD_NAME = "a#b?c%20d.html"
// Enough files for the star nudge, so its absence on the presented page means something.
const rootEntries = ["a.md", "b.md", "c.md", "notes.md", "qa.html", ODD_NAME].map(name => ({ name, type: "file", size: 5 }))

/**
 * Production app shell against deterministic API fixtures; no live account.
 * `features: null` is a legacy /health without the field. Returns the paths of share-create requests.
 */
async function installFixture(page: Page, { features = ["share-links", "html-sites"] as string[] | null, site = html, signedIn = true } = {}) {
  const shared: string[] = []
  if (signedIn) {
    await page.context().addInitScript(() => {
      localStorage.setItem("agent-fs-credentials", JSON.stringify([
        { id: "qa", name: "QA", endpoint: "http://fixture.test", apiKey: "fixture" },
      ]))
      localStorage.setItem("agent-fs-active-credential", "qa")
    })
  }
  // On the context, so a tab the app opens gets the same fixture.
  await page.context().route("http://fixture.test/**", async route => {
    const url = new URL(route.request().url())
    let json: unknown
    if (url.pathname === "/auth/me") json = { userId: "qa", email: "qa@example.test", defaultOrgId: "org", defaultDriveId: "drive" }
    else if (url.pathname === "/orgs") json = { orgs: [{ id: "org", name: "QA" }] }
    else if (url.pathname.endsWith("/drives")) json = { drives: [{ id: "drive", name: "QA", orgId: "org" }] }
    else if (url.pathname === "/content") {
      const isHtml = url.searchParams.get("path")?.endsWith(".html")
      return route.fulfill({ body: isHtml ? html : NOTES, contentType: "text/plain" })
    }
    else if (url.pathname.startsWith("/site/")) return route.fulfill({ body: site, contentType: "text/html" })
    else if (url.pathname.endsWith("/ops")) {
      const { op, path } = route.request().postDataJSON()
      switch (op) {
        case "stat": json = { path, size: 5, contentType: path.endsWith(".html") ? "text/html" : "text/markdown", author: "qa", currentVersion: 1, createdAt: "2026-01-01", modifiedAt: "2026-01-01", isDeleted: false }; break
        case "signed-url": json = { url: `http://fixture.test/content?path=${encodeURIComponent(path)}` }; break
        case "share-create": shared.push(path); json = { id: "tok", kind: "site", url: "/site/tok/", sharePath: "/site/tok/", path, expiresIn: 900, expiresAt: new Date(Date.now() + 900_000).toISOString(), maxViews: null }; break
        case "comment-list": json = { comments: [] }; break
        case "comment-notification-list": json = { notifications: [], unreadCount: 0 }; break
        case "ls": json = { entries: path === "/" || !path ? rootEntries : [] }; break
        case "tree": json = { tree: [] }; break
        default: return route.abort()
      }
    } else if (url.pathname === "/health") json = features ? { ok: true, version: "test", features } : { ok: true, version: "test" }
    // Side panels (members, recent, ...) degrade gracefully; these tests only need the page.
    else return route.abort()
    await route.fulfill({ json })
  })
  return shared
}

/** Presents qa.html and accepts the drive-root confirm. */
async function present(page: Page) {
  await page.goto("/page/~/org/drive/qa.html")
  await page.getByRole("button", { name: "Render", exact: true }).click()
  const frame = page.locator('iframe[title="qa.html"]')
  await expect(page.frameLocator('iframe[title="qa.html"]').locator("#hello")).toHaveText("Hello from the page")
  return frame
}

for (const [width, height] of [[1280, 844], [390, 844]] as const) {
  test(`the presented page shows only the HTML file at ${width}x${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height })
    await installFixture(page)
    const frame = await present(page)

    expect(await frame.boundingBox()).toEqual({ x: 0, y: 0, width, height })
    await expect(page.locator("header")).toHaveCount(0)
    await expect(page.locator("aside")).toHaveCount(0)
    await expect(page.getByRole("tablist", { name: "File navigation" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: /comments/i })).toHaveCount(0)
    await page.waitForLoadState("networkidle")
    await expect(page.getByText("Enjoying agent-fs?")).toHaveCount(0)
    await expect(page).toHaveTitle("qa.html — agent-fs")
    await page.screenshot({ path: testInfo.outputPath(`present-${width}.png`) })
  })
}

test("Back to file opens the file view", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await installFixture(page)
  await present(page)
  await page.getByRole("link", { name: "Back to file" }).click()
  await expect(page).toHaveURL("/file/~/org/drive/qa.html")
  await expect(page.locator("header")).toBeVisible()
  // The same drive nudges outside the presented page.
  await expect(page.getByText("Enjoying agent-fs?")).toBeVisible()
})

test("the drive-root confirm offers Render and the way back, not the source", async ({ page }) => {
  const shared = await installFixture(page)
  await page.goto("/page/~/org/drive/qa.html")
  await expect(page.getByRole("button", { name: "Render", exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "Back to file" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Show source" })).toHaveCount(0)
  expect(shared).toEqual([])
})

test("a file name with #, ? and % survives both links", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await installFixture(page)
  await page.goto(`/detail/~/org/drive/${encodeURIComponent(ODD_NAME)}`)
  await page.getByRole("button", { name: "Present" }).click()
  await expect(page).toHaveURL(`/page/~/org/drive/${encodeURIComponent(ODD_NAME)}`)
  await page.getByRole("button", { name: "Render", exact: true }).click()
  await expect(page.locator("iframe")).toHaveAttribute("title", ODD_NAME)

  await page.getByRole("link", { name: "Back to file" }).click()
  await expect(page).toHaveURL(`/file/~/org/drive/${encodeURIComponent(ODD_NAME)}`)
  await expect(page.locator(`iframe[title="${ODD_NAME}"]`)).toBeVisible()
})

test("a presented page cannot reach the app or navigate it", async ({ page }) => {
  const site = `<!doctype html><p id="doc"></p><p id="storage"></p><p id="top"></p><script>
    const out = (id, f) => { try { f(); document.getElementById(id).textContent = "allowed" } catch { document.getElementById(id).textContent = "blocked" } }
    out("doc", () => parent.document.title)
    out("storage", () => parent.localStorage.length)
    out("top", () => { top.location = "about:blank" })
  </script>`
  await installFixture(page, { site })
  await page.goto("/page/~/org/drive/qa.html")
  await page.getByRole("button", { name: "Render", exact: true }).click()
  const frame = page.frameLocator('iframe[title="qa.html"]')
  await expect(frame.locator("#doc")).toHaveText("blocked")
  await expect(frame.locator("#storage")).toHaveText("blocked")
  await expect(frame.locator("#top")).toHaveText("blocked")
  await expect(page).toHaveURL("/page/~/org/drive/qa.html")
  const sandbox = await page.locator("iframe").getAttribute("sandbox")

  // The same sandbox as the file view's frame.
  await page.goto("/file/~/org/drive/qa.html")
  await expect(page.locator('iframe[title="qa.html"]')).toHaveAttribute("sandbox", sandbox!)
  expect(sandbox).not.toContain("allow-same-origin")
  expect(sandbox).not.toContain("allow-top-navigation")
})

test("signed out, the route goes to the credentials page and shares nothing", async ({ page }) => {
  const shared = await installFixture(page, { signedIn: false })
  await page.goto("/page/~/org/drive/qa.html")
  await expect(page).toHaveURL(/\/credentials/)
  expect(shared).toEqual([])
})

test("a file that is not HTML shows a message and the way back", async ({ page }) => {
  await installFixture(page)
  await page.goto("/page/~/org/drive/notes.md")
  await expect(page.getByText("Only HTML pages can be presented.")).toBeVisible()
  await expect(page.locator("iframe")).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Back to file" })).toHaveAttribute("href", "/file/~/org/drive/notes.md")
})

test("a server without html-sites does not render the page", async ({ page }) => {
  const shared = await installFixture(page, { features: ["share-links"] })
  await page.goto("/page/~/org/drive/qa.html")
  await expect(page.getByText("Only HTML pages can be presented.")).toBeVisible()
  await expect(page.locator("iframe")).toHaveCount(0)
  expect(shared).toEqual([])
})

// A nested file: one at the drive root asks before rendering.
const isFullscreen = (page: Page) => page.evaluate(() => document.fullscreenElement != null)

for (const [view, route] of [["file", "/file/~/org/drive/reports/page.html"], ["detail", "/detail/~/org/drive/reports/page.html"]] as const) {
  test(`Present in the ${view} view takes the browser full screen on the presented page`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 844 })
    await installFixture(page)
    await page.goto(route)
    await expect(page.locator('iframe[title="reports/page.html"]')).toBeVisible()
    expect(await isFullscreen(page)).toBe(false)
    if (view === "file") await page.screenshot({ path: testInfo.outputPath("viewer-header.png") })

    await page.getByRole("button", { name: "Present" }).click()
    await expect(page).toHaveURL("/page/~/org/drive/reports/page.html")
    expect(await isFullscreen(page)).toBe(true)
    await expect(page.locator("header")).toHaveCount(0)

    // Leaving the page gives the screen back.
    await page.getByRole("link", { name: "Back to file" }).click()
    await expect(page).toHaveURL("/file/~/org/drive/reports/page.html")
    await expect.poll(() => isFullscreen(page)).toBe(false)
  })
}

test("P presents the file from the file view", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await installFixture(page)
  await page.goto("/file/~/org/drive/reports/page.html")
  await expect(page.locator('iframe[title="reports/page.html"]')).toBeVisible()
  await page.keyboard.press("p")
  await expect(page).toHaveURL("/page/~/org/drive/reports/page.html")
  expect(await isFullscreen(page)).toBe(true)
})

test("Present sits next to Open full page for an HTML file only", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await installFixture(page)
  await page.goto("/file/~/org/drive/reports/page.html")
  await expect(page.locator('iframe[title="reports/page.html"]')).toBeVisible()
  const header = page.locator("[data-viewer-header]")
  const labels = await header.getByRole("button").evaluateAll(els => els.map(el => el.getAttribute("aria-label")))
  expect(labels.indexOf("Present")).toBe(labels.indexOf("Open full page") - 1)

  await page.goto("/file/~/org/drive/notes.md")
  await expect(header.getByRole("button", { name: "Open full page" })).toBeVisible()
  await expect(header.getByRole("button", { name: "Present" })).toHaveCount(0)
  await page.keyboard.press("p")
  await expect(page).toHaveURL("/file/~/org/drive/notes.md")
})

test("the detail toolbar offers Present for an HTML file only", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await installFixture(page)
  await page.goto("/detail/~/org/drive/qa.html")
  await expect(page.getByRole("button", { name: "Present" })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("detail-toolbar.png") })

  await page.goto("/detail/~/org/drive/notes.md")
  // Share needs /health too, so the toolbar has seen the server's features.
  await expect(page.getByRole("button", { name: "Share", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Present" })).toHaveCount(0)
})

for (const [label, features] of [["without html-sites", ["share-links"]], ["with a legacy /health", null]] as const) {
  test(`the detail toolbar offers no Present on a server ${label}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 844 })
    const shared = await installFixture(page, { features: features ? [...features] : null })
    await page.goto("/detail/~/org/drive/reports/page.html")
    // The connection badge reads /health, so the toolbar has seen the server's features.
    await expect(page.getByRole("button", { name: /Connected/ })).toBeVisible()
    await expect(page.locator(".monaco-editor:visible .view-lines")).toContainText("Hello from the page")
    await expect(page.getByRole("button", { name: "Present" })).toHaveCount(0)
    expect(shared).toEqual([])
  })
}
