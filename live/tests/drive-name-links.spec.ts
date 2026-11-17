import { expect, test, type Page } from "@playwright/test"

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64")
const ORIGIN = "http://127.0.0.1:4173"

// Two orgs share the name "acme": "acme/docs" is unique, "acme/work" is not.
const orgs = [
  { id: "o1", name: "acme" },
  { id: "o2", name: "acme" },
  { id: "o3", name: "solo" },
]
const drives: Record<string, { id: string; name: string }[]> = {
  o1: [{ id: "d1", name: "docs" }, { id: "d2", name: "work" }],
  o2: [{ id: "d3", name: "work" }],
  o3: [{ id: "d4", name: "team notes" }],
}
// Only on the manageable list: an admin who is not on the drive.
const manageable: Record<string, { id: string; name: string; isDefault: boolean; myRole: null }[]> = {
  o1: [{ id: "d9", name: "hidden", isDefault: false, myRole: null }],
}

const markdown = (body: string) => `# Notes\n\n${body}\n`

interface Fixture {
  ops: Array<{ op: string; path?: string; drive: string }>
  /** Markdown served for notes.md. */
  notes: string
}

/** Production app shell against deterministic API fixtures; no live account. */
async function installFixture(
  page: Page,
  opts: { scopedOrgId?: string; failOrgs?: boolean; failDrivesOf?: string; manageableStatus?: number; managedDocsTwin?: boolean } = {},
) {
  const fx: Fixture = { ops: [], notes: markdown("Hello") }
  await page.addInitScript(() => {
    localStorage.setItem("agent-fs-credentials", JSON.stringify([
      { id: "qa", name: "QA", endpoint: "http://fixture.test", apiKey: "fixture" },
    ]))
    localStorage.setItem("agent-fs-active-credential", "qa")
  })
  await page.route("http://fixture.test/**", async (route) => {
    const url = new URL(route.request().url())
    const p = url.pathname
    let json: unknown = {}
    if (p === "/auth/me") json = { userId: "qa", email: "qa@example.test", defaultOrgId: opts.scopedOrgId ?? "o1", defaultDriveId: opts.scopedOrgId ? "d4" : "d1", scopedOrgId: opts.scopedOrgId }
    else if (p === "/orgs") {
      if (opts.failOrgs) return route.fulfill({ status: 500, json: { error: "boom" } })
      json = { orgs }
    } else if (/^\/orgs\/[^/]+$/.test(p)) json = orgs.find((o) => o.id === p.split("/")[2])
    else if (p.endsWith("/drives")) {
      const org = p.split("/")[2]
      if (org === opts.failDrivesOf) return route.fulfill({ status: 500, json: { error: "boom" } })
      if (url.searchParams.get("scope") === "manageable") {
        if (opts.manageableStatus) return route.fulfill({ status: opts.manageableStatus, json: { error: "no" } })
        const twin = opts.managedDocsTwin && org === "o1" ? [{ id: "d8", name: "docs", isDefault: false, myRole: null }] : []
        json = { drives: [...(manageable[org] ?? []), ...twin] }
      } else json = { drives: (drives[org] ?? []).map((d) => ({ ...d, orgId: org })) }
    } else if (p.endsWith("/members")) json = { members: [] }
    else if (p === "/health") json = { ok: true, version: "test", features: ["share-links", "html-sites"] }
    else if (p === "/content") return route.fulfill({ body: fx.notes, contentType: "text/plain" })
    else if (p === "/img.png") return route.fulfill({ body: png, contentType: "image/png" })
    else if (p.endsWith("/ops")) {
      const { op, path } = route.request().postDataJSON()
      fx.ops.push({ op, path, drive: p.split("/")[2] })
      switch (op) {
        case "ls": json = { entries: [{ name: "notes.md", type: "file", size: 8, modifiedAt: "2026-10-01T10:00:00.000Z" }] }; break
        case "stat": json = { path, size: 8, contentType: "text/markdown", author: "qa", currentVersion: 1, createdAt: "2026-10-01", modifiedAt: "2026-10-01", isDeleted: false }; break
        case "cat": json = { content: fx.notes, totalLines: 3, truncated: false }; break
        case "signed-url": json = { url: String(path).endsWith(".png") ? "http://fixture.test/img.png" : `http://fixture.test/content?path=${path}` }; break
        case "comment-list": json = { comments: [] }; break
        case "comment-notification-list": json = { notifications: [], unreadCount: 0 }; break
        case "favorite-list": json = { favorites: [] }; break
        case "share-list": json = { items: [], hasMore: false }; break
      }
    }
    await route.fulfill({ json })
  })
  return fx
}

const pathOf = (page: Page) => new URL(page.url()).pathname + new URL(page.url()).search + new URL(page.url()).hash

test("every view opened by name keeps the names in the address", async ({ page }) => {
  await installFixture(page)
  for (const address of [
    "/file/acme/docs/notes.md#flow=web",
    "/file/acme/docs/",
    "/detail/acme/docs/notes.md",
    "/page/acme/docs/notes.md",
    "/sql/acme/docs",
    "/members/acme/docs",
    "/shares/acme/docs",
  ]) {
    await page.goto(address)
    await expect(page.locator("body")).not.toContainText("None of your drives")
    await page.waitForTimeout(300)
    expect(pathOf(page), address).toBe(address)
  }
  await page.goto("/file/acme/docs/notes.md")
  await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible()
})

test("an ID link moves to the name form without remounting the page", async ({ page }) => {
  await installFixture(page)
  await page.goto("/file/~/o1/d1/notes.md?page=2#flow=web")
  await expect(page).toHaveURL(`${ORIGIN}/file/acme/docs/notes.md?page=2#flow=web`)
  await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible()

  // Mark the mounted shell, then make the router follow an ID address.
  await page.locator("aside").first().evaluate((el) => el.setAttribute("data-mounted", "yes"))
  await page.evaluate(() => {
    history.pushState(null, "", "/file/~/o1/d1/notes.md")
    dispatchEvent(new PopStateEvent("popstate"))
  })
  await expect(page).toHaveURL(`${ORIGIN}/file/acme/docs/notes.md`)
  await expect(page.locator('aside[data-mounted="yes"]')).toHaveCount(1)
})

test("in-app navigation stays on names", async ({ page }) => {
  await installFixture(page)
  await page.goto("/file/acme/docs/")
  await expect(page.locator('[data-tree-path="notes.md"]')).toBeVisible()
  await page.keyboard.press("Shift+M")
  await expect(page).toHaveURL(`${ORIGIN}/members/acme/docs`)

  await page.goto("/file/acme/docs/")
  await page.locator('[data-tree-path="notes.md"]').click()
  await expect(page).toHaveURL(`${ORIGIN}/file/acme/docs/notes.md`)
  await page.getByRole("button", { name: "Open full page" }).click()
  await expect(page).toHaveURL(`${ORIGIN}/detail/acme/docs/notes.md`)
  await page.getByRole("button", { name: "Present" }).first().click()
  await expect(page).toHaveURL(`${ORIGIN}/page/acme/docs/notes.md`)
})

test("a drive only on the admin's manageable list resolves on Members", async ({ page }) => {
  await installFixture(page)
  await page.goto("/members/~/o1/d9")
  await expect(page).toHaveURL(`${ORIGIN}/members/acme/hidden`)
  await page.goto("/members/acme/hidden")
  await expect(page.locator("body")).not.toContainText("None of your drives")
  // It is not a drive to browse.
  await page.goto("/file/acme/hidden/")
  await expect(page.getByText("None of your drives is “hidden” in “acme”.")).toBeVisible()
})

test("a name pair two drives share asks which one, by ID", async ({ page }) => {
  await installFixture(page)
  await page.goto("/file/acme/work/notes.md#x=1")
  await expect(page.getByText("More than one of your drives is “work” in “acme”.")).toBeVisible()
  await page.getByRole("link", { name: "acme / work (d3)" }).click()
  await expect(page).toHaveURL(`${ORIGIN}/file/~/o2/d3/notes.md#x=1`)
})

test("unknown names, a failed org list and a failed drive list each say so", async ({ page }) => {
  await installFixture(page)
  await page.goto("/file/acme/nope/")
  await expect(page.getByText("None of your drives is “nope” in “acme”.")).toBeVisible()

  const failing = await page.context().newPage()
  await installFixture(failing, { failOrgs: true })
  await failing.goto("/file/acme/docs/")
  await expect(failing.getByText("Couldn’t load your drives")).toBeVisible({ timeout: 15_000 })

  const partial = await page.context().newPage()
  await installFixture(partial, { failDrivesOf: "o2" })
  await partial.goto("/file/acme/docs/")
  await expect(partial.getByText("Couldn’t load your drives")).toBeVisible({ timeout: 15_000 })
  expect(new URL(partial.url()).pathname).toBe("/file/acme/docs/")
})

test("an org-scoped key on another org's link says so instead of waiting", async ({ page }) => {
  await installFixture(page, { scopedOrgId: "o3" })
  await page.goto("/file/~/o1/d1/notes.md")
  await expect(page.getByText("This key can only open solo.")).toBeVisible()
  await page.goto("/file/~/o3/d4/")
  await expect(page).toHaveURL(`${ORIGIN}/file/solo/team%20notes/`)
})

test("spaces, # and ? survive in names and paths", async ({ page }) => {
  const fx = await installFixture(page)
  await page.goto("/file/solo/team%20notes/report%23draft%3F.md")
  await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe("/file/solo/team%20notes/report%23draft%3F.md")
  expect(fx.ops.some((o) => o.op === "stat" && o.path === "report#draft?.md" && o.drive === "o3")).toBe(true)
})

test("Copy link shares the name form, or the ID form when the names clash", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN })
  await installFixture(page)
  await page.goto("/file/acme/docs/")
  await page.locator('[data-tree-path="notes.md"]').click({ button: "right" })
  await page.getByRole("menuitem", { name: "Copy link" }).click()
  await expect(page.getByText("Link copied")).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${ORIGIN}/file/acme/docs/notes.md`)

  await page.goto("/file/~/o1/d2/")
  await page.locator('[data-tree-path="notes.md"]').click({ button: "right" })
  await page.getByRole("menuitem", { name: "Copy link" }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${ORIGIN}/file/~/o1/d2/notes.md`)
})

test("an image linked by name renders; an ambiguous one fails closed without a request", async ({ page }) => {
  const fx = await installFixture(page)
  fx.notes = markdown(`![ok](${ORIGIN}/file/acme/docs/img/a.png)\n\n![clash](${ORIGIN}/file/acme/work/img/b.png)`)
  await page.goto("/file/acme/docs/notes.md")
  await expect(page.getByRole("img", { name: "ok" })).toBeVisible()
  await expect(page.getByText("Image not available: more than one drive has that name")).toBeVisible()
  expect(fx.ops.filter((o) => o.op === "signed-url" && o.path === "img/a.png").map((o) => o.drive)).toContain("o1")
  expect(fx.ops.some((o) => o.op === "signed-url" && o.path === "img/b.png")).toBe(false)
})

test("an admin list that fails for another reason than 403 stops admin names; 403 does not", async ({ page }) => {
  await installFixture(page, { manageableStatus: 500 })
  await page.goto("/members/acme/docs")
  await expect(page.getByText("Couldn’t load your drives")).toBeVisible({ timeout: 15_000 })
  // By ID it opens, and stays by ID while the names can't be checked.
  await page.goto("/members/~/o1/d1")
  await page.waitForTimeout(500)
  expect(new URL(page.url()).pathname).toBe("/members/~/o1/d1")

  const member = await page.context().newPage()
  await installFixture(member, { manageableStatus: 403 })
  await member.goto("/members/~/o1/d1")
  await expect(member).toHaveURL(`${ORIGIN}/members/acme/docs`)
})

test("Members keeps the ID form when a managed drive shares the name", async ({ page }) => {
  await installFixture(page, { managedDocsTwin: true })
  await page.goto("/file/acme/docs/")
  await expect(page.locator('[data-tree-path="notes.md"]')).toBeVisible()
  await page.keyboard.press("Shift+M")
  await expect(page).toHaveURL(`${ORIGIN}/members/~/o1/d1`)
  await page.waitForTimeout(500)
  await expect(page.locator("body")).not.toContainText("More than one of your drives")
})
