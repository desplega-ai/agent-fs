import { test, expect } from "@playwright/test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { editor as MonacoEditor } from "monaco-editor"

const longLine = "A long raw preview line that should wrap within the available space. ".repeat(20)
const markdown = [
  "# Mobile reading",
  "Paragraphs should stay in place while wide tables scroll independently.",
  "| Name | Description | Owner | Status | Reference |",
  "| --- | --- | --- | --- | --- |",
  `| ${["Name", "Description", "Owner", "Status", "Reference"].map(s => s.repeat(10)).join(" | ")} |`,
  "Paragraph after the table stays readable without panning sideways.",
  "```text", longLine, "```",
].join("\n\n").replace(/\|\n\n\|/g, "|\n|")

// Exercise the production app shell and viewers with deterministic API fixtures.
// No credentials, remote files, or live database are used.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("agent-fs-credentials", JSON.stringify([
      { id: "qa", name: "QA", endpoint: "http://fixture.test", apiKey: "fixture" },
    ]))
    localStorage.setItem("agent-fs-active-credential", "qa")
  })
  // Serve Monaco's AMD assets locally instead of depending on its CDN.
  await page.route("https://cdn.jsdelivr.net/**", async route => {
    const path = new URL(route.request().url()).pathname.split("/min/")[1]
    if (!path) return route.abort()
    const body = await readFile(resolve("node_modules/monaco-editor/min", path))
    await route.fulfill({ body, contentType: path.endsWith(".css") ? "text/css" : "text/javascript" })
  })
  await page.route("http://fixture.test/**", async route => {
    const url = new URL(route.request().url())
    let json: unknown
    if (url.pathname === "/auth/me") json = { userId: "qa", email: "qa@example.test", defaultOrgId: "org", defaultDriveId: "drive" }
    else if (url.pathname === "/orgs") json = { orgs: [{ id: "org", name: "QA" }] }
    else if (url.pathname.endsWith("/drives")) json = { drives: [{ id: "drive", name: "QA", orgId: "org" }] }
    else if (url.pathname === "/content") return route.fulfill({ body: url.searchParams.get("path") === "wide.md" ? markdown : longLine, contentType: "text/plain" })
    else if (url.pathname.endsWith("/ops")) {
      const { op, path } = route.request().postDataJSON()
      switch (op) {
        case "stat": json = { path, size: 2000, contentType: "text/plain", author: "qa", currentVersion: 1, createdAt: "2026-01-01", modifiedAt: "2026-01-01", isDeleted: false }; break
        case "signed-url": json = { url: `http://fixture.test/content?path=${path}` }; break
        case "comment-list": json = { comments: [] }; break
        case "comment-notification-list": json = { notifications: [], unreadCount: 0 }; break
        case "ls": json = { entries: [] }; break
        case "tree": json = { tree: [] }; break
        default: throw new Error(`Unexpected op: ${op}`)
      }
    } else if (url.pathname === "/health") json = { status: "ok" }
    else throw new Error(`Unexpected request: ${url}`)
    await route.fulfill({ json })
  })
})

for (const width of [360, 390, 768]) {
  test(`markdown contains horizontal scrolling at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/file/~/org/drive/wide.md")
    const pane = page.locator("[data-markdown-scroll]:visible")
    await expect(pane.locator("table")).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    const numbers = await pane.evaluate(el => {
      const table = el.querySelector("table")!.parentElement!
      const pre = el.querySelector("pre")!
      const size = (e: Element) => ({ client: e.clientWidth, scroll: e.scrollWidth })
      return { document: size(document.documentElement), pane: size(el), table: size(table), pre: size(pre) }
    })
    console.log(JSON.stringify({ width, ...numbers }))
    await page.screenshot({ path: testInfo.outputPath(`markdown-${width}.png`) })
    expect(numbers.document.scroll).toBe(numbers.document.client)
    expect(numbers.pane.scroll).toBe(numbers.pane.client)
    expect(numbers.table.scroll).toBeGreaterThan(numbers.table.client)
    expect(numbers.pre.scroll).toBeGreaterThan(numbers.pre.client)
    // Horizontal gestures move only the table, preserving paragraphs and row anchors.
    const paragraph = pane.locator("p").first()
    const before = await paragraph.boundingBox()
    await pane.locator("table").evaluate(table => { table.parentElement!.scrollLeft = 100 })
    expect(await pane.locator("table").evaluate(table => table.parentElement!.scrollLeft)).toBe(100)
    expect(await paragraph.boundingBox()).toEqual(before)
    await pane.locator("table").evaluate(table => { table.parentElement!.scrollLeft = 0 })
    await pane.locator("td").first().hover({ position: { x: 10, y: 10 } })
    await expect(page.locator("[data-hover-comment]:visible")).toBeVisible()
    await page.locator("[data-hover-comment]:visible").click()
    await expect(page.locator("[data-comment-ui]:visible textarea")).toBeVisible()
    expect(await pane.locator("td").first().evaluate(td => td.closest("p, h1, h2, h3, h4, h5, h6, pre, tr")?.tagName)).toBe("TR")
  })

  test(`raw preview wraps at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/file/~/org/drive/long.log")
    await expect(page.locator(".monaco-editor:visible .view-lines")).toContainText("A long raw preview line")
    await page.evaluate(async () => {
      await document.fonts.ready
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
    })
    const numbers = await page.evaluate(() => {
      const editor = (window as unknown as { monaco: { editor: { getEditors(): MonacoEditor.IStandaloneCodeEditor[] } } }).monaco.editor.getEditors().find(e => e.getDomNode()!.getBoundingClientRect().height > 0)!
      return { document: { client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }, editor: { client: editor.getLayoutInfo().width, scroll: editor.getScrollWidth(), contentHeight: editor.getContentHeight() } }
    })
    console.log(JSON.stringify({ width, ...numbers }))
    await page.screenshot({ path: testInfo.outputPath(`raw-${width}.png`) })
    expect(numbers.document.scroll).toBe(numbers.document.client)
    expect(numbers.editor.scroll).toBeLessThanOrEqual(numbers.editor.client)
    expect(numbers.editor.contentHeight).toBeGreaterThan(40)
  })
}
