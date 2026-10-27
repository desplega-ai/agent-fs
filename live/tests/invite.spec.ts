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
  expect(link).toMatch(/\/invite\?apiUrl=[^#]+#[A-Za-z0-9_-]{43}$/)
  return link
}

const tokenOf = (link: string) => new URL(link).hash.slice(1)
const fragmentLink = (token: string) => `/invite?apiUrl=${encodeURIComponent(ENDPOINT)}#${token}`

/** A pending invite the fixture already holds, as if an admin had sent it earlier. */
function seedInvite(server: InviteFixture, email: string, token: string, drives = [{ driveId: "ledger", role: "viewer" as const }]) {
  server.invites.push({
    id: `inv-${server.invites.length + 1}`,
    email,
    orgRole: "viewer",
    drives,
    token,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
    revoked: false,
    accepted: false,
  })
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
  server.expire(tokenOf(expiredLink))

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

test("New link on a pending invite issues a new link and the old one stops working", async ({ page, browser }) => {
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
  await row.getByRole("button", { name: "New link for later@example.test" }).click()
  await row.getByRole("button", { name: "Make new link" }).click()
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
  seedInvite(server, "new@example.test", "T".repeat(43))
  await server.signIn(page, "ana-key", "Ana")
  await server.install(page)
  await page.goto(fragmentLink("T".repeat(43)))

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
  seedInvite(server, "ana@example.test", "A".repeat(43), [{ driveId: "ledger", role: "editor" }, { driveId: "context", role: "viewer" }])
  await server.signIn(page, "ana-key", "Ana")
  await server.install(page)
  await page.goto(fragmentLink("A".repeat(43)))

  await expect(page.getByText("You're signed in as ana@example.test.")).toBeVisible()
  await page.getByRole("button", { name: /^Accept$/ }).click()
  await expect(page).toHaveURL(/\/file\/~\/org\/ledger\/$/)
  expect(server.driveMembers.ledger.get(ana.id)).toBe("editor")
})

test("the connect link goes back to the invite after signing in", async ({ page }) => {
  const server = new InviteFixture()
  seedInvite(server, "ana@example.test", "B".repeat(43))
  await server.install(page)
  await page.goto(fragmentLink("B".repeat(43)))
  await page.getByRole("button", { name: "I already have an account" }).click()

  await expect(page).toHaveURL(/\/credentials\?/)
  // The token is not in the connect page's address; the accept page kept it for the tab.
  expect(page.url()).not.toContain("B".repeat(43))
  await expect(page.getByLabel("Endpoint URL")).toHaveValue(ENDPOINT)
  await page.getByRole("textbox", { name: "API Key" }).fill("ana-key")
  await page.getByRole("button", { name: "Connect", exact: true }).click()

  await expect(page).toHaveURL(/\/invite\?apiUrl=/)
  expect(page.url()).not.toContain("B".repeat(43))
  await expect(page.getByText("You're signed in as ana@example.test.")).toBeVisible()
})

// --- Review round 1: stale lookups, drive lists, link warnings, health, token handling ---

test("the form waits for the member list: a slow list keeps Invite disabled until it answers", async ({ page }) => {
  const server = new InviteFixture()
  server.membersDelayMs = 1500
  await server.signIn(page, "admin-key")
  await server.install(page)

  const dialog = await openInviteDialog(page, "work")
  await dialog.getByLabel("Who").fill("ana@example.test")
  await expect(dialog.getByText("Checking who is already in the org...")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Invite", exact: true })).toBeDisabled()
  expect(server.calls).toEqual([])

  // Once it answers, Ana is recognised as a member and the form switches to adding drives.
  await expect(dialog.getByRole("status")).toContainText("ana@example.test is already in the org as editor")
  await dialog.getByRole("checkbox", { name: "ledger" }).check()
  await expect(dialog.getByRole("button", { name: "Add to drives" })).toBeEnabled()
})

test("a failed member list pauses inviting, so an existing admin is never reset to viewer", async ({ page }) => {
  const server = new InviteFixture()
  const ana = server.userByEmail("ana@example.test")!
  server.orgMembers.set(ana.id, "admin")
  server.membersFail = true
  await server.signIn(page, "admin-key")
  await server.install(page)

  const dialog = await openInviteDialog(page, "work")
  await dialog.getByLabel("Who").fill("ana@example.test")
  await expect(dialog.getByRole("alert")).toContainText("Couldn't check who is already in the org")
  const invite = dialog.getByRole("button", { name: "Invite", exact: true })
  await expect(invite).toBeDisabled()
  await dialog.getByLabel("Who").press("Enter")
  expect(server.calls).toEqual([])
  expect(server.orgMembers.get(ana.id)).toBe("admin")

  server.membersFail = false
  await dialog.getByRole("button", { name: "Retry" }).click()
  await expect(dialog.getByRole("status")).toContainText("ana@example.test is already in the org as admin")
  await dialog.getByRole("checkbox", { name: "ledger" }).check()
  await expect(dialog.getByRole("button", { name: "Add to drives" })).toBeEnabled()
})

test("someone who joins the org while the form is open is not re-invited", async ({ page }) => {
  const server = new InviteFixture()
  const joiner = server.register("joiner@example.test")
  await server.signIn(page, "admin-key")
  await server.install(page)

  const dialog = await openInviteDialog(page, "work")
  await dialog.getByLabel("Who").fill("joiner@example.test")
  await expect(dialog.getByRole("button", { name: "Invite", exact: true })).toBeEnabled()

  // Another admin adds them as an admin after this form last read the list.
  server.orgMembers.set(joiner.id, "admin")
  await dialog.getByRole("button", { name: "Invite", exact: true }).click()

  await expect(dialog.getByRole("alert")).toContainText("changed while you were filling this in")
  expect(server.calls).toEqual([])
  expect(server.orgMembers.get(joiner.id)).toBe("admin")
  // The list was re-read, so the form now offers the drive-only path.
  await expect(dialog.getByRole("button", { name: "Add to drives" })).toBeVisible()
})

test("adding an org member keeps the role they already have on a drive", async ({ page }) => {
  const server = new InviteFixture()
  const ana = server.userByEmail("ana@example.test")!
  server.driveMembers.ledger.set(ana.id, "admin")
  await server.signIn(page, "admin-key")
  await server.install(page)

  // Opened from ledger, so ledger starts checked; Ana is already its admin.
  const dialog = await openInviteDialog(page, "ledger")
  await dialog.getByLabel("Who").fill("ana@example.test")
  await expect(dialog.getByText("Already admin")).toBeVisible()
  await expect(dialog.getByRole("checkbox", { name: "ledger" })).toBeDisabled()
  await expect(dialog.getByRole("checkbox", { name: "ledger" })).not.toBeChecked()
  await expect(dialog.getByText("Already editor")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Add to drives" })).toBeDisabled()

  await dialog.getByRole("checkbox", { name: "context" }).check()
  await dialog.getByRole("button", { name: "Add to drives" }).click()
  await expect(dialog.getByText("Drives: context (viewer).")).toBeVisible()
  expect(server.calls).toEqual(["add context ana@example.test viewer"])
  expect(server.driveMembers.ledger.get(ana.id)).toBe("admin")
  expect(server.driveMembers.work.get(ana.id)).toBe("editor")
})

test("a drive role that appears while the form is open is left as it is", async ({ page }) => {
  const server = new InviteFixture()
  const ana = server.userByEmail("ana@example.test")!
  await server.signIn(page, "admin-key")
  await server.install(page)

  const dialog = await openInviteDialog(page, "context")
  await dialog.getByLabel("Who").fill("ana@example.test")
  await expect(dialog.getByRole("checkbox", { name: "context" })).toBeChecked()
  await expect(dialog.getByRole("button", { name: "Add to drives" })).toBeEnabled()

  // Made admin of context by someone else after the form last read the drive.
  server.driveMembers.context.set(ana.id, "admin")
  await dialog.getByRole("button", { name: "Add to drives" }).click()

  await expect(dialog.getByText("ana@example.test is already on those drives")).toBeVisible()
  await expect(dialog.getByText("Left as they were: context (admin).")).toBeVisible()
  expect(server.calls).toEqual([])
  expect(server.driveMembers.context.get(ana.id)).toBe("admin")
})

test("New link refuses to run without a drive list, so no invite is revoked or stripped of its drives", async ({ page }) => {
  const server = new InviteFixture()
  seedInvite(server, "later@example.test", "L".repeat(43), [{ driveId: "ledger", role: "editor" }])
  server.manageableFail = true
  await server.signIn(page, "admin-key")
  await server.install(page)
  await page.goto("/members/~/org/work")

  const row = page.locator('[data-invite-email="later@example.test"]')
  // While the drive list is down the row names no drive as deleted.
  await expect(row).toContainText("… (editor)")
  await expect(row).not.toContainText("deleted drive")
  await row.getByRole("button", { name: "New link for later@example.test" }).click()
  await row.getByRole("button", { name: "Make new link" }).click()

  await expect(row.getByRole("alert")).toContainText("Drive list unavailable")
  expect(server.calls).toEqual([])
  expect(server.invites[0].revoked).toBe(false)
  expect(server.invites[0].drives).toEqual([{ driveId: "ledger", role: "editor" }])
})

test("New link is refused for someone who is already in the org", async ({ page }) => {
  const server = new InviteFixture()
  const ana = server.userByEmail("ana@example.test")!
  server.orgMembers.set(ana.id, "admin")
  seedInvite(server, "ana@example.test", "N".repeat(43))
  await server.signIn(page, "admin-key")
  await server.install(page)
  await page.goto("/members/~/org/work")

  const row = page.locator('[data-invite-email="ana@example.test"]')
  await row.getByRole("button", { name: "New link for ana@example.test" }).click()
  await row.getByRole("button", { name: "Make new link" }).click()

  await expect(row.getByRole("alert")).toContainText("already in the org as admin")
  expect(server.calls).toEqual([])
  expect(server.orgMembers.get(ana.id)).toBe("admin")
})

test.describe("touch", () => {
  test.use({ hasTouch: true })

  test("New link warns in the row before it revokes anything, and Cancel changes nothing", async ({ page }) => {
    const server = new InviteFixture()
    seedInvite(server, "later@example.test", "W".repeat(43))
    await server.signIn(page, "admin-key")
    await server.install(page)
    await page.goto("/members/~/org/work")

    const row = page.locator('[data-invite-email="later@example.test"]')
    await row.getByRole("button", { name: "New link for later@example.test" }).tap()
    const confirm = row.getByRole("group", { name: "Confirm new link for later@example.test" })
    await expect(confirm).toContainText("The link they have now stops working.")
    expect(server.calls).toEqual([])

    await confirm.getByRole("button", { name: "Cancel" }).tap()
    await expect(confirm).toHaveCount(0)
    expect(server.calls).toEqual([])

    await row.getByRole("button", { name: "New link for later@example.test" }).tap()
    await confirm.getByRole("button", { name: "Make new link" }).tap()
    await expect(row.getByLabel("Accept link for later@example.test", { exact: true })).toBeVisible()
    expect(server.calls).toEqual(["invite later@example.test viewer ledger:viewer"])
  })
})

test("invite controls hide when health stops answering, even though the last answer is cached", async ({ page }) => {
  const server = new InviteFixture()
  seedInvite(server, "later@example.test", "H".repeat(43))
  await page.clock.install()
  await server.signIn(page, "admin-key")
  await server.install(page)
  await page.goto("/members/~/org/work")
  const invitePeople = page.getByRole("button", { name: "Invite people" })
  await expect(invitePeople).toBeVisible()
  await expect(page.getByRole("list", { name: "Pending invites" })).toBeVisible()
  await page.locator("[data-org-switcher]").click()
  await expect(page.getByRole("menuitem", { name: "Invite people" })).toBeVisible()
  await page.keyboard.press("Escape")

  server.healthDown = true
  await page.clock.runFor(31_000)
  await expect(invitePeople).toHaveCount(0)
  await expect(page.getByRole("list", { name: "Pending invites" })).toHaveCount(0)
  // A one-org admin only has a menu for "Invite people"; without it the switcher is a plain label.
  await expect(page.locator("[data-org-switcher]")).toHaveCount(0)

  server.healthDown = false
  await page.clock.runFor(31_000)
  await expect(invitePeople).toBeVisible()
})

test("the accept page names the server before anything is registered", async ({ page }) => {
  const server = new InviteFixture()
  seedInvite(server, "new@example.test", "S".repeat(43))
  await server.install(page)
  await page.goto(fragmentLink("S".repeat(43)))

  await expect(page.getByTestId("invite-server")).toHaveText(ENDPOINT)
  await expect(page.getByText("You haven't used this server in this browser.")).toBeVisible()
  await expect(page.getByText("This creates an account for new@example.test on fixture.test.")).toBeVisible()
  // Nothing was registered by looking at the page.
  expect(server.userByEmail("new@example.test")).toBeUndefined()
  await expect(page.getByRole("button", { name: "Create account and accept" })).toBeVisible()
})

test("the accept token stays out of every request to the live host and out of the address bar", async ({ page }) => {
  const server = new InviteFixture()
  const token = "K".repeat(43)
  seedInvite(server, "new@example.test", token)
  const seen: { url: string; referer: string }[] = []
  page.on("request", (request) => seen.push({ url: request.url(), referer: request.headers()["referer"] ?? "" }))
  await server.install(page)
  await page.goto(fragmentLink(token))
  await expect(page.getByRole("heading", { name: "Join QA org" })).toBeVisible()

  const live = new URL(page.url()).origin
  const toLiveHost = seen.filter((r) => r.url.startsWith(live))
  expect(toLiveHost.length).toBeGreaterThan(0)
  expect(toLiveHost.filter((r) => r.url.includes(token) || r.referer.includes(token))).toEqual([])
  // Control: the API server does get the token, in the path it asked for.
  expect(seen.some((r) => r.url.startsWith(ENDPOINT) && r.url.includes(token))).toBe(true)

  expect(page.url()).toBe(`${live}/invite?apiUrl=${encodeURIComponent(ENDPOINT)}`)
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer")
  // A reload has no token in the URL; the tab kept it.
  await page.reload()
  await expect(page.getByRole("heading", { name: "Join QA org" })).toBeVisible()
})

test("a link issued before the fragment form still works and loses its token from the address bar", async ({ page }) => {
  const server = new InviteFixture()
  const token = "O".repeat(43)
  seedInvite(server, "new@example.test", token)
  await server.install(page)
  await page.goto(`/invite/${token}?apiUrl=${encodeURIComponent(ENDPOINT)}`)

  await expect(page.getByRole("heading", { name: "Join QA org" })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/invite\\?apiUrl=`))
  expect(page.url()).not.toContain(token)
  await page.getByRole("button", { name: "Create account and accept" }).click()
  await expect(page).toHaveURL(/\/file\/~\/org\/ledger\/$/)
})

test("opening the accept page with no token says so instead of guessing", async ({ page }) => {
  const server = new InviteFixture()
  await server.install(page)
  await page.goto(`/invite?apiUrl=${encodeURIComponent(ENDPOINT)}`)
  await expect(page.getByRole("heading", { name: "Open your invite link" })).toBeVisible()
})
