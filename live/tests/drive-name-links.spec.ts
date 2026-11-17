import { expect, test, type Page } from "@playwright/test"

const drives: Record<string, Array<{ id: string; name: string; orgId: string }>> = {
  o1: [
    { id: "ctx", name: "reveri-context", orgId: "o1" },
    { id: "w1", name: "work", orgId: "o1" },
  ],
  o2: [{ id: "w2", name: "work", orgId: "o2" }],
}

/** Two orgs, a unique drive name and a name both orgs use; no live account. */
async function installFixture(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("agent-fs-credentials", JSON.stringify([
      { id: "qa", name: "QA", endpoint: "http://fixture.test", apiKey: "fixture" },
    ]))
    localStorage.setItem("agent-fs-active-credential", "qa")
  })
  await page.route("http://fixture.test/**", async (route) => {
    const url = new URL(route.request().url())
    let json: unknown
    if (url.pathname === "/auth/me") json = { userId: "qa", email: "qa@example.test", defaultOrgId: "o1", defaultDriveId: "ctx" }
    else if (url.pathname === "/orgs") json = { orgs: [{ id: "o1", name: "Team" }, { id: "o2", name: "Personal" }] }
    else if (url.pathname.endsWith("/drives")) json = { drives: drives[url.pathname.split("/")[2]] ?? [] }
    else if (url.pathname === "/health") json = { ok: true, version: "test", features: [] }
    else if (url.pathname.endsWith("/ops")) {
      const { op } = route.request().postDataJSON()
      switch (op) {
        case "ls": json = { entries: [{ name: "notes.md", type: "file", size: 8, modifiedAt: "2026-10-01T10:00:00.000Z" }] }; break
        case "stat": json = { path: "/notes.md", size: 8, contentType: "text/markdown", author: "qa", currentVersion: 1, createdAt: "2026-10-01", modifiedAt: "2026-10-01", isDeleted: false }; break
        case "cat": json = { content: "# Notes\n", totalLines: 1, truncated: false }; break
        case "comment-list": json = { comments: [] }; break
        case "comment-notification-list": json = { notifications: [], unreadCount: 0 }; break
        case "favorite-list": json = { favorites: [] }; break
        default: json = {}
      }
    } else json = {}
    await route.fulfill({ json })
  })
}

test("a drive name with one match opens that drive, keeping the fragment", async ({ page }) => {
  await installFixture(page)
  await page.goto("/d/reveri-context/notes.md#flow=web")
  await expect(page).toHaveURL(/\/file\/~\/o1\/ctx\/notes\.md#flow=web$/)
})

test("a drive name two orgs use asks which one", async ({ page }) => {
  await installFixture(page)
  await page.goto("/d/work/notes.md")
  await expect(page.getByText("Several of your drives are named “work”")).toBeVisible()
  await page.getByRole("link", { name: "work in Personal" }).click()
  await expect(page).toHaveURL(/\/file\/~\/o2\/w2\/notes\.md$/)
})

test("an unknown drive name says so", async ({ page }) => {
  await installFixture(page)
  await page.goto("/d/missing/notes.md")
  await expect(page.getByText("None of your drives is named “missing”.")).toBeVisible()
})

test("Copy link shares the name form for a unique drive name", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:4173" })
  await installFixture(page)
  await page.goto("/file/~/o1/ctx/")
  await page.locator('[data-tree-path="notes.md"]').click({ button: "right" })
  await page.getByRole("menuitem", { name: "Copy link" }).click()
  await expect(page.getByText("Link copied")).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("http://127.0.0.1:4173/d/reveri-context/notes.md")
})

test("Copy link keeps the ID form when another drive has the name", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:4173" })
  await installFixture(page)
  await page.goto("/file/~/o1/w1/")
  await page.locator('[data-tree-path="notes.md"]').click({ button: "right" })
  await page.getByRole("menuitem", { name: "Copy link" }).click()
  await expect(page.getByText("Link copied")).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("http://127.0.0.1:4173/file/~/o1/w1/notes.md")
})

test("an encoded # or ? in the file name survives the redirect", async ({ page }) => {
  await installFixture(page)
  await page.goto("/d/reveri-context/report%23draft%3F.md#flow=web")
  await expect(page).toHaveURL(/\/file\/~\/o1\/ctx\/report%23draft%3F\.md#flow=web$/)
})

test("a drive list that fails stops the redirect instead of guessing", async ({ page }) => {
  await installFixture(page)
  await page.route("http://fixture.test/orgs/o2/drives", (route) => route.fulfill({ status: 500, json: { error: "boom" } }))
  await page.goto("/d/work/notes.md")
  await expect(page.getByText("Couldn’t load your drives to find “work”.")).toBeVisible({ timeout: 15_000 })
  await expect(page).toHaveURL(/\/d\/work\/notes\.md$/)
})
