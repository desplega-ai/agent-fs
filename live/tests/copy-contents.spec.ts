import { expect, test, type Page } from "@playwright/test"

const NOTES = "# Notes\n\nCopied straight from the viewer.\n"
// 1x1 transparent PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64")

const files: Record<string, { size: number; contentType: string; body: string | Buffer }> = {
  "/notes.md": { size: NOTES.length, contentType: "text/markdown", body: NOTES },
  "/big.json": { size: 2 * 1024 * 1024, contentType: "application/json", body: "{}" },
  "/photo.png": { size: PNG.length, contentType: "image/png", body: PNG },
}

const fileFor = (path: string) => files[path.startsWith("/") ? path : `/${path}`]

/** Production app shell against deterministic API fixtures; no live account. */
async function installFixture(page: Page) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
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
    else if (url.pathname === "/health") json = { ok: true, version: "test", features: [] }
    else if (url.pathname === "/content") {
      const file = fileFor(url.searchParams.get("path") ?? "")
      return route.fulfill({ body: file.body, contentType: file.contentType })
    } else if (url.pathname.endsWith("/ops")) {
      const body = route.request().postDataJSON()
      const file = body.path ? fileFor(body.path) : undefined
      switch (body.op) {
        case "ls": json = { entries: Object.entries(files).map(([p, f]) => ({ name: p.slice(1), type: "file", size: f.size, modifiedAt: "2026-10-02T10:00:00.000Z" })) }; break
        case "stat": json = { path: body.path, size: file!.size, contentType: file!.contentType, author: "qa", currentVersion: 1, createdAt: "2026-10-01", modifiedAt: "2026-10-02", isDeleted: false }; break
        case "signed-url": json = { url: `http://fixture.test/content?path=${encodeURIComponent(body.path)}` }; break
        case "comment-list": json = { comments: [] }; break
        case "comment-notification-list": json = { notifications: [], unreadCount: 0 }; break
        default: return route.abort()
      }
    } else return route.abort()
    await route.fulfill({ json })
  })
}

const copyButton = (page: Page) => page.getByRole("button", { name: /^(Copy contents|Contents copied)$/ })
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText())
const setClipboard = (page: Page, text: string) => page.evaluate(t => navigator.clipboard.writeText(t), text)

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await installFixture(page)
})

test("a click copies the file's contents", async ({ page }, testInfo) => {
  await page.goto("/file/~/org/drive/notes.md")
  await expect(page.getByText("Copied straight from the viewer.")).toBeVisible()
  await copyButton(page).click()
  await expect(page.getByRole("button", { name: "Contents copied" })).toBeVisible()
  expect(await clipboard(page)).toBe(NOTES)
  await expect(page.getByText("Contents copied", { exact: true }).last()).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("contents-copied.png") })
})

test("without ClipboardItem the click falls back to writeText", async ({ page }) => {
  await page.addInitScript(() => {
    // @ts-expect-error simulate a browser without ClipboardItem
    delete window.ClipboardItem
  })
  await page.goto("/file/~/org/drive/notes.md")
  await expect(page.getByText("Copied straight from the viewer.")).toBeVisible()
  await copyButton(page).click()
  await expect(page.getByRole("button", { name: "Contents copied" })).toBeVisible()
  expect(await clipboard(page)).toBe(NOTES)
})

test("hovering opens Copy path, which copies the path", async ({ page }, testInfo) => {
  await page.goto("/file/~/org/drive/notes.md")
  await copyButton(page).hover()
  const copyPath = page.getByRole("button", { name: /Copy path/ })
  await expect(copyPath).toBeVisible()
  await expect(page.getByText("Click to copy contents")).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("hover-popover.png") })
  await copyPath.click()
  expect(await clipboard(page)).toMatch(/^\/?notes\.md$/)
})

test("keyboard focus opens the popover", async ({ page }) => {
  await page.goto("/file/~/org/drive/notes.md")
  await expect(copyButton(page)).toBeVisible()
  // Keyboard-originated focus, so the button matches :focus-visible.
  await page.keyboard.press("Tab")
  await copyButton(page).focus()
  await expect(page.getByRole("button", { name: /Copy path/ })).toBeVisible()
})

test("Y still copies the path", async ({ page }) => {
  await page.goto("/file/~/org/drive/notes.md")
  await expect(page.getByText("Copied straight from the viewer.")).toBeVisible()
  await page.keyboard.press("y")
  await expect.poll(() => clipboard(page)).toMatch(/^\/?notes\.md$/)
})

test("a file over 1 MB is not copied and offers Download instead", async ({ page }, testInfo) => {
  await page.goto("/file/~/org/drive/big.json")
  await setClipboard(page, "untouched")
  await copyButton(page).hover()
  await expect(page.getByText("Too large to copy")).toBeVisible()
  await expect(page.getByRole("button", { name: "Download instead" })).toBeVisible()
  await expect(copyButton(page)).toHaveAttribute("aria-disabled", "true")
  await page.screenshot({ path: testInfo.outputPath("too-large.png") })
  // aria-disabled: Playwright would wait for it to become enabled, so force the click.
  await copyButton(page).click({ force: true })
  await page.waitForTimeout(300)
  expect(await clipboard(page)).toBe("untouched")
})

test("an image is not copied and offers Download instead", async ({ page }, testInfo) => {
  await page.goto("/file/~/org/drive/photo.png")
  await setClipboard(page, "untouched")
  await copyButton(page).hover()
  await expect(page.getByText("Can't copy this file type")).toBeVisible()
  await expect(page.getByRole("button", { name: "Download instead" })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("wrong-type.png") })
  // aria-disabled: Playwright would wait for it to become enabled, so force the click.
  await copyButton(page).click({ force: true })
  await page.waitForTimeout(300)
  expect(await clipboard(page)).toBe("untouched")
})

/** Replaces notes.md on the "server" after the page has loaded it, as another writer would. */
async function growNotesExternally(page: Page) {
  const grown = "x".repeat(2 * 1024 * 1024)
  await page.route("http://fixture.test/**", async route => {
    const url = new URL(route.request().url())
    if (url.pathname === "/content" && url.searchParams.get("path")?.replace(/^\//, "") === "notes.md") {
      return route.fulfill({ body: grown, contentType: "text/markdown" })
    }
    const body = url.pathname.endsWith("/ops") ? route.request().postDataJSON() : undefined
    if (body?.op === "stat" && body.path.replace(/^\//, "") === "notes.md") {
      return route.fulfill({ json: { path: body.path, size: grown.length, contentType: "text/markdown", author: "qa", currentVersion: 2, createdAt: "2026-10-01", modifiedAt: "2026-10-03", isDeleted: false } })
    }
    return route.fallback()
  })
}

for (const clipboardItem of [true, false]) {
  test(`a file that grew past 1 MB after it loaded is not copied${clipboardItem ? "" : " (writeText fallback)"}`, async ({ page }, testInfo) => {
    if (!clipboardItem) {
      await page.addInitScript(() => {
        // @ts-expect-error simulate a browser without ClipboardItem
        delete window.ClipboardItem
      })
    }
    await page.goto("/file/~/org/drive/notes.md")
    await expect(page.getByText("Copied straight from the viewer.")).toBeVisible()
    // The stat the page holds still says a few bytes of markdown.
    await expect(copyButton(page)).not.toHaveAttribute("aria-disabled", "true")
    await setClipboard(page, "untouched")
    await growNotesExternally(page)
    await copyButton(page).click()
    await expect(page.getByText("Too large to copy", { exact: true }).last()).toBeVisible()
    await expect(page.getByRole("status").getByRole("button", { name: "Download instead" })).toBeVisible()
    // The re-stat flips the button and popover to the too-large state.
    await expect(copyButton(page)).toHaveAttribute("aria-disabled", "true")
    expect(await clipboard(page)).toBe("untouched")
    // Reopen the popover from the keyboard: Tab away, then focus the button again.
    await page.keyboard.press("Tab")
    await copyButton(page).focus()
    await expect(page.getByRole("button", { name: /Copy path/ })).toBeVisible()
    await expect(page.locator("span").getByText("Too large to copy", { exact: true })).toBeVisible()
    if (clipboardItem) await page.screenshot({ path: testInfo.outputPath("grew-too-large.png") })
  })
}
