import { expect, test, type Page } from "@playwright/test"

const versions = [
  { version: 2, author: "qa", createdAt: "2026-10-02T10:00:00.000Z", operation: "edit", message: "Tighten intro" },
  { version: 1, author: "qa", createdAt: "2026-10-01T10:00:00.000Z", operation: "write" },
]

/** Production app shell against deterministic API fixtures; no live account. */
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
    else if (url.pathname === "/health") json = { ok: true, version: "test", features: [] }
    else if (url.pathname === "/content") return route.fulfill({ body: "# Notes\n\nSome text.\n", contentType: "text/markdown" })
    else if (url.pathname.endsWith("/ops")) {
      const { op } = route.request().postDataJSON()
      switch (op) {
        case "ls": json = { entries: [{ name: "notes.md", type: "file", size: 8, modifiedAt: "2026-10-02T10:00:00.000Z" }] }; break
        case "stat": json = { path: "/notes.md", size: 8, contentType: "text/markdown", author: "qa", currentVersion: 2, createdAt: "2026-10-01", modifiedAt: "2026-10-02", isDeleted: false }; break
        case "signed-url": json = { url: "http://fixture.test/content?path=/notes.md" }; break
        case "log": json = { versions }; break
        case "comment-list": json = { comments: [] }; break
        case "comment-notification-list": json = { notifications: [], unreadCount: 0 }; break
        default: return route.abort()
      }
    } else return route.abort()
    await route.fulfill({ json })
  })
}

const historyPanel = (page: Page) => page.getByRole("button", { name: /^Version History/ })

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await installFixture(page)
})

test("full width and open full page use different icons", async ({ page }) => {
  await page.goto("/file/~/org/drive/notes.md")
  const fullWidth = page.getByRole("button", { name: "Full width" })
  const fullPage = page.getByRole("button", { name: "Open full page" })
  await expect(fullWidth.locator("svg")).toHaveClass(/lucide-unfold-horizontal/)
  await expect(fullPage.locator("svg")).toHaveClass(/lucide-square-arrow-out-up-right/)

  await fullWidth.click()
  await expect(page.getByRole("button", { name: "Reading width" }).locator("svg")).toHaveClass(/lucide-fold-horizontal/)
})

test("the file view's Version history button opens the full page with history expanded", async ({ page }) => {
  await page.goto("/file/~/org/drive/notes.md")
  await page.getByRole("button", { name: "Version history" }).click()
  await expect(page).toHaveURL(/\/detail\/~\/org\/drive\/notes\.md$/)
  await expect(historyPanel(page)).toHaveAttribute("aria-expanded", "true")
  await expect(page.getByText("Tighten intro")).toBeVisible()
})

test("H on the file view opens the full page with history expanded", async ({ page }) => {
  await page.goto("/file/~/org/drive/notes.md")
  await expect(page.getByRole("button", { name: "Version history" })).toBeVisible()
  await page.keyboard.press("h")
  await expect(page).toHaveURL(/\/detail\/~\/org\/drive\/notes\.md$/)
  await expect(historyPanel(page)).toHaveAttribute("aria-expanded", "true")
})

test("F still opens the full page with history collapsed; the toolbar button and H toggle it", async ({ page }) => {
  await page.goto("/file/~/org/drive/notes.md")
  await expect(page.getByRole("button", { name: "Open full page" })).toBeVisible()
  await page.keyboard.press("f")
  await expect(page).toHaveURL(/\/detail\/~\/org\/drive\/notes\.md$/)
  await expect(historyPanel(page)).toHaveAttribute("aria-expanded", "false")

  const toggle = page.getByRole("button", { name: "Version history", exact: true })
  await toggle.click()
  await expect(historyPanel(page)).toHaveAttribute("aria-expanded", "true")
  await expect(toggle).toHaveAttribute("aria-pressed", "true")
  await page.keyboard.press("h")
  await expect(historyPanel(page)).toHaveAttribute("aria-expanded", "false")
})
