import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test, type Page } from "@playwright/test"

// A tab opened before a deploy asks for a TextViewer chunk the new deploy no
// longer serves. Before the fix the SPA fallback answered with index.html, so
// the lazy import failed and the error boundary showed it until a manual reload.

async function installFixture(page: Page) {
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
    else if (url.pathname === "/content") return route.fulfill({ body: "A raw preview line", contentType: "text/plain" })
    else if (url.pathname.endsWith("/ops")) {
      const { op, path } = route.request().postDataJSON()
      switch (op) {
        case "stat": json = { path, size: 18, contentType: "text/plain", author: "qa", currentVersion: 1, createdAt: "2026-01-01", modifiedAt: "2026-01-01", isDeleted: false }; break
        case "signed-url": json = { url: `http://fixture.test/content?path=${path}` }; break
        case "comment-list": json = { comments: [] }; break
        case "comment-notification-list": json = { notifications: [], unreadCount: 0 }; break
        case "ls": json = { entries: [] }; break
        case "tree": json = { tree: [] }; break
        // Side panels (reveal, recent, ...) degrade gracefully; this test only needs the viewer.
        default: return route.abort()
      }
    } else if (url.pathname === "/health") json = { status: "ok" }
    else throw new Error(`Unexpected request: ${url}`)
    await route.fulfill({ json })
  })
}

function countDocumentLoads(page: Page) {
  const loads = { count: 0 }
  page.on("load", () => loads.count++)
  return loads
}

test("a stale TextViewer chunk reloads the tab once and recovers", async ({ page }) => {
  await installFixture(page)
  let missing = 1
  // The old production behaviour: the SPA fallback serves index.html for the missing chunk.
  await page.route("**/assets/TextViewer-*.js", async route => {
    if (missing-- <= 0) return route.fallback()
    await route.fulfill({ body: "<!doctype html><html></html>", contentType: "text/html" })
  })
  const loads = countDocumentLoads(page)

  await page.goto("/file/~/org/drive/notes.log")

  await expect(page.locator(".monaco-editor:visible .view-lines")).toContainText("A raw preview line")
  await expect(page.getByText("Failed to fetch dynamically imported module")).toHaveCount(0)
  expect(loads.count).toBe(2)
})

test("a chunk that stays missing shows the error after a single reload", async ({ page }) => {
  await installFixture(page)
  await page.route("**/assets/TextViewer-*.js", route => route.fulfill({ status: 404, body: "Not Found" }))
  const loads = countDocumentLoads(page)

  await page.goto("/file/~/org/drive/notes.log")

  await expect(page.getByText("Failed to fetch dynamically imported module")).toBeVisible()
  await page.waitForTimeout(1_000)
  expect(loads.count).toBe(2)
})
