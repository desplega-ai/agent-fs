import { expect, test, type Page } from "@playwright/test"

const userComment = {
  id: "another-users-comment",
  path: "notes.md",
  body: "A comment from another user",
  author: "another-user",
  resolved: false,
  replyCount: 0,
  createdAt: "2026-09-29T12:00:00.000Z",
  updatedAt: "2026-09-29T12:00:00.000Z",
  replies: [],
}

async function installFixture(page: Page, counts: { unresolved: number; resolved: number }) {
  await page.addInitScript(() => {
    localStorage.setItem("agent-fs-credentials", JSON.stringify([
      { id: "qa", name: "QA", endpoint: "http://fixture.test", apiKey: "fixture" },
    ]))
    localStorage.setItem("agent-fs-active-credential", "qa")
  })
  await page.route("http://fixture.test/**", async route => {
    const url = new URL(route.request().url())
    let json: unknown
    if (url.pathname === "/auth/me") {
      json = { userId: "qa", email: "qa@example.test", defaultOrgId: "org", defaultDriveId: "drive" }
    } else if (url.pathname === "/orgs") {
      json = { orgs: [{ id: "org", name: "QA" }] }
    } else if (url.pathname.endsWith("/drives")) {
      json = { drives: [{ id: "drive", name: "QA", orgId: "org" }] }
    } else if (url.pathname.endsWith("/members")) {
      json = { members: [{ userId: "another-user", email: "other@example.test" }] }
    } else if (url.pathname === "/content") {
      return route.fulfill({ body: "# Notes\n\nContent", contentType: "text/markdown" })
    } else if (url.pathname.endsWith("/ops")) {
      const body = route.request().postDataJSON()
      switch (body.op) {
        case "stat":
          json = { path: body.path, size: 20, contentType: "text/markdown", author: "qa", currentVersion: 1, createdAt: "2026-01-01", modifiedAt: "2026-01-01", isDeleted: false }
          break
        case "signed-url":
          json = { url: `http://fixture.test/content?path=${body.path}` }
          break
        case "comment-list":
          if (body.resolved) {
            counts.resolved++
            json = { comments: [] }
          } else {
            counts.unresolved++
            json = { comments: counts.unresolved >= 2 ? [userComment] : [] }
          }
          break
        case "comment-notification-list":
          json = { notifications: [], unreadCount: 0 }
          break
        case "ls":
          json = { entries: [] }
          break
        case "tree":
          json = { tree: [] }
          break
        default:
          throw new Error(`Unexpected op: ${body.op}`)
      }
    } else if (url.pathname === "/health") {
      json = { status: "ok" }
    } else {
      throw new Error(`Unexpected request: ${url}`)
    }
    await route.fulfill({ json })
  })
}

test("closed comment surfaces stop polling across mobile and desktop resizes", async ({ page }) => {
  const counts = { unresolved: 0, resolved: 0 }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.clock.install()
  await installFixture(page, counts)
  await page.goto("/file/~/org/drive/notes.md")

  await expect(page.getByRole("button", { name: "Toggle comments" })).toBeVisible()
  await expect.poll(() => counts.unresolved).toBe(1)
  await page.clock.runFor(30_000)
  expect(counts).toEqual({ unresolved: 1, resolved: 0 })

  await page.setViewportSize({ width: 1280, height: 844 })
  const collapse = page.getByRole("button", { name: "Collapse panel" })
  await expect(collapse).toBeVisible()
  await expect.poll(() => counts.resolved).toBeGreaterThan(0)
  await collapse.click()
  await expect(page.getByRole("button", { name: "Open comments" })).toBeVisible()

  const afterCollapse = { ...counts }
  await page.clock.runFor(30_000)
  expect(counts).toEqual(afterCollapse)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.clock.runFor(30_000)
  expect(counts).toEqual(afterCollapse)
})

test("open mobile comments receive another user's comment and polling restarts after reopening", async ({ page }) => {
  const counts = { unresolved: 0, resolved: 0 }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.clock.install()
  await installFixture(page, counts)
  await page.goto("/file/~/org/drive/notes.md")

  const toggle = page.getByRole("button", { name: "Toggle comments" })
  await expect(toggle).toBeVisible()
  await expect.poll(() => counts.unresolved).toBe(1)
  await toggle.click()
  await expect(page.getByRole("dialog").getByText("No comments yet")).toBeVisible()
  await page.clock.runFor(10_000)
  await expect(page.getByRole("dialog").getByText(userComment.body)).toBeVisible()
  expect(counts.unresolved).toBe(2)

  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toBeHidden()
  const afterClose = { ...counts }
  await page.clock.runFor(20_000)
  expect(counts).toEqual(afterClose)

  await toggle.click()
  await expect(page.getByRole("dialog").getByText(userComment.body)).toBeVisible()
  const afterReopen = { ...counts }
  await page.clock.runFor(10_000)
  expect(counts.unresolved).toBeGreaterThan(afterReopen.unresolved)
  expect(counts.resolved).toBeGreaterThan(afterReopen.resolved)
})
