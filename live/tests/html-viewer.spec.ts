import { expect, test, type Page } from "@playwright/test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const html = "<!doctype html><title>QA page</title><h1 id=\"hello\">Hello from the page</h1>"

// Production app shell against deterministic API fixtures; no live account.
async function installFixture(page: Page, minted: string[], features = ["share-links", "html-sites"]) {
  await page.addInitScript(() => {
    localStorage.setItem("agent-fs-credentials", JSON.stringify([
      { id: "qa", name: "QA", endpoint: "http://fixture.test", apiKey: "fixture" },
    ]))
    localStorage.setItem("agent-fs-active-credential", "qa")
  })
  // Serve Monaco's AMD assets locally instead of depending on its CDN.
  await page.route("https://cdn.jsdelivr.net/**", async route => {
    const path = new URL(route.request().url()).pathname.split("/min/")[1]
    if (!path) return route.abort()
    const body = await readFile(resolve("node_modules/monaco-editor/min", path))
    await route.fulfill({ body, contentType: path.endsWith(".css") ? "text/css" : "text/javascript" })
  })
  await page.route("http://fixture.test/**", async route => {
    const url = new URL(route.request().url())
    let json: unknown
    if (url.pathname === "/auth/me") json = { userId: "qa", email: "qa@example.test", defaultOrgId: "org", defaultDriveId: "drive" }
    else if (url.pathname === "/orgs") json = { orgs: [{ id: "org", name: "QA" }] }
    else if (url.pathname.endsWith("/drives")) json = { drives: [{ id: "drive", name: "QA", orgId: "org" }] }
    else if (url.pathname === "/content") return route.fulfill({ body: html, contentType: "text/plain" })
    else if (url.pathname.startsWith("/site/")) return route.fulfill({ body: html, contentType: "text/html" })
    else if (url.pathname.endsWith("/ops")) {
      const { op, path } = route.request().postDataJSON()
      switch (op) {
        case "stat": json = { path, size: html.length, contentType: "text/html", author: "qa", currentVersion: 1, createdAt: "2026-01-01", modifiedAt: "2026-01-01", isDeleted: false }; break
        case "signed-url": json = { url: `http://fixture.test/content?path=${path}` }; break
        case "share-create": {
          minted.push(path)
          const token = `tok${minted.length}`
          json = { id: token, kind: "site", url: `/site/${token}/`, sharePath: `/site/${token}/`, path, expiresIn: 900, expiresAt: new Date(Date.now() + 900_000).toISOString(), maxViews: null }
          break
        }
        case "comment-list": json = { comments: [] }; break
        case "comment-notification-list": json = { notifications: [], unreadCount: 0 }; break
        case "ls": json = { entries: [] }; break
        case "tree": json = { tree: [] }; break
        // Side panels (reveal, recent, ...) degrade gracefully; these tests only need the viewer.
        default: return route.abort()
      }
    } else if (url.pathname === "/health") json = { ok: true, version: "test", features }
    else throw new Error(`Unexpected request: ${url}`)
    await route.fulfill({ json })
  })
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
})

test("an HTML file renders in a sandboxed frame from a site share of its folder", async ({ page }) => {
  const minted: string[] = []
  await installFixture(page, minted)
  await page.goto("/file/~/org/drive/reports/page.html")

  const frame = page.locator('iframe[title="reports/page.html"]')
  await expect(frame).toBeVisible()
  await expect(frame).toHaveAttribute("src", "http://fixture.test/site/tok1/page.html")
  const sandbox = (await frame.getAttribute("sandbox")) ?? ""
  expect(sandbox.split(" ")).toContain("allow-scripts")
  expect(sandbox).not.toContain("allow-same-origin")
  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer")
  await expect(page.frameLocator('iframe[title="reports/page.html"]').locator("#hello")).toHaveText("Hello from the page")
  expect(minted).toEqual(["/reports"])
})

test("an HTML file at the drive root asks before rendering", async ({ page }) => {
  const minted: string[] = []
  await installFixture(page, minted)
  await page.goto("/file/~/org/drive/index.html")

  await expect(page.getByText("This page can read every file in this drive for 15 minutes while it is open. Render it?")).toBeVisible()
  await expect(page.locator("iframe")).toHaveCount(0)
  expect(minted).toEqual([])

  await page.getByRole("button", { name: "Render", exact: true }).click()
  await expect(page.locator('iframe[title="index.html"]')).toBeVisible()
  expect(minted).toEqual(["/"])

  // The choice is remembered for this file.
  await page.reload()
  await expect(page.locator('iframe[title="index.html"]')).toBeVisible()
})

test("Show source on the drive-root confirm opens the source", async ({ page }) => {
  await installFixture(page, [])
  await page.goto("/file/~/org/drive/index.html")
  await page.getByRole("button", { name: "Show source" }).click()
  await expect(page.locator(".monaco-editor:visible .view-lines")).toContainText("Hello from the page")
  await expect(page.locator("iframe")).toHaveCount(0)
})

test("pressing e toggles between the rendered page and Monaco source", async ({ page }) => {
  await installFixture(page, [])
  await page.goto("/file/~/org/drive/reports/page.html")
  await expect(page.locator('iframe[title="reports/page.html"]')).toBeVisible()

  await page.keyboard.press("e")
  await expect(page.locator(".monaco-editor:visible .view-lines")).toContainText("Hello from the page")
  await expect(page.locator("iframe")).toHaveCount(0)

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press("e")
  await expect(page.locator('iframe[title="reports/page.html"]')).toBeVisible()
})

test("a server without html-sites shows the source with no toggle", async ({ page }) => {
  const minted: string[] = []
  await installFixture(page, minted, ["share-links"])
  await page.goto("/file/~/org/drive/reports/page.html")
  await expect(page.locator(".monaco-editor:visible .view-lines")).toContainText("Hello from the page")
  await expect(page.getByRole("button", { name: "Source" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Preview" })).toHaveCount(0)
  await expect(page.locator("iframe")).toHaveCount(0)
  expect(minted).toEqual([])
})
