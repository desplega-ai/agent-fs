import { expect, test, type Page } from "@playwright/test"

const members = [
  { userId: "qa", email: "qa@example.test", displayName: "QA Reviewer" },
  { userId: "u-ada", email: "ada@example.test", displayName: "Ada Lovelace" },
  { userId: "u-grace", email: "grace@example.test", displayName: "Grace Hopper" },
  { userId: "u-bot", email: "review-bot@agents.test", displayName: null },
]

async function installFixture(page: Page, features: string[]) {
  const added: Array<Record<string, unknown>> = []
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
      json = { userId: "qa", email: "qa@example.test", displayName: "QA Reviewer", defaultOrgId: "org", defaultDriveId: "drive" }
    } else if (url.pathname === "/orgs") {
      json = { orgs: [{ id: "org", name: "QA" }] }
    } else if (url.pathname.endsWith("/drives")) {
      json = { drives: [{ id: "drive", name: "QA", orgId: "org" }] }
    } else if (url.pathname.endsWith("/members")) {
      json = { members: [] }
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
        case "drive-members":
          json = { members }
          break
        case "comment-add": {
          const { op: _op, ...params } = body
          added.push(params)
          json = { id: `c${added.length}`, path: body.path, body: body.body, author: "qa", createdAt: "2026-10-26T12:00:00.000Z" }
          break
        }
        case "comment-list":
          json = { comments: [] }
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
        // Side panels (reveal, recent, ...) degrade gracefully.
        default:
          return route.abort()
      }
    } else if (url.pathname === "/health") {
      json = { status: "ok", features }
    } else {
      throw new Error(`Unexpected request: ${url}`)
    }
    await route.fulfill({ json })
  })
  return added
}

async function openCommentBox(page: Page) {
  await page.setViewportSize({ width: 1280, height: 844 })
  await page.goto("/file/~/org/drive/notes.md")
  await page.getByRole("button", { name: "Add comment" }).first().click()
  const box = page.getByPlaceholder("Comment on this file...")
  await expect(box).toBeFocused()
  return box
}

test("@ suggests drive members and sends the picked ones as mentions", async ({ page }) => {
  const added = await installFixture(page, ["comment-mentions"])
  const box = await openCommentBox(page)
  const list = page.getByRole("listbox", { name: "Mention a drive member" })

  await box.pressSequentially("Looks good @")
  // Everyone but the signed-in user, by label.
  await expect(list.getByRole("option")).toHaveText([
    /Ada Lovelace/,
    /Grace Hopper/,
    /review-bot@agents\.test/,
  ])
  await expect(list.getByRole("option", { selected: true })).toHaveText(/Ada Lovelace/)
  await page.screenshot({ path: "test-results/comment-mentions-open.png" })

  await box.pressSequentially("gr")
  await expect(list.getByRole("option")).toHaveText([/Grace Hopper/])
  await box.press("Enter")
  await expect(list).toBeHidden()
  await expect(box).toHaveValue("Looks good @Grace Hopper ")

  await box.pressSequentially("and @")
  await box.press("ArrowDown")
  await box.press("ArrowDown")
  await expect(list.getByRole("option", { selected: true })).toHaveText(/review-bot@agents\.test/)
  await box.press("ArrowDown")
  await expect(list.getByRole("option", { selected: true })).toHaveText(/Ada Lovelace/)
  await box.press("ArrowUp")
  await box.press("Tab")
  await expect(box).toHaveValue("Looks good @Grace Hopper and @review-bot@agents.test ")
  await expect(box).toBeFocused()

  await box.pressSequentially("ok")
  await page.screenshot({ path: "test-results/comment-mentions-filled.png" })
  await page.getByRole("button", { name: "Send comment" }).click()
  await expect.poll(() => added.length).toBe(1)
  expect(added[0]).toMatchObject({
    path: "notes.md",
    body: "Looks good @Grace Hopper and @review-bot@agents.test ok",
    mentions: ["u-grace", "u-bot"],
  })
})

test("Esc closes the list but keeps the comment box, and deleted mentions are not sent", async ({ page }) => {
  const added = await installFixture(page, ["comment-mentions"])
  const box = await openCommentBox(page)
  const list = page.getByRole("listbox", { name: "Mention a drive member" })

  await box.pressSequentially("@ad")
  await expect(list).toBeVisible()
  await box.press("Escape")
  await expect(list).toBeHidden()
  await expect(box).toBeVisible()
  await expect(box).toHaveValue("@ad")
  // With the list closed, Enter is a newline again.
  await box.press("Enter")
  await expect(box).toHaveValue("@ad\n")

  await box.fill("")
  await box.pressSequentially("@ad")
  await expect(list).toBeVisible()
  await list.getByRole("option", { name: /Ada Lovelace/ }).click()
  await expect(box).toHaveValue("@Ada Lovelace ")
  await box.fill("never mind")
  await box.press("Control+Enter")
  await expect.poll(() => added.length).toBe(1)
  expect(added[0].mentions).toBeUndefined()
})

test("servers without comment-mentions get no picker", async ({ page }) => {
  const added = await installFixture(page, [])
  const box = await openCommentBox(page)

  await box.pressSequentially("@gr")
  await expect(page.getByRole("listbox")).toHaveCount(0)
  await box.press("Control+Enter")
  await expect.poll(() => added.length).toBe(1)
  expect(added[0]).not.toHaveProperty("mentions")
})
