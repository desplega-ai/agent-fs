import { expect, test, type Page } from "@playwright/test"

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#4f46e5"/></svg>'
const markdown = [
  "# Lightbox",
  "```mermaid\ngraph TD\n  A[Start] --> B[Finish]\n```",
  "![chart](http://fixture.test/chart.svg)",
].join("\n\n")
// 1x1 PNG. A backend without presigned URLs (local storage) answers `signed-url`
// with an `app` link, so the viewer reads the image through the raw route into a
// `blob:` URL whose last path segment is a UUID.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64")
const localMarkdown = "# Local\n\n![pic](../pic.png)"

// Production app shell against deterministic API fixtures; no live account.
async function installFixture(page: Page, diagramComment = false) {
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
    else if (url.pathname.endsWith("/members")) json = { members: [] }
    else if (url.pathname === "/content") {
      const body = url.searchParams.get("path") === "docs/local.md" ? localMarkdown : markdown
      return route.fulfill({ body, contentType: "text/plain" })
    }
    else if (url.pathname === "/orgs/org/drives/drive/files/pic.png/raw") return route.fulfill({ body: png, contentType: "image/png" })
    else if (url.pathname === "/chart.svg") return route.fulfill({ body: svg, contentType: "image/svg+xml" })
    else if (url.pathname.endsWith("/ops")) {
      const { op, path } = route.request().postDataJSON()
      switch (op) {
        case "stat": json = { path, size: markdown.length, contentType: "text/markdown", author: "qa", currentVersion: 1, createdAt: "2026-01-01", modifiedAt: "2026-01-01", isDeleted: false }; break
        case "signed-url":
          json = path === "pic.png"
            ? { url: "http://fixture.test/file/~/org/drive/pic.png", kind: "app" }
            : { url: `http://fixture.test/content?path=${path}` }
          break
        case "comment-list": json = { comments: diagramComment ? [{
          id: "diagram-comment", path: "lightbox.md", body: "Review this diagram",
          author: "qa", resolved: false, replyCount: 0, replies: [],
          lineStart: 3, lineEnd: 6, fileVersion: 1,
          createdAt: "2026-01-01", updatedAt: "2026-01-01",
        }, ...[
          { id: "text-comment", body: "Review this heading", lineStart: 1, lineEnd: 1 },
          { id: "image-comment", body: "Review this image", lineStart: 8, lineEnd: 8 },
        ].map(comment => ({ ...comment, path: "lightbox.md", author: "qa", resolved: false,
          replyCount: 0, replies: [], fileVersion: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" }))] : [] }; break
        case "comment-notification-list": json = { notifications: [], unreadCount: 0 }; break
        case "ls": json = { entries: [] }; break
        case "tree": json = { tree: [] }; break
        // Side panels degrade gracefully; these tests only need the viewer.
        default: return route.abort()
      }
    } else if (url.pathname === "/health") json = { status: "ok" }
    else throw new Error(`Unexpected request: ${url}`)
    await route.fulfill({ json })
  })
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await installFixture(page)
  await page.goto("/file/~/org/drive/lightbox.md")
})

test("an enlarged mermaid diagram renders again after close and reopen", async ({ page }) => {
  const expand = page.getByRole("button", { name: "Expand diagram" })
  await expect(expand).toBeEnabled()
  const dialog = page.getByRole("dialog")

  for (let i = 1; i <= 3; i++) {
    await test.step(`open ${i}`, async () => {
      await page.locator(".group").filter({ has: expand }).hover()
      await expand.click()
      await expect(dialog.locator("svg").filter({ hasText: "Start" })).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(dialog).toHaveCount(0)
    })
  }
})

test("an enlarged svg image renders again after close and reopen", async ({ page }) => {
  const inline = page.locator('img[alt="chart"]')
  await expect(inline).toBeVisible()
  const dialog = page.getByRole("dialog")

  for (let i = 1; i <= 3; i++) {
    await test.step(`open ${i}`, async () => {
      await inline.first().click()
      const enlarged = dialog.locator('img[alt="chart"]')
      await expect(enlarged).toBeVisible()
      await expect.poll(() => enlarged.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
      await dialog.getByRole("button", { name: "Close" }).click()
      await expect(dialog).toHaveCount(0)
    })
  }
})

test("an embedded image read through the raw route downloads under its drive name", async ({ page }) => {
  await page.goto("/file/~/org/drive/docs/local.md")
  const inline = page.locator('img[alt="pic"]')
  await expect(inline).toHaveAttribute("src", /^blob:/)
  await inline.click()

  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText("pic.png", { exact: true })).toBeVisible()
  const download = page.waitForEvent("download")
  await dialog.getByRole("button", { name: "Download" }).click()
  expect((await download).suggestedFilename()).toBe("pic.png")
})

// Comb saves the fenced diagram's source lines, without a rendered-text quote.
test("a diagram comment from Comb resolves by source lines instead of showing anchor lost", async ({ page }) => {
  await installFixture(page, true)
  await page.goto("/file/~/org/drive/lightbox.md")
  await expect(page.getByText("Review this diagram", { exact: true })).toBeVisible()
  await expect(page.getByText("L3-6", { exact: true })).toBeVisible()
  await expect(page.getByText("anchor lost", { exact: true })).toHaveCount(0)
  const diagram = page.locator('[data-line-start="3"][data-line-end="6"]')
  await expect(diagram.locator("svg").filter({ hasText: "Start" })).toBeVisible()
})

// Textless diagram/image blocks can share a text offset but have different lines.
test("comment labels scroll and flash text, diagrams and images, and cards highlight only their target", async ({ page }) => {
  await installFixture(page, true)
  await page.goto("/file/~/org/drive/lightbox.md")
  await expect(page.getByRole("button", { name: "Expand diagram" })).toBeEnabled()
  // Leave the sidebar visible while putting the diagram and image below the fold.
  await page.addStyleTag({ content: '.prose h1 { margin-bottom: 1200px; }' })
  const diagram = page.locator('[data-line-start="3"][data-line-end="6"]')
  const image = page.locator('[data-line-start="8"][data-line-end="8"]')
  await expect(diagram).not.toBeInViewport()
  for (const [label, target, other] of [
    ["L3-6", diagram, image],
    ["L8", image, diagram],
    ["L1", page.locator('[data-line-start="1"]'), diagram],
  ] as const) {
    await page.getByText(label, { exact: true }).hover()
    await expect.soft(target).toHaveClass(/comment-pulse/)
    await expect(other).not.toHaveClass(/comment-pulse/)
    await page.getByText(label, { exact: true }).click()
    await expect(target).toBeInViewport()
    await expect(target).toHaveClass(/flash-comment-highlight/)
    await expect(other).not.toHaveClass(/flash-comment-highlight/)
    await page.mouse.move(0, 0)
    await page.getByText(label, { exact: true }).hover()
    await expect(target).toHaveClass(/comment-pulse/)
    await expect(other).not.toHaveClass(/comment-pulse/)
    await page.mouse.move(0, 0)
    await expect(target).not.toHaveClass(/comment-pulse/)
    await expect(target).not.toHaveClass(/flash-comment-highlight/)
  }
})
