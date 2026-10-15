import { expect, test, type Page } from "@playwright/test"

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#4f46e5"/></svg>'
const markdown = [
  "# Lightbox",
  "```mermaid\ngraph TD\n  A[Start] --> B[Finish]\n```",
  "![chart](http://fixture.test/chart.svg)",
].join("\n\n")

// Production app shell against deterministic API fixtures; no live account.
async function installFixture(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("agent-fs-credentials", JSON.stringify([
      { id: "qa", name: "QA", endpoint: "http://fixture.test", apiKey: "fixture" },
    ]))
    localStorage.setItem("agent-fs-active-credential", "qa")
  })
  await page.route("http://fixture.test/**", async route => {
    const url = new URL(route.request().url())
    let json: unknown
    if (url.pathname === "/auth/me") json = { userId: "qa", email: "qa@example.test", defaultOrgId: "org", defaultDriveId: "drive" }
    else if (url.pathname === "/orgs") json = { orgs: [{ id: "org", name: "QA" }] }
    else if (url.pathname.endsWith("/drives")) json = { drives: [{ id: "drive", name: "QA", orgId: "org" }] }
    else if (url.pathname === "/content") return route.fulfill({ body: markdown, contentType: "text/plain" })
    else if (url.pathname === "/chart.svg") return route.fulfill({ body: svg, contentType: "image/svg+xml" })
    else if (url.pathname.endsWith("/ops")) {
      const { op, path } = route.request().postDataJSON()
      switch (op) {
        case "stat": json = { path, size: markdown.length, contentType: "text/markdown", author: "qa", currentVersion: 1, createdAt: "2026-01-01", modifiedAt: "2026-01-01", isDeleted: false }; break
        case "signed-url": json = { url: `http://fixture.test/content?path=${path}` }; break
        case "comment-list": json = { comments: [] }; break
        case "comment-notification-list": json = { notifications: [], unreadCount: 0 }; break
        case "ls": json = { entries: [] }; break
        case "tree": json = { tree: [] }; break
        // Side panels degrade gracefully; these tests only need the viewer.
        default: return route.abort()
      }
    } else if (url.pathname === "/health") json = { status: "ok" }
    else throw new Error(`Unexpected request: ${url}`)
    await route.fulfill({ json })
  })
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await installFixture(page)
  await page.goto("/file/~/org/drive/lightbox.md")
})

test("an enlarged mermaid diagram renders again after close and reopen", async ({ page }) => {
  const expand = page.getByRole("button", { name: "Expand diagram" })
  await expect(expand).toBeEnabled()
  const dialog = page.getByRole("dialog")

  for (let i = 1; i <= 3; i++) {
    await test.step(`open ${i}`, async () => {
      await page.locator(".group").filter({ has: expand }).hover()
      await expand.click()
      await expect(dialog.locator("svg").filter({ hasText: "Start" })).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(dialog).toHaveCount(0)
    })
  }
})

test("an enlarged svg image renders again after close and reopen", async ({ page }) => {
  const inline = page.locator('img[alt="chart"]')
  await expect(inline).toBeVisible()
  const dialog = page.getByRole("dialog")

  for (let i = 1; i <= 3; i++) {
    await test.step(`open ${i}`, async () => {
      await inline.first().click()
      const enlarged = dialog.locator('img[alt="chart"]')
      await expect(enlarged).toBeVisible()
      await expect.poll(() => enlarged.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
      await dialog.getByRole("button", { name: "Close" }).click()
      await expect(dialog).toHaveCount(0)
    })
  }
})
