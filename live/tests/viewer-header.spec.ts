import { expect, test, type Page } from "@playwright/test"

const NOTES = "# Notes\n\nA file whose embedding status shows in the header.\n"

const comment = {
  id: "c1", path: "notes.md", body: "A comment", author: "qa", resolved: false, replyCount: 0,
  createdAt: "2026-10-30T12:00:00.000Z", updatedAt: "2026-10-30T12:00:00.000Z", replies: [],
}

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
    else if (url.pathname === "/health") json = { ok: true, version: "test", features: ["favorites", "share-links"] }
    else if (url.pathname === "/content") return route.fulfill({ body: NOTES, contentType: "text/markdown" })
    else if (url.pathname.endsWith("/ops")) {
      const body = route.request().postDataJSON()
      switch (body.op) {
        case "ls": json = { entries: [{ name: "notes.md", type: "file", size: NOTES.length, modifiedAt: "2026-10-02T10:00:00.000Z" }] }; break
        case "stat": json = { path: body.path, size: NOTES.length, contentType: "text/markdown", author: "qa", currentVersion: 1, createdAt: "2026-10-01", modifiedAt: "2026-10-02", isDeleted: false, embeddingStatus: "indexed" }; break
        case "signed-url": json = { url: `http://fixture.test/content?path=${encodeURIComponent(body.path)}` }; break
        case "comment-list": json = { comments: [comment] }; break
        case "comment-notification-list": json = { notifications: [], unreadCount: 0 }; break
        case "favorite-list": json = { favorites: [] }; break
        default: return route.abort()
      }
    } else return route.abort()
    await route.fulfill({ json })
  })
}

/** Every visible piece of the header's left group must end before the action group starts. */
async function headerOverlaps(page: Page) {
  return page.locator("[data-viewer-header]").evaluate(header => {
    const [left, right] = Array.from(header.children) as HTMLElement[]
    const actionsLeft = right.getBoundingClientRect().left
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const crossing = Array.from(left.children)
      .filter(visible)
      .filter(el => el.getBoundingClientRect().right > actionsLeft + 0.5)
      .map(el => el.textContent)
    return { crossing, leftRight: left.getBoundingClientRect().right, actionsLeft, headerScroll: header.scrollWidth, headerClient: header.clientWidth }
  })
}

for (const [width, height] of [[390, 844], [360, 740]] as const) {
  test(`header status badge does not overlap the actions at ${width}x${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height })
    await installFixture(page)
    await page.goto("/file/~/org/drive/notes.md")
    await expect(page.getByText("A file whose embedding status shows in the header.")).toBeVisible()
    await expect(page.locator("[data-viewer-header]")).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`header-${width}.png`) })
    const result = await headerOverlaps(page)
    expect(result.crossing).toEqual([])
    expect(result.headerScroll).toBeLessThanOrEqual(result.headerClient)
  })
}

test("desktop header keeps the embedding status beside the filename", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await installFixture(page)
  await page.goto("/file/~/org/drive/notes.md")
  const header = page.locator("[data-viewer-header]")
  await expect(header.getByText("Embedding: indexed")).toBeVisible()
  await expect(header.getByText("notes.md")).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("header-1280.png") })
  expect((await headerOverlaps(page)).crossing).toEqual([])
})
