import { expect, test, type Page } from "@playwright/test"
import { injectHtmlCommentOverlay } from "../../packages/server/src/share/html-comment-overlay"

const html = "<!doctype html><title>QA page</title><h1 id=\"hello\">Hello from the page</h1>"
// A paragraph after the one a test selects: a triple-click runs to the start of the next block.
const NOTES = "# Notes\n\nA line worth a comment.\n\nClosing words.\n"
// Every character a URL could take for something else.
const ODD_NAME = "a#b?c%20d.html"
// Enough files for the star nudge, so its absence on the presented page means something.
const rootEntries = ["a.md", "b.md", "c.md", "notes.md", "data.csv", "qa.html", ODD_NAME].map(name => ({ name, type: "file", size: 5 }))

type Json = Record<string, unknown>
function comment(path: string, c: Json): Json {
  return { path, resolved: false, replyCount: 0, createdAt: "2026-10-27T12:00:00.000Z", updatedAt: "2026-10-27T12:00:00.000Z", replies: [], ...c }
}

/**
 * Production app shell against deterministic API fixtures; no live account.
 * `features: null` is a legacy /health without the field. Returns the paths of
 * share-create requests, the comments the server lists and the comment-add bodies.
 * With `html-comments` in `features`, `/site/` serves the page through the
 * server's real overlay when the viewer asks for it.
 */
async function installFixture(page: Page, { features = ["share-links", "html-sites"] as string[] | null, site = html, signedIn = true, comments = [] as Json[], source = true } = {}) {
  const shared: string[] = []
  const adds: Json[] = []
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
      // `source: false` is a file whose bytes cannot be downloaded.
      if (!source) return route.abort()
      const isHtml = url.searchParams.get("path")?.endsWith(".html")
      return route.fulfill({ body: isHtml ? html : NOTES, contentType: "text/plain" })
    }
    else if (url.pathname.startsWith("/site/")) {
      const overlay = url.searchParams.get("__afs_comments") === "1" && features?.includes("html-comments")
      return route.fulfill({ body: overlay ? Buffer.from(injectHtmlCommentOverlay(new TextEncoder().encode(site))) : site, contentType: "text/html" })
    }
    else if (url.pathname.endsWith("/ops")) {
      const { op, path } = route.request().postDataJSON()
      switch (op) {
        case "stat": json = { path, size: 5, contentType: path.endsWith(".html") ? "text/html" : "text/markdown", author: "qa", currentVersion: 1, createdAt: "2026-01-01", modifiedAt: "2026-01-01", isDeleted: false }; break
        case "signed-url": json = { url: `http://fixture.test/content?path=${encodeURIComponent(path)}` }; break
        case "share-create": shared.push(path); json = { id: "tok", kind: "site", url: "/site/tok/", sharePath: "/site/tok/", path, expiresIn: 900, expiresAt: new Date(Date.now() + 900_000).toISOString(), maxViews: null }; break
        case "comment-list": json = { comments: route.request().postDataJSON().resolved ? [] : comments }; break
        case "comment-add": {
          const body = route.request().postDataJSON()
          adds.push(body)
          json = comment(path, { id: `c-new-${adds.length}`, body: body.body, author: "qa", lineStart: body.lineStart, lineEnd: body.lineEnd, quote: body.quote, quotedContent: body.quotedContent, fileVersion: 1 })
          comments.push(json as Json)
          break
        }
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
  return { shared, comments, adds }
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
  test(`the presented page shows only the HTML file at ${width}x${height}, with comments a button away`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height })
    await installFixture(page)
    const frame = await present(page)

    expect(await frame.boundingBox()).toEqual({ x: 0, y: 0, width, height })
    await expect(page.locator("header")).toHaveCount(0)
    await expect(page.locator("aside")).toHaveCount(0)
    await expect(page.getByRole("tablist", { name: "File navigation" })).toHaveCount(0)
    await page.waitForLoadState("networkidle")
    await expect(page.getByText("Enjoying agent-fs?")).toHaveCount(0)
    await expect(page).toHaveTitle("qa.html — agent-fs")
    await page.screenshot({ path: testInfo.outputPath(`present-${width}.png`) })

    // The floating button opens the comments: the rail on desktop, the sheet on a phone.
    await page.getByRole("button", { name: "Toggle comments" }).click()
    if (width >= 1024) {
      const rail = page.locator("aside")
      await expect(rail.getByRole("button", { name: "Add comment" })).toBeVisible()
      const railBox = (await rail.boundingBox())!
      expect(railBox.x + railBox.width).toBe(width)
      await expect.poll(async () => (await frame.boundingBox())!.width).toBeLessThan(width - railBox.width)
      // Its own preference: the detail page's rail is untouched.
      expect(await page.evaluate(() => localStorage.getItem("liveui:comments"))).toBeNull()
    } else {
      await expect(page.getByRole("dialog").getByText("No comments yet")).toBeVisible()
    }
  })
}

test("n opens the comments rail with the add-comment form", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await installFixture(page)
  await present(page)
  await expect(page.locator("aside")).toHaveCount(0)
  await page.keyboard.press("n")
  await expect(page.locator("aside").getByPlaceholder("Comment on this file...")).toBeFocused()
})

test("an HTML page renders even when its source cannot be downloaded", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await installFixture(page, { features: ["share-links", "html-sites", "html-comments"], source: false })
  const frame = await present(page)
  expect(await frame.boundingBox()).toEqual({ x: 0, y: 0, width: 1280, height: 844 })
  await expect(page.getByText("Failed to load the file.")).toHaveCount(0)
})

test("] opens the comments rail of the presented page and closes it again", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await installFixture(page)
  const frame = await present(page)
  await page.keyboard.press("]")
  await expect(page.locator("aside")).toBeVisible()
  await page.keyboard.press("]")
  await expect(page.locator("aside")).toHaveCount(0)
  expect(await frame.boundingBox()).toEqual({ x: 0, y: 0, width: 1280, height: 844 })
})

test("a presented Markdown file renders and takes a comment on a selection", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  const { adds } = await installFixture(page)
  await page.goto("/page/~/org/drive/notes.md")
  await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible()
  await expect(page.locator("header")).toHaveCount(0)
  await expect(page.locator("iframe")).toHaveCount(0)
  await expect(page.locator("aside")).toHaveCount(0)
  await expect(page).toHaveTitle("notes.md — agent-fs")
  await page.screenshot({ path: testInfo.outputPath("present-markdown.png") })

  await page.getByText("A line worth a comment.").click({ clickCount: 3 })
  await page.getByRole("button", { name: "Comment", exact: true }).click()
  await page.getByPlaceholder("Add a comment...").fill("Say more")
  await page.getByRole("button", { name: "Send comment" }).click()
  await expect.poll(() => adds.length).toBe(1)
  expect(adds[0]).toMatchObject({ op: "comment-add", path: "notes.md", body: "Say more", lineStart: 3, quote: { exact: "A line worth a comment." } })
  await page.keyboard.press("]")
  await expect(page.locator("aside").getByText("Say more")).toBeVisible()
  await expect(page.locator("aside").getByRole("button", { name: /Outline/ })).toBeVisible()
  await page.getByRole("link", { name: "Back to file" }).click()
  await expect(page).toHaveURL("/file/~/org/drive/notes.md")
})

test("a presented HTML page gets the comment overlay and lists its comments", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  const existing = comment("qa.html", { id: "c-1", body: "Bigger title please", author: "another-user", authorDisplayName: "Ada", quote: { exact: "Hello from the page", prefix: "", suffix: "" }, quotedContent: "Hello from the page", fileVersion: 1 })
  await installFixture(page, { features: ["share-links", "html-sites", "html-comments"], comments: [existing] })
  const frame = await present(page)
  await expect(frame).toHaveAttribute("src", "http://fixture.test/site/tok/qa.html?__afs_comments=1")
  await expect(page.getByRole("button", { name: "Toggle comments" })).toContainText("1")
  await page.getByRole("button", { name: "Toggle comments" }).click()
  await expect(page.locator("aside").getByText("Bigger title please")).toBeVisible()
  // The overlay painted the anchored quote inside the frame.
  await expect.poll(() => page.frames().find(f => f.url().includes("/site/tok/"))?.evaluate(() => CSS.highlights.get("afs-comment")?.size ?? 0)).toBe(1)
})

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
  const { shared } = await installFixture(page)
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
  const { shared } = await installFixture(page, { signedIn: false })
  await page.goto("/page/~/org/drive/qa.html")
  await expect(page).toHaveURL(/\/credentials/)
  expect(shared).toEqual([])
})

test("a file that is neither HTML nor Markdown shows a message and the way back", async ({ page }) => {
  await installFixture(page)
  await page.goto("/page/~/org/drive/data.csv")
  await expect(page.getByText("Only HTML and Markdown files can be presented.")).toBeVisible()
  await expect(page.locator("iframe")).toHaveCount(0)
  await expect(page.locator("aside")).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Back to file" })).toHaveAttribute("href", "/file/~/org/drive/data.csv")
})

test("a server without html-sites does not render the page", async ({ page }) => {
  const { shared } = await installFixture(page, { features: ["share-links"] })
  await page.goto("/page/~/org/drive/qa.html")
  await expect(page.getByText("Only HTML and Markdown files can be presented.")).toBeVisible()
  await expect(page.locator("iframe")).toHaveCount(0)
  expect(shared).toEqual([])
})

// A nested file: one at the drive root asks before rendering.
// Entering full screen settles after the navigation on a slow runner, so wait for it.
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
    await expect.poll(() => isFullscreen(page)).toBe(true)
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
  await expect.poll(() => isFullscreen(page)).toBe(true)
})

test("Present sits next to Open full page for HTML and Markdown, not for other files", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await installFixture(page)
  await page.goto("/file/~/org/drive/reports/page.html")
  await expect(page.locator('iframe[title="reports/page.html"]')).toBeVisible()
  const header = page.locator("[data-viewer-header]")
  const labels = await header.getByRole("button").evaluateAll(els => els.map(el => el.getAttribute("aria-label")))
  expect(labels.indexOf("Present")).toBe(labels.indexOf("Open full page") - 1)

  await page.goto("/file/~/org/drive/notes.md")
  await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible()
  await expect(header.getByRole("button", { name: "Present" })).toBeVisible()
  await page.keyboard.press("p")
  await expect(page).toHaveURL("/page/~/org/drive/notes.md")

  await page.goto("/file/~/org/drive/data.csv")
  await expect(header.getByRole("button", { name: "Open full page" })).toBeVisible()
  await expect(header.getByRole("button", { name: "Present" })).toHaveCount(0)
  await page.keyboard.press("p")
  await expect(page).toHaveURL("/file/~/org/drive/data.csv")
})

test("the detail toolbar offers Present for HTML and Markdown, not for other files", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await installFixture(page)
  await page.goto("/detail/~/org/drive/qa.html")
  await expect(page.getByRole("button", { name: "Present" })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("detail-toolbar.png") })

  await page.goto("/detail/~/org/drive/notes.md")
  await expect(page.getByRole("button", { name: "Present" })).toBeVisible()

  await page.goto("/detail/~/org/drive/data.csv")
  // Share needs /health too, so the toolbar has seen the server's features.
  await expect(page.getByRole("button", { name: "Share", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Present" })).toHaveCount(0)
})

for (const [label, features] of [["without html-sites", ["share-links"]], ["with a legacy /health", null]] as const) {
  test(`the detail toolbar offers no Present on a server ${label}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 844 })
    const { shared } = await installFixture(page, { features: features ? [...features] : null })
    await page.goto("/detail/~/org/drive/reports/page.html")
    // The connection badge reads /health, so the toolbar has seen the server's features.
    await expect(page.getByRole("button", { name: /Connected/ })).toBeVisible()
    await expect(page.locator(".monaco-editor:visible .view-lines")).toContainText("Hello from the page")
    await expect(page.getByRole("button", { name: "Present" })).toHaveCount(0)
    expect(shared).toEqual([])
  })
}
