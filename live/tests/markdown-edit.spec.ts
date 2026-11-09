import { expect, test, type Page } from "@playwright/test"

// A long synthetic note with `<slug>`-style placeholders in prose, outside
// code spans: the pattern that made the rich editor refuse whole files.
function fixtureMarkdown(): string {
  const sections: string[] = ["# Loop notes", ""]
  for (let i = 1; i <= 40; i++) {
    sections.push(
      `## Step ${i}`,
      "",
      `Write the result to reports/<slug>/run-${i}.md and link it from the index page for <owner>, then check the next item in the queue before moving on.`,
      "",
      `- Item ${i}a`,
      `- Item ${i}b`,
      "",
    )
  }
  return sections.join("\n")
}

const FIXTURE = fixtureMarkdown()

interface Fixture {
  writes: string[]
}

/** Production app shell against deterministic API fixtures; no live account. */
async function installFixture(page: Page): Promise<Fixture> {
  const state: Fixture = { writes: [] }
  let version = 1
  let content = FIXTURE
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

const PARSE_ERROR = "Rich editor cannot parse this file"

async function openRichEditor(page: Page) {
  await page.goto("/file/~/org/drive/notes.md")
  await page.getByRole("button", { name: "Edit file" }).click()
  // Edit mode opens in the source editor unless the user picked rich before.
  await page.getByRole("button", { name: "Rich editor" }).click()
  const scroller = page.locator(".mdxeditor-root-contenteditable")
  await expect(scroller).toBeVisible()
  await expect(page.getByText("reports/<slug>/run-1.md", { exact: false })).toBeVisible()
  return scroller
}

const scrollTop = (scroller: ReturnType<Page["locator"]>) => scroller.evaluate(el => el.scrollTop)

async function expectToolbarUsable(page: Page) {
  const cancel = page.getByRole("button", { name: "Cancel" })
  await expect(cancel).toBeInViewport()
  await expect(page.getByRole("button", { name: /^Save/ })).toBeInViewport()
  await expect(page.getByRole("button", { name: "Source only" })).toBeInViewport()
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
})

test("rich editor opens a file with <slug> placeholders as literal text", async ({ page }) => {
  await installFixture(page)
  await openRichEditor(page)
  await expect(page.getByText(PARSE_ERROR)).toHaveCount(0)
  // The placeholder is text, never an element.
  await expect(page.locator(".mdxeditor-root-contenteditable slug, .mdxeditor-root-contenteditable owner")).toHaveCount(0)
  // Still in the rich editor, not the source fallback.
  await expect(page.locator(".monaco-editor")).toHaveCount(0)
  await page.screenshot({ path: "test-results/markdown-edit-rich-placeholders.png" })
})

test("rich editor scrolls with the wheel and the keyboard; the toolbar stays usable", async ({ page }) => {
  await installFixture(page)
  const scroller = await openRichEditor(page)
  expect(await scroller.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
  expect(await scrollTop(scroller)).toBe(0)

  await page.getByText("reports/<slug>/run-1.md", { exact: false }).hover()
  await page.mouse.wheel(0, 2000)
  await expect.poll(() => scrollTop(scroller)).toBeGreaterThan(1000)
  await expectToolbarUsable(page)

  await page.getByText("reports/<slug>/run-3.md", { exact: false }).click()
  await page.keyboard.press("Control+End")
  await expect(page.getByText("Item 40b")).toBeInViewport()
  await expect.poll(() => scrollTop(scroller)).toBeGreaterThan(5000)
  await expectToolbarUsable(page)

  await page.keyboard.press("Control+Home")
  await expect(page.getByRole("heading", { name: "Loop notes" })).toBeInViewport()
  await expect.poll(() => scrollTop(scroller)).toBeLessThan(100)
  await page.screenshot({ path: "test-results/markdown-edit-rich-scrolled.png" })
})

test("source editor scrolls with the wheel and the keyboard; the toolbar stays usable", async ({ page }) => {
  await installFixture(page)
  await openRichEditor(page)
  await page.getByRole("button", { name: "Source only" }).click()
  const lines = page.locator(".monaco-editor .lines-content")
  await expect(lines).toBeVisible()
  const top = () => lines.evaluate(el => parseFloat(getComputedStyle(el).top) || 0)
  expect(await top()).toBe(0)

  await page.locator(".monaco-editor .view-lines").hover()
  // Monaco caps the distance of one wheel event, so send several.
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 200)
  await expect.poll(top).toBeLessThan(-500)
  await expectToolbarUsable(page)

  await page.locator(".monaco-editor .view-lines").click()
  await page.keyboard.press("Control+End")
  await expect(page.locator(".monaco-editor .view-line", { hasText: "Item 40b" })).toBeInViewport()
  await expectToolbarUsable(page)
})

test("a save with no edits writes nothing", async ({ page }) => {
  const state = await installFixture(page)
  await openRichEditor(page)
  await expect(page.getByRole("button", { name: /^Save/ })).toBeDisabled()
  await page.getByText("reports/<slug>/run-1.md", { exact: false }).click()
  await page.keyboard.press("Control+s")
  await expect(page.getByText("No changes to save")).toBeVisible()
  await expect(page.getByText("Rich editor reformatted this file")).toHaveCount(0)
  expect(state.writes).toEqual([])
})

test("an edit saves the file with its placeholders unchanged", async ({ page }) => {
  const state = await installFixture(page)
  await openRichEditor(page)
  await page.getByText("Item 40b").click()
  await page.keyboard.press("End")
  await page.keyboard.type(" done")
  await page.getByRole("button", { name: /^Save/ }).click()
  await expect(page.getByText(/^Saved \(v2\)/)).toBeVisible()
  expect(state.writes).toEqual([FIXTURE.replace("- Item 40b\n", "- Item 40b done\n")])
  await expect(page.getByText(PARSE_ERROR)).toHaveCount(0)
})
