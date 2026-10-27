import { expect, test, type Page } from "@playwright/test"
import { ENDPOINT, InviteFixture } from "./support/invite-fixture"

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
})

/** Opens the Invite dialog from the Members page of `driveId`. */
async function openInviteDialog(page: Page, driveId: string) {
  await page.goto(`/members/~/org/${driveId}`)
  await page.getByRole("button", { name: "Invite people" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: "Invite people" })).toBeVisible()
  return dialog
}

async function acceptLinkFrom(page: Page) {
  const link = await page.getByLabel("Accept link", { exact: true }).inputValue()
  expect(link).toMatch(/\/invite\/[A-Za-z0-9_-]{43}\?apiUrl=/)
  return link
}

test("an admin invites a new email to two of three drives and the invitee lands in the first", async ({ page, browser }) => {
  const server = new InviteFixture()
  await server.signIn(page, "admin-key")
  await server.install(page)

  // Opened from `work`, so it starts checked; `ledger` stays unchecked.
  const dialog = await openInviteDialog(page, "work")
  await expect(dialog.getByRole("checkbox", { name: "work" })).toBeChecked()
  await expect(dialog.getByRole("checkbox", { name: "context" })).not.toBeChecked()
  await expect(dialog.getByLabel("Org role")).toHaveValue("viewer")
  await expect(dialog.getByText("The org role does not grant file access by itself.")).toBeVisible()

  await dialog.getByLabel("Who").fill("New@Example.test")
  await dialog.getByRole("checkbox", { name: "context" }).check()
  await dialog.getByLabel("Role on context").selectOption("editor")
  await dialog.getByRole("button", { name: "Invite", exact: true }).click()

  await expect(dialog.getByText("new@example.test has no account yet")).toBeVisible()
  await expect(dialog.getByText(/^Expires /)).toBeVisible()
  const link = await acceptLinkFrom(page)
  expect(server.calls).toEqual(["invite new@example.test viewer work:viewer,context:editor"])

  // A browser with nothing saved opens the link.
  const context = await browser.newContext()
  const invitee = await context.newPage()
  await server.install(invitee)
  await invitee.goto(link)

  await expect(invitee.getByRole("heading", { name: "Join QA org" })).toBeVisible()
  await expect(invitee.getByText("QA Admin")).toBeVisible()
  const drives = invitee.getByRole("list", { name: "Drives in this invite" })
  await expect(drives.getByRole("listitem")).toHaveCount(2)
  await expect(invitee.getByLabel("Your email")).toHaveValue("new@example.test")
  await expect(invitee.getByLabel("Your email")).toBeDisabled()

  await invitee.getByRole("button", { name: "Create account and accept" }).click()
  await expect(invitee).toHaveURL(/\/file\/~\/org\/work\/$/)

  await invitee.locator("[data-drive-switcher]").click()
  const items = invitee.getByRole("menuitem")
  await expect(items.filter({ hasText: "work" })).toHaveCount(1)
  await expect(items.filter({ hasText: "context" })).toHaveCount(1)
  await expect(items.filter({ hasText: "ledger" })).toHaveCount(0)

  const created = server.userByEmail("new@example.test")!
  expect([...server.driveMembers.work]).toContainEqual([created.id, "viewer"])
  expect([...server.driveMembers.context]).toContainEqual([created.id, "editor"])
  expect(server.driveMembers.ledger.has(created.id)).toBe(false)
  await context.close()

  // The accepted invite leaves the pending list.
  await page.goto("/members/~/org/work")
  await expect(page.getByText("No pending invites.")).toBeVisible()
})

test("an expired link and a revoked link show the same message", async ({ page, browser }) => {
  const server = new InviteFixture()
  await server.signIn(page, "admin-key")
  await server.install(page)

  const dialog = await openInviteDialog(page, "work")
  await dialog.getByLabel("Who").fill("late@example.test")
  await dialog.getByRole("button", { name: "Invite", exact: true }).click()
  const expiredLink = await acceptLinkFrom(page)
  await dialog.getByRole("button", { name: "Invite another" }).click()
  await dialog.getByLabel("Who").fill("gone@example.test")
  await dialog.getByRole("checkbox", { name: "work" }).check()
  await dialog.getByRole("button", { name: "Invite", exact: true }).click()
  const revokedLink = await acceptLinkFrom(page)
  await dialog.getByRole("button", { name: "Done" }).click()

  const pending = page.getByRole("list", { name: "Pending invites" })
  await expect(pending.getByRole("listitem")).toHaveCount(2)
  await pending.locator('[data-invite-email="gone@example.test"]').getByRole("button", { name: /Revoke invite/ }).click()
  await expect(pending.getByRole("listitem")).toHaveCount(1)
  server.expire(new URL(expiredLink).pathname.split("/").pop()!)

  const messages: string[] = []
  const context = await browser.newContext()
  for (const link of [expiredLink, revokedLink]) {
    const stranger = await context.newPage()
    await server.install(stranger)
    await stranger.goto(link)
    await expect(stranger.getByRole("heading", { name: "This invite link doesn't work" })).toBeVisible()
    messages.push(await stranger.getByRole("alert").innerText())
    await expect(stranger.getByRole("button", { name: /accept/i })).toHaveCount(0)
  }
  expect(messages[0]).toBe("Ask the person who invited you for a new link.")
  expect(messages[1]).toBe(messages[0])
  await context.close()
})

test("Copy link on a pending invite issues a new link and the old one stops working", async ({ page, browser }) => {
  const server = new InviteFixture()
  await server.signIn(page, "admin-key")
  await server.install(page)

  const dialog = await openInviteDialog(page, "ledger")
  await dialog.getByLabel("Who").fill("later@example.test")
  await dialog.getByRole("button", { name: "Invite", exact: true }).click()
  const first = await acceptLinkFrom(page)
  await dialog.getByRole("button", { name: "Done" }).click()

  const row = page.locator('[data-invite-email="later@example.test"]')
  await expect(row).toContainText("ledger (viewer)")
  await row.getByRole("button", { name: "Copy link for later@example.test" }).click()
  const second = await row.getByLabel("Accept link for later@example.test", { exact: true }).inputValue()
  expect(second).not.toBe(first)
  expect(server.calls.filter((c) => c.startsWith("invite"))).toEqual([
    "invite later@example.test viewer ledger:viewer",
    "invite later@example.test viewer ledger:viewer",
  ])

  const context = await browser.newContext()
  const oldPage = await context.newPage()
  await server.install(oldPage)
  await oldPage.goto(first)
  await expect(oldPage.getByRole("heading", { name: "This invite link doesn't work" })).toBeVisible()
  const newPage = await context.newPage()
  await server.install(newPage)
  await newPage.goto(second)
  await expect(newPage.getByRole("heading", { name: "Join QA org" })).toBeVisible()
  await context.close()
})

test("an email already in the org offers add-to-drives and leaves their org role alone", async ({ page }) => {
  const server = new InviteFixture()
  await server.signIn(page, "admin-key")
  await server.install(page)

  const dialog = await openInviteDialog(page, "ledger")
  await dialog.getByLabel("Who").fill("ANA@example.test")
  await expect(dialog.getByRole("status")).toContainText("ana@example.test is already in the org as editor")
  await expect(dialog.getByLabel("Org role")).toHaveCount(0)
  await dialog.getByLabel("Role on ledger").selectOption("editor")
  await dialog.getByRole("button", { name: "Add to drives" }).click()

  await expect(dialog.getByText("Added ana@example.test")).toBeVisible()
  await expect(dialog.getByText("Drives: ledger (editor).")).toBeVisible()
  // No org invite was sent, so Ana is still an org editor.
  expect(server.calls).toEqual(["add ledger ana@example.test editor"])
  expect(server.orgMembers.get("ana")).toBe("editor")
})

test("an existing account without a pending invite is added at once", async ({ page }) => {
  const server = new InviteFixture()
  const lone = server.userByEmail("ana@example.test")!
  server.orgMembers.delete(lone.id)
  server.driveMembers.work.delete(lone.id)
  await server.signIn(page, "admin-key")
  await server.install(page)

  const dialog = await openInviteDialog(page, "context")
  await dialog.getByLabel("Who").fill("ana@example.test")
  await dialog.getByLabel("Org role").selectOption("editor")
  await dialog.getByRole("button", { name: "Invite", exact: true }).click()

  await expect(dialog.getByText("Added ana@example.test")).toBeVisible()
  await expect(dialog.getByLabel("Accept link", { exact: true })).toHaveCount(0)
  expect(server.calls).toEqual(["invite ana@example.test editor context:viewer"])
})

test("signed in as another email: says so and offers the account switcher", async ({ page }) => {
  const server = new InviteFixture()
  const invite = await (async () => {
    server.invites.push({
      id: "inv-1",
      email: "new@example.test",
      orgRole: "viewer",
      drives: [{ driveId: "ledger", role: "viewer" }],
      token: "T".repeat(43),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      revoked: false,
      accepted: false,
    })
    return server.invites[0]
  })()
  await server.signIn(page, "ana-key", "Ana")
  await server.install(page)
  await page.goto(`/invite/${invite.token}?apiUrl=${encodeURIComponent(ENDPOINT)}`)

  await expect(page.getByRole("alert")).toContainText("This invite is for new@example.test, but you're signed in as ana@example.test.")
  await expect(page.getByRole("button", { name: /^Accept$/ })).toHaveCount(0)
  await expect(page.locator("[data-slot=dropdown-menu-trigger]")).toBeVisible()
  await expect(page.getByRole("button", { name: "Connect with an API key" })).toBeVisible()
  expect(server.calls).toEqual([])
})

test("signed in with the matching email: Accept opens the first drive", async ({ page }) => {
  const server = new InviteFixture()
  const ana = server.userByEmail("ana@example.test")!
  server.orgMembers.delete(ana.id)
  server.driveMembers.work.delete(ana.id)
  server.invites.push({
    id: "inv-1",
    email: "ana@example.test",
    orgRole: "viewer",
    drives: [{ driveId: "ledger", role: "editor" }, { driveId: "context", role: "viewer" }],
    token: "A".repeat(43),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
    revoked: false,
    accepted: false,
  })
  await server.signIn(page, "ana-key", "Ana")
  await server.install(page)
  await page.goto(`/invite/${"A".repeat(43)}?apiUrl=${encodeURIComponent(ENDPOINT)}`)

  await expect(page.getByText("You're signed in as ana@example.test.")).toBeVisible()
  await page.getByRole("button", { name: /^Accept$/ }).click()
  await expect(page).toHaveURL(/\/file\/~\/org\/ledger\/$/)
  expect(server.driveMembers.ledger.get(ana.id)).toBe("editor")
})

test("the connect link goes back to the invite after signing in", async ({ page }) => {
  const server = new InviteFixture()
  server.invites.push({
    id: "inv-1",
    email: "ana@example.test",
    orgRole: "viewer",
    drives: [{ driveId: "ledger", role: "viewer" }],
    token: "B".repeat(43),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
    revoked: false,
    accepted: false,
  })
  await server.install(page)
  await page.goto(`/invite/${"B".repeat(43)}?apiUrl=${encodeURIComponent(ENDPOINT)}`)
  await page.getByRole("button", { name: "I already have an account" }).click()

  await expect(page).toHaveURL(/\/credentials\?/)
  await expect(page.getByLabel("Endpoint URL")).toHaveValue(ENDPOINT)
  await page.getByRole("textbox", { name: "API Key" }).fill("ana-key")
  await page.getByRole("button", { name: "Connect", exact: true }).click()

  await expect(page).toHaveURL(new RegExp(`/invite/${"B".repeat(43)}`))
  await expect(page.getByText("You're signed in as ana@example.test.")).toBeVisible()
})
