import { expect, test, type Page } from "@playwright/test"

type Role = "viewer" | "editor" | "admin"
type Person = { userId: string; email: string; displayName: string | null }

const people: Record<string, Person> = {
  qa: { userId: "qa", email: "qa@example.test", displayName: "QA Admin" },
  ana: { userId: "ana", email: "ana@example.test", displayName: "Ana" },
  ben: { userId: "ben", email: "ben@example.test", displayName: null },
}

const drives = [
  { id: "work", name: "work", orgId: "org", isDefault: true },
  { id: "ledger", name: "ledger", orgId: "org", isDefault: false },
]

/**
 * Production app shell against an in-memory org: drive membership lives in
 * `members`, every member write is recorded in `calls`. `orgAdmin: false`
 * makes the org member list 403 (a drive admin who is not an org admin), and
 * the drive admin list 403s once that caller is no longer admin of the drive;
 * `driveAdmin: false` makes the drive admin list 403 too (a plain member).
 */
async function installFixture(page: Page, opts: { orgAdmin?: boolean; driveAdmin?: boolean } = {}) {
  const orgAdmin = opts.orgAdmin ?? true
  const driveAdmin = opts.driveAdmin ?? true
  const members: Record<string, Map<string, Role>> = {
    work: new Map<string, Role>([["qa", "admin"], ["ana", "editor"], ["ben", "viewer"]]),
    ledger: new Map<string, Role>([["qa", "admin"]]),
  }
  const calls: string[] = []
  await page.addInitScript(() => {
    localStorage.setItem("agent-fs-credentials", JSON.stringify([
      { id: "qa", name: "QA", endpoint: "http://fixture.test", apiKey: "fixture" },
    ]))
    localStorage.setItem("agent-fs-active-credential", "qa")
  })
  await page.route("http://fixture.test/**", async route => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname
    const forbidden = () => route.fulfill({ status: 403, json: { error: "PERMISSION_DENIED", message: "Requires admin" } })
    const memberMatch = path.match(/^\/orgs\/org\/drives\/([^/]+)\/members(?:\/([^/]+))?$/)

    if (path === "/auth/me") return route.fulfill({ json: { userId: "qa", email: "qa@example.test", displayName: "QA Admin", defaultOrgId: "org", defaultDriveId: "work" } })
    if (path === "/orgs") return route.fulfill({ json: { orgs: [{ id: "org", name: "QA org" }] } })
    if (path === "/health") return route.fulfill({ json: { ok: true, version: "test", features: ["drive-members", "drive-invites"] } })
    if (path === "/orgs/org/drives") {
      if (url.searchParams.get("scope") === "manageable") {
        const visible = drives.filter(d => orgAdmin || members[d.id].get("qa") === "admin")
        return route.fulfill({ json: { drives: visible.map(d => ({ id: d.id, name: d.name, isDefault: d.isDefault, myRole: members[d.id].get("qa") ?? null })) } })
      }
      return route.fulfill({ json: { drives: drives.filter(d => members[d.id].has("qa")) } })
    }
    if (path === "/orgs/org/members") {
      if (!orgAdmin) return forbidden()
      return route.fulfill({ json: { members: Object.values(people).map(p => ({ userId: p.userId, email: p.email, role: p.userId === "qa" ? "admin" : "viewer" })) } })
    }
    if (memberMatch) {
      const [, driveId, userId] = memberMatch
      const drive = members[driveId]
      // A drive admin who is not an org admin loses this endpoint with the role.
      if (!driveAdmin || (!orgAdmin && drive.get("qa") !== "admin")) return forbidden()
      const method = req.method()
      if (method === "GET") {
        return route.fulfill({ json: { members: [...drive].map(([id, role]) => ({ userId: id, email: people[id].email, role })) } })
      }
      if (method === "POST") {
        const { email, role } = req.postDataJSON()
        calls.push(`add ${driveId} ${email} ${role}`)
        const person = Object.values(people).find(p => p.email === email)
        if (!person) return route.fulfill({ status: 404, json: { error: "NOT_FOUND", message: "Not a member of this org" } })
        const created = !drive.has(person.userId)
        drive.set(person.userId, role)
        return route.fulfill({ status: created ? 201 : 200, json: { userId: person.userId, email, driveId, role, created } })
      }
      if (method === "PATCH") {
        const { role } = req.postDataJSON()
        calls.push(`role ${driveId} ${userId} ${role}`)
        drive.set(userId, role)
        return route.fulfill({ json: { ok: true } })
      }
      if (method === "DELETE") {
        calls.push(`remove ${driveId} ${userId}`)
        drive.delete(userId)
        return route.fulfill({ json: { ok: true } })
      }
    }
    if (path === "/orgs/org/ops") {
      const { op, driveId } = req.postDataJSON()
      switch (op) {
        case "drive-members":
          return route.fulfill({ json: { members: [...members[driveId ?? "work"].keys()].map(id => people[id]) } })
        case "ls": return route.fulfill({ json: { entries: [] } })
        case "comment-list": return route.fulfill({ json: { comments: [] } })
        case "comment-notification-list": return route.fulfill({ json: { notifications: [], unreadCount: 0 } })
        case "favorite-list": return route.fulfill({ json: { favorites: [] } })
      }
    }
    return route.abort()
  })
  return { members, calls }
}

const memberRow = (page: Page, email: string) => page.locator(`[data-member-email="${email}"]`)

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
})

test("the drive switcher and ⇧M open the active drive's Members page", async ({ page }) => {
  await installFixture(page)
  await page.goto("/file/~/org/work/")

  await page.locator("[data-drive-switcher]").click()
  await page.getByRole("menuitem", { name: /Members/ }).click()
  await expect(page).toHaveURL(/\/members\/~\/org\/work$/)
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible()

  await page.goto("/file/~/org/work/")
  await page.locator("body").press("Shift+M")
  await expect(page).toHaveURL(/\/members\/~\/org\/work$/)

  await page.locator("body").press("?")
  await expect(page.getByRole("dialog").getByText("Drive members")).toBeVisible()
})

test("an org admin adds an org member as editor, changes them to viewer, and removes them", async ({ page }) => {
  const { members, calls } = await installFixture(page)
  await page.goto("/members/~/org/ledger")

  const form = page.getByRole("form", { name: "Add member" })
  await expect(form.getByText("2 org members are not on this drive yet.")).toBeVisible()
  await form.getByLabel("Email").fill("ana@example.test")
  await form.getByLabel("Role").selectOption("editor")
  await form.getByRole("button", { name: "Add" }).click()

  const ana = memberRow(page, "ana@example.test")
  await expect(ana.getByLabel("Role for ana@example.test")).toHaveValue("editor")
  await expect(form.getByLabel("Email")).toHaveValue("")

  await ana.getByLabel("Role for ana@example.test").selectOption("viewer")
  await expect.poll(() => members.ledger.get("ana")).toBe("viewer")

  await ana.getByRole("button", { name: "Remove ana@example.test" }).click()
  await expect(ana).toHaveCount(0)

  expect(calls).toEqual(["add ledger ana@example.test editor", "role ledger ana viewer", "remove ledger ana"])
})

test("the only admin cannot be demoted or removed", async ({ page }) => {
  const { calls } = await installFixture(page)
  await page.goto("/members/~/org/ledger")

  const me = memberRow(page, "qa@example.test")
  await expect(me.getByLabel("Role for qa@example.test")).toBeDisabled()
  await expect(me.getByRole("button", { name: "Remove qa@example.test" })).toBeDisabled()
  await expect(me.getByText(/Only admin of this drive/)).toBeVisible()
  expect(calls).toEqual([])
})

test("removing yourself asks inline first and sends nothing on cancel", async ({ page }) => {
  const { members, calls } = await installFixture(page)
  members.ledger.set("ana", "admin")
  await page.goto("/members/~/org/ledger")

  const me = memberRow(page, "qa@example.test")
  await me.getByRole("button", { name: "Remove qa@example.test" }).click()
  await expect(me.getByRole("alert")).toContainText("Remove yourself?")
  await me.getByRole("button", { name: "Cancel" }).click()
  await expect(me.getByRole("alert")).toHaveCount(0)
  expect(calls).toEqual([])

  await me.getByRole("button", { name: "Remove qa@example.test" }).click()
  await me.getByRole("button", { name: "Remove me" }).click()
  await expect(me).toHaveCount(0)
  expect(calls).toEqual(["remove ledger qa"])
})

test("a server error on add shows under the form", async ({ page }) => {
  await installFixture(page, { orgAdmin: false })
  await page.goto("/members/~/org/ledger")

  const form = page.getByRole("form", { name: "Add member" })
  await expect(form.getByText("They must already be in the org.", { exact: false })).toBeVisible()
  await form.getByLabel("Email").fill("stranger@example.test")
  await form.getByRole("button", { name: "Add" }).click()
  await expect(form.getByRole("alert")).toHaveText("Not a member of this org")
})

test("a member who is not an admin gets a read-only list", async ({ page }) => {
  await installFixture(page, { orgAdmin: false, driveAdmin: false })
  await page.goto("/members/~/org/work")

  await expect(page.getByText("Only drive admins and org admins can change who is on this drive.")).toBeVisible()
  const list = page.getByRole("list", { name: "Drive members" })
  await expect(list.getByRole("listitem")).toHaveCount(3)
  await expect(list.getByText("Ana", { exact: true })).toBeVisible()
  await expect(page.getByRole("form", { name: "Add member" })).toHaveCount(0)
  await expect(page.getByRole("combobox")).toHaveCount(0)
  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0)
})

test("Add member refuses someone already on the drive instead of changing their role", async ({ page }) => {
  const { members, calls } = await installFixture(page)
  await page.goto("/members/~/org/ledger")

  // The sole admin's email with the default Viewer role: the upsert would demote them.
  const form = page.getByRole("form", { name: "Add member" })
  await form.getByLabel("Email").fill("QA@example.test")
  await form.getByRole("button", { name: "Add" }).click()
  await expect(form.getByRole("alert")).toHaveText("qa@example.test is already on this drive as admin. Change their role in the list below.")
  await expect(memberRow(page, "qa@example.test").getByLabel("Role for qa@example.test")).toHaveValue("admin")
  expect(members.ledger.get("qa")).toBe("admin")
  expect(calls).toEqual([])
})

test("a pending self-removal does not follow you to another drive", async ({ page }) => {
  const { members, calls } = await installFixture(page)
  members.work.set("ana", "admin")
  members.ledger.set("ana", "admin")
  await page.goto("/members/~/org/ledger")
  await expect(memberRow(page, "qa@example.test")).toBeVisible()

  const pickDrive = async (from: string, to: string) => {
    await page.getByRole("button", { name: `Drive: ${from}` }).click()
    await page.getByRole("menuitem", { name: to }).click()
    await expect(page).toHaveURL(new RegExp(`/members/~/org/${to}$`))
  }

  await pickDrive("ledger", "work")
  const me = memberRow(page, "qa@example.test")
  await expect(memberRow(page, "ben@example.test")).toBeVisible()
  await me.getByRole("button", { name: "Remove qa@example.test" }).click()
  await expect(me.getByRole("alert")).toContainText("Remove yourself?")

  // Back to the cached drive: the confirmation opened on work must be gone.
  await pickDrive("work", "ledger")
  await expect(memberRow(page, "ben@example.test")).toHaveCount(0)
  await expect(me.getByRole("alert")).toHaveCount(0)
  await expect(me.getByRole("button", { name: "Remove me" })).toHaveCount(0)
  expect(calls).toEqual([])
})

test("a drive admin who demotes themselves drops to the read-only list", async ({ page }) => {
  const { members, calls } = await installFixture(page, { orgAdmin: false })
  members.ledger.set("ana", "admin")
  await page.goto("/members/~/org/ledger")

  const me = memberRow(page, "qa@example.test")
  await me.getByLabel("Role for qa@example.test").selectOption("viewer")
  await me.getByRole("button", { name: "Change my role" }).click()

  await expect(page.getByText("Only drive admins and org admins can change who is on this drive.")).toBeVisible()
  await expect(page.getByRole("form", { name: "Add member" })).toHaveCount(0)
  await expect(page.getByRole("combobox")).toHaveCount(0)
  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0)
  expect(calls).toEqual(["role ledger qa viewer"])
})
