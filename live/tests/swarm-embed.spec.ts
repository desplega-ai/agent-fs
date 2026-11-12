import { expect, test, type Page } from "@playwright/test"

const SHEET_ID = "7f1c2a4e-9b3d-4e61-8a0f-5c2d1e3b4a67"
const BOARD_ID = "0d9b6e2a-3c41-4f8e-b7a5-91e2c6f0d384"
const SHEET_TAG = `<SwarmSheet id="${SHEET_ID}" tab="Q4 plan" />`
const BOARD_TAG = `<SwarmBoard id="${BOARD_ID}" height="400" />`
const HOSTILE_TAG = `<SwarmSheet id="${SHEET_ID}" onload="window.__swarmFlag = 1" />`

const REPORT = [
  "# Q4 report",
  "",
  "Numbers first.",
  "",
  SHEET_TAG,
  "",
  "Then the plan board.",
  "",
  BOARD_TAG,
  "",
  "Closing notes.",
  "",
].join("\n")

interface Fixture {
  writes: string[]
}

/** Production app shell against deterministic API fixtures; no live account. */
async function installFixture(page: Page, initial: string, swarmUrl: string | null): Promise<Fixture> {
  const state: Fixture = { writes: [] }
  let version = 1
  let content = initial
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
    else if (url.pathname === "/orgs") json = { orgs: [{ id: "org", name: "QA", role: "admin" }] }
    else if (url.pathname === "/orgs/org/public") json = { swarmUrl }
    else if (url.pathname.endsWith("/drives")) json = { drives: [{ id: "drive", name: "QA", orgId: "org", role: "admin" }] }
    else if (url.pathname === "/health") json = { ok: true, version: "test", features: [] }
    else if (url.pathname === "/content") return route.fulfill({ body: content, contentType: "text/markdown" })
    else if (url.pathname.endsWith("/ops")) {
      const body = route.request().postDataJSON()
      switch (body.op) {
        case "ls": json = { entries: [{ name: "notes.md", type: "file", size: content.length, modifiedAt: "2026-10-02T10:00:00.000Z" }] }; break
        case "stat": json = { path: "/notes.md", size: content.length, contentType: "text/markdown", author: "qa", currentVersion: version, createdAt: "2026-10-01", modifiedAt: "2026-10-02", isDeleted: false }; break
        case "signed-url": json = { url: "http://fixture.test/content?path=/notes.md" }; break
        case "write":
          state.writes.push(body.content)
          content = body.content
          version += 1
          json = { version, path: "/notes.md", size: content.length }
          break
        case "log": json = { versions: [] }; break
        case "comment-list": json = { comments: [] }; break
        case "comment-notification-list": json = { notifications: [], unreadCount: 0 }; break
        default: return route.abort()
      }
    } else return route.abort()
    await route.fulfill({ json })
  })
  return state
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
})

test("the viewer shows a placeholder for each embed and links to the swarm", async ({ page }) => {
  await installFixture(page, REPORT, "https://swarm.example.test/")
  await page.goto("/file/~/org/drive/notes.md")
  const sheet = page.locator('[data-swarm-embed="sheet"]')
  const board = page.locator('[data-swarm-embed="board"]')
  await expect(sheet).toContainText("Swarm sheet · renders live in the swarm dashboard.")
  await expect(board).toContainText("Swarm board · renders live in the swarm dashboard.")
  const link = sheet.getByRole("link", { name: "Open in swarm" })
  await expect(link).toHaveAttribute("href", "https://swarm.example.test/file/~/org/drive/notes.md")
  await expect(link).toHaveAttribute("rel", "noopener noreferrer")
  // The tag text itself is gone from the page.
  await expect(page.getByText("<SwarmSheet", { exact: false })).toHaveCount(0)
  await page.screenshot({ path: "test-results/swarm-embed-viewer.png" })
})

test("an org without a swarm URL gets the placeholder and no link", async ({ page }) => {
  await installFixture(page, REPORT, null)
  await page.goto("/file/~/org/drive/notes.md")
  await expect(page.locator("[data-swarm-embed]")).toHaveCount(2)
  await expect(page.getByRole("link", { name: "Open in swarm" })).toHaveCount(0)
})

test("a hostile tag shows as text and runs nothing", async ({ page }) => {
  await installFixture(page, `# Hostile\n\n${SHEET_TAG}\n\n${HOSTILE_TAG}\n`, "https://swarm.example.test")
  await page.goto("/file/~/org/drive/notes.md")
  await expect(page.locator("[data-swarm-embed]")).toHaveCount(1)
  await expect(page.getByText(HOSTILE_TAG)).toBeVisible()
  expect(await page.evaluate(() => (window as { __swarmFlag?: number }).__swarmFlag)).toBeUndefined()
  await page.screenshot({ path: "test-results/swarm-embed-hostile.png" })
})

test("a prose edit in the rich editor saves both tag lines byte-for-byte", async ({ page }) => {
  const state = await installFixture(page, REPORT, "https://swarm.example.test")
  await page.goto("/file/~/org/drive/notes.md")
  await page.getByRole("button", { name: "Edit file" }).click()
  await page.getByRole("button", { name: "Rich editor" }).click()
  const editor = page.locator(".mdxeditor-root-contenteditable")
  await expect(editor.locator("[data-swarm-embed]")).toHaveCount(2)
  await expect(page.getByText("Rich editor cannot parse this file")).toHaveCount(0)
  await page.screenshot({ path: "test-results/swarm-embed-rich.png" })

  await page.getByText("Closing notes.").click()
  await page.keyboard.press("End")
  await page.keyboard.type(" Done.")
  await page.getByRole("button", { name: /^Save/ }).click()
  await expect(page.getByText(/^Saved \(v2\)/)).toBeVisible()
  expect(state.writes).toEqual([REPORT.replace("Closing notes.\n", "Closing notes. Done.\n")])
  await expect(page.getByText("Rich editor reformatted this file")).toHaveCount(0)
})

test("a file with a hostile tag still opens in the source editor", async ({ page }) => {
  await installFixture(page, `# Hostile\n\n${HOSTILE_TAG}\n`, "https://swarm.example.test")
  await page.goto("/file/~/org/drive/notes.md")
  await page.getByRole("button", { name: "Edit file" }).click()
  await page.getByRole("button", { name: "Rich editor" }).click()
  await expect(page.getByText("Rich editor cannot parse this file")).toBeVisible()
  await expect(page.locator(".monaco-editor")).toBeVisible()
})
