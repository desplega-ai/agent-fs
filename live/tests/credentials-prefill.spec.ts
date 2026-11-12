import { expect, test, type Page } from "@playwright/test"

/**
 * `/credentials?apiUrl=&apiKey=` pre-fills the Connect form; saving and
 * activating the credential waits for the Connect click. S1 serves the saved
 * account, S2 is the endpoint in the query. Every other request is aborted.
 */
const S1 = "http://s1.test"
const S2 = "http://s2.test"
const ORG_A = "org-a-0001"
const DRIVE_A = "drive-a-0001"

type Log = { s1: string[]; s2: string[] }

async function setup(page: Page): Promise<Log> {
  const log: Log = { s1: [], s2: [] }
  await page.addInitScript(
    ([endpoint, org, drive]) => {
      // Seed once per tab so the assertions read what the app wrote, not the seed.
      if (sessionStorage.getItem("seeded")) return
      sessionStorage.setItem("seeded", "1")
      localStorage.setItem(
        "agent-fs-credentials",
        JSON.stringify([{ id: "cred-a", name: "A", endpoint, apiKey: "af_dummy_a" }]),
      )
      localStorage.setItem("agent-fs-active-credential", "cred-a")
      localStorage.setItem("agent-fs-active-org", org)
      localStorage.setItem("agent-fs-active-drive", drive)
    },
    [S1, ORG_A, DRIVE_A] as const,
  )
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]).*/, async (route) => {
    const url = new URL(route.request().url())
    const which = url.origin === S1 ? "s1" : url.origin === S2 ? "s2" : null
    if (!which) return route.abort()
    log[which].push(`${route.request().method()} ${url.pathname}`)
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
    const p = url.pathname
    if (p === "/auth/me")
      return json({ id: `${which}-user`, email: `${which}@example.test`, defaultOrgId: `${which}-org`, defaultDriveId: `${which}-drive` })
    if (p === "/auth/orgs") return json({ orgs: [{ id: `${which}-org`, name: `${which} org`, role: "admin" }] })
    if (/^\/orgs\/[^/]+\/drives$/.test(p)) return json({ drives: [{ id: `${which}-drive`, name: "main", isDefault: true }] })
    return json({})
  })
  return log
}

const storage = (page: Page) =>
  page.evaluate(() => ({
    active: localStorage.getItem("agent-fs-active-credential"),
    creds: JSON.parse(localStorage.getItem("agent-fs-credentials") ?? "[]") as { id: string; endpoint: string }[],
  }))

const connectButton = (page: Page) => page.locator("form").getByRole("button", { name: "Connect", exact: true })
const linkNotice = (page: Page) => page.getByRole("status").filter({ hasText: "Filled in from your link." })

test("apiUrl and apiKey in the query pre-fill the form and change nothing until Connect", async ({ page }) => {
  const log = await setup(page)
  await page.goto(`/credentials?apiUrl=${encodeURIComponent(S2)}&apiKey=af_dummy`)
  await expect(page.locator("#endpoint")).toHaveValue(S2)
  await expect(page.locator("#apiKey")).toHaveValue("af_dummy")
  await expect(linkNotice(page)).toBeVisible()
  await expect(connectButton(page)).toBeFocused()
  // Leave time for anything that would submit on mount.
  await page.waitForTimeout(2500)

  const s = await storage(page)
  expect(s.active).toBe("cred-a")
  expect(s.creds.map((c) => c.endpoint)).toEqual([S1])
  expect(new URL(page.url()).pathname).toBe("/credentials")
  expect(log.s2).toEqual([])

  await connectButton(page).click()
  await expect(page).toHaveURL(/\/files/)
  const after = await storage(page)
  expect(after.creds.map((c) => c.endpoint)).toEqual([S1, S2])
  expect(after.active).toBe(after.creds[1].id)
})

test("/credentials without query params changes nothing and calls no endpoint", async ({ page }) => {
  const log = await setup(page)
  await page.goto("/credentials")
  await expect(connectButton(page)).toBeVisible()
  await expect(linkNotice(page)).toHaveCount(0)
  await page.waitForTimeout(1000)
  const s = await storage(page)
  expect(s.active).toBe("cred-a")
  expect(s.creds.map((c) => c.endpoint)).toEqual([S1])
  expect(log.s2).toEqual([])
})

test("a typed endpoint and key save and activate the new credential on Connect", async ({ page }) => {
  const log = await setup(page)
  await page.goto("/credentials")
  await page.locator("#endpoint").fill(S2)
  await page.locator("#apiKey").fill("af_dummy")
  await connectButton(page).click()
  await expect(page).toHaveURL(/\/files/)
  const s = await storage(page)
  expect(s.creds.map((c) => c.endpoint)).toEqual([S1, S2])
  expect(s.active).toBe(s.creds[1].id)
  expect(log.s2).toContain("GET /auth/me")
})

test("editing a field filled from the link hides the link notice", async ({ page }) => {
  await setup(page)
  await page.goto(`/credentials?apiUrl=${encodeURIComponent(S2)}&apiKey=af_dummy`)
  await expect(linkNotice(page)).toBeVisible()
  await page.locator("#endpoint").fill(S1)
  await expect(linkNotice(page)).toHaveCount(0)
})
