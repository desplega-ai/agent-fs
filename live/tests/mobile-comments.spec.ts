import { expect, test, type Page } from "@playwright/test"

const markdown = "# Notes\n\nFirst paragraph with some words to select.\n\nSecond paragraph."

// A phone: touch input, 390 px wide. The on-screen keyboard (and iOS
// scrolling the window to the focused field) cannot be emulated here.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

async function installFixture(page: Page, adds: unknown[]) {
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
    else if (url.pathname === "/orgs") json = { orgs: [{ id: "org", name: "QA" }] }
    else if (url.pathname.endsWith("/drives")) json = { drives: [{ id: "drive", name: "QA", orgId: "org" }] }
    else if (url.pathname === "/content") return route.fulfill({ body: markdown, contentType: "text/markdown" })
    else if (url.pathname.endsWith("/ops")) {
      const body = route.request().postDataJSON()
      switch (body.op) {
        case "stat": json = { path: body.path, size: markdown.length, contentType: "text/markdown", author: "qa", currentVersion: 1, createdAt: "2026-01-01", modifiedAt: "2026-01-01", isDeleted: false }; break
        case "signed-url": json = { url: `http://fixture.test/content?path=${body.path}` }; break
        case "comment-list": json = { comments: [] }; break
        case "comment-add":
          adds.push(body)
          json = { id: "c1", path: body.path, body: body.body, author: "qa", createdAt: "2026-10-28T12:00:00.000Z" }
          break
        case "comment-notification-list": json = { notifications: [], unreadCount: 0 }; break
        case "ls": json = { entries: [] }; break
        case "tree": json = { tree: [] }; break
        default: return route.abort()
      }
    } else if (url.pathname === "/health") json = { ok: true, version: "test", features: [] }
    else return route.abort()
    await route.fulfill({ json })
  })
}

/** A long-press-like selection: a touch, then the selection changes with no mouseup. */
async function touchSelect(page: Page, text: string) {
  const paragraph = page.locator("[data-markdown-scroll] p", { hasText: text })
  await paragraph.tap()
  return paragraph.evaluate((el, text) => {
    const node = el.firstChild as Text
    const start = node.data.indexOf(text)
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + text.length)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
    return range.getBoundingClientRect().bottom
  }, text)
}

test("a touch selection shows the Comment button below the selection handles", async ({ page }) => {
  await installFixture(page, [])
  await page.goto("/file/~/org/drive/notes.md")
  const bottom = await touchSelect(page, "some words")
  const button = page.getByRole("button", { name: "Comment", exact: true })
  await expect(button).toBeVisible()
  expect((await button.boundingBox())!.y).toBeGreaterThanOrEqual(bottom + 27)
})

test("the comment form is a bottom sheet on the visual viewport, with 16 px text, and stays put on scroll", async ({ page }, testInfo) => {
  const adds: Array<Record<string, unknown>> = []
  await installFixture(page, adds)
  await page.goto("/file/~/org/drive/notes.md")
  await touchSelect(page, "some words")
  await page.getByRole("button", { name: "Comment", exact: true }).tap()

  const textarea = page.getByPlaceholder("Add a comment...")
  await expect(textarea).toBeFocused()
  expect(await textarea.evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px")
  const sheet = page.locator("[data-comment-ui]").filter({ has: textarea })
  const box = async () => {
    const b = (await sheet.boundingBox())!
    return { left: Math.round(b.x), width: Math.round(b.width), bottom: Math.round(b.y + b.height) }
  }
  const vv = await page.evaluate(() => ({ width: Math.round(visualViewport!.width), bottom: Math.round(visualViewport!.offsetTop + visualViewport!.height) }))
  expect(await box()).toEqual({ left: 0, width: vv.width, bottom: vv.bottom })
  await page.screenshot({ path: testInfo.outputPath("mobile-sheet.png") })

  // Scrolling the document no longer re-glues the form to the selection.
  await page.locator("[data-markdown-scroll]").evaluate((el) => { el.style.paddingBottom = "2000px"; el.scrollBy(0, 300) })
  await page.waitForTimeout(200)
  expect(await box()).toEqual({ left: 0, width: vv.width, bottom: vv.bottom })

  await textarea.fill("From a phone")
  await page.getByRole("button", { name: "Send comment" }).tap()
  await expect.poll(() => adds.length).toBe(1)
  expect(adds[0]).toMatchObject({ body: "From a phone", quote: { exact: "some words" } })
})
