import { expect, test, type Page } from "@playwright/test"
import { injectHtmlCommentOverlay } from "../../packages/server/src/share/html-comment-overlay"

// The page's own script records every message the live UI posts into the
// frame, so tests can check that no comment body crosses.
const recorder = "<script>window.__seen = []; addEventListener('message', function (e) { if (e.source === parent) __seen.push(JSON.stringify(e.data)) })</script>"

const page1 = [
  "<!doctype html><html><head><title>QA page</title></head><body>",
  recorder,
  "<h1>Quarterly report</h1>",
  "<p>Intro paragraph about the quarter.</p>",
  "<div style=\"height:1600px\"></div>",
  "<p id=\"target\">Revenue grew &amp; churn fell this quarter.</p>",
  "<p>Closing words.</p>",
  "<p><a id=\"next\" href=\"other.html\">Next</a> <a id=\"next-flagged\" href=\"other.html?__afs_comments=1\">Next with overlay</a></p>",
  "<table><tr id=\"row\"><td>Alpha cell</td><td>Beta cell</td></tr></table>",
  "<p id=\"pic\"><canvas width=\"80\" height=\"40\"></canvas></p>",
  "</body></html>",
].join("\n")

// A linked page. Its script proposes selections to the parent, as a forged
// overlay would.
const otherPage = "<!doctype html><p id=\"other\">Other page text</p><script>setInterval(function () { parent.postMessage({ type: 'agent-fs-comments:selection', v: 1, start: 0, end: 5, rect: { left: 10, top: 10, width: 50, height: 10 } }, '*') }, 200)</script>"

const otherUser = { id: "c-other", body: "A comment from another user", author: "another-user", authorDisplayName: "Ada" }

interface Fixture {
  html: string
  version: number
  features?: string[]
  comments: Array<Record<string, unknown>>
  adds: Array<Record<string, unknown>>
  siteUrls: string[]
  /** Answer for the `diff` op; aborted when unset. */
  diff?: unknown[]
}

function comment(c: Record<string, unknown>) {
  return { path: "reports/page.html", resolved: false, replyCount: 0, createdAt: "2026-10-27T12:00:00.000Z", updatedAt: "2026-10-27T12:00:00.000Z", replies: [], ...c }
}

// Production app shell against deterministic API fixtures. `/site/` serves
// the page through the server's real overlay when the viewer asks for it.
async function installFixture(page: Page, f: Fixture) {
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
    else if (url.pathname === "/content") return route.fulfill({ body: f.html, contentType: "text/plain" })
    else if (url.pathname.startsWith("/site/")) {
      f.siteUrls.push(url.pathname + url.search)
      const bytes = new TextEncoder().encode(url.pathname.endsWith("/other.html") ? otherPage : f.html)
      const body = url.searchParams.get("__afs_comments") === "1" ? injectHtmlCommentOverlay(bytes) : bytes
      return route.fulfill({ body: Buffer.from(body), contentType: "text/html" })
    } else if (url.pathname.endsWith("/ops")) {
      const body = route.request().postDataJSON()
      switch (body.op) {
        case "stat": json = { path: body.path, size: f.html.length, contentType: "text/html", author: "qa", currentVersion: f.version, createdAt: "2026-01-01", modifiedAt: "2026-01-01", isDeleted: false }; break
        case "signed-url": json = { url: `http://fixture.test/content?path=${body.path}` }; break
        case "share-create": json = { id: "tok", kind: "site", url: "/site/tok/", sharePath: "/site/tok/", path: body.path, expiresIn: 900, expiresAt: new Date(Date.now() + 900_000).toISOString(), maxViews: null }; break
        case "comment-list": json = { comments: body.resolved ? [] : f.comments }; break
        case "comment-add": {
          f.adds.push(body)
          const added = comment({ id: `c-new-${f.adds.length}`, body: body.body, author: "qa", lineStart: body.lineStart, lineEnd: body.lineEnd, quote: body.quote, quotedContent: body.quotedContent, fileVersion: f.version })
          f.comments.push(added)
          json = added
          break
        }
        case "diff":
          if (!f.diff) return route.abort()
          json = { changes: f.diff, source: "content" }
          break
        case "comment-notification-list": json = { notifications: [], unreadCount: 0 }; break
        case "ls": json = { entries: [] }; break
        case "tree": json = { tree: [] }; break
        // The version diff and side panels degrade gracefully.
        default: return route.abort()
      }
    } else if (url.pathname === "/health") json = { ok: true, version: "test", features: f.features ?? ["share-links", "html-sites", "html-comments"] }
    else return route.abort()
    await route.fulfill({ json })
  })
}

function fixture(over: Partial<Fixture> = {}): Fixture {
  return { html: page1, version: 1, comments: [], adds: [], siteUrls: [], ...over }
}

const FRAME = 'iframe[title="reports/page.html"]'

/** Sizes of the overlay's highlight groups, read inside the frame. */
async function highlightSizes(page: Page) {
  const frame = page.frames().find((fr) => fr.url().includes("/site/tok/"))
  if (!frame) return null
  return frame.evaluate(() => ({
    anchored: CSS.highlights.get("afs-comment")?.size ?? 0,
    moved: CSS.highlights.get("afs-comment-moved")?.size ?? 0,
    active: CSS.highlights.get("afs-comment-active")?.size ?? 0,
  }))
}

async function seenInFrame(page: Page): Promise<string[]> {
  const frame = page.frames().find((fr) => fr.url().includes("/site/tok/"))
  return frame ? frame.evaluate(() => (window as unknown as { __seen: string[] }).__seen) : []
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
})

test("select text in the page, comment, and the comment is highlighted", async ({ page }, testInfo) => {
  const f = fixture()
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/page.html")

  const frameEl = page.locator(FRAME)
  await expect(frameEl).toHaveAttribute("src", "http://fixture.test/site/tok/page.html?__afs_comments=1")
  expect((await frameEl.getAttribute("sandbox")) ?? "").not.toContain("allow-same-origin")

  const target = page.frameLocator(FRAME).locator("#target")
  await target.scrollIntoViewIfNeeded()
  await target.click({ clickCount: 3 })
  await page.waitForTimeout(200)
  await page.getByRole("button", { name: "Comment", exact: true }).click()
  await page.getByPlaceholder("Add a comment...").fill("Tighten this")
  await page.getByRole("button", { name: "Send comment" }).click()

  await expect.poll(() => f.adds.length).toBe(1)
  expect(f.adds[0]).toMatchObject({
    op: "comment-add",
    path: "reports/page.html",
    body: "Tighten this",
    lineStart: 6,
    lineEnd: 6,
    quote: { exact: "Revenue grew & churn fell this quarter." },
  })
  expect((f.adds[0].quote as { prefix: string }).prefix).toContain("paragraph about the quarter.")
  await expect.poll(() => highlightSizes(page)).toMatchObject({ anchored: 1 })
  await page.screenshot({ path: testInfo.outputPath("html-comment.png") })
  // The frame got ranges and ids, never the comment text.
  expect((await seenInFrame(page)).join("\n")).not.toContain("Tighten this")
})

test("another user's comment is highlighted; its card reveals it and hovering the highlight marks the card", async ({ page }) => {
  const quote = { exact: "Revenue grew & churn fell this quarter.", prefix: "about the quarter.\n", suffix: "\nClosing words." }
  const f = fixture({ comments: [comment({ ...otherUser, quote, quotedContent: quote.exact, lineStart: 6, lineEnd: 6, fileVersion: 1 })] })
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/page.html")

  await expect.poll(() => highlightSizes(page)).toMatchObject({ anchored: 1, moved: 0 })
  const frame = page.frames().find((fr) => fr.url().includes("/site/tok/"))!
  expect(await frame.evaluate(() => scrollY)).toBe(0)

  // The quote, not the body: clicks on the body stay in the card.
  await page.getByText(quote.exact).click()
  await expect.poll(() => frame.evaluate(() => scrollY)).toBeGreaterThan(500)

  await page.frameLocator(FRAME).locator("#target").hover()
  await expect.poll(() => highlightSizes(page)).toMatchObject({ active: 1 })
  expect((await seenInFrame(page)).join("\n")).not.toContain(otherUser.body)
  expect((await seenInFrame(page)).join("\n")).not.toContain("another-user")
})

test("a comment whose text moved shows as moved; one whose text is gone shows anchor lost", async ({ page }) => {
  const quote = { exact: "Revenue grew & churn fell this quarter.", prefix: "about the quarter.\n", suffix: "\nClosing words." }
  const edited = page1
    .replace('<p id="target">Revenue grew &amp; churn fell this quarter.</p>\n', "")
    .replace("<p>Closing words.</p>", "<p>Closing words.</p>\n<p>New paragraph.</p>\n<p>Revenue grew &amp; churn fell this quarter.</p>")
  const f = fixture({ html: edited, version: 2, comments: [comment({ ...otherUser, quote, quotedContent: quote.exact, lineStart: 6, lineEnd: 6, fileVersion: 1 })] })
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/page.html")
  await expect.poll(() => highlightSizes(page)).toMatchObject({ moved: 1, anchored: 0 })
  await expect(page.getByText("moved", { exact: true })).toBeVisible()

  f.html = page1.replace("Revenue grew &amp; churn fell this quarter.", "Something else entirely.")
  await page.reload()
  await expect(page.getByText("anchor lost", { exact: true })).toBeVisible()
  await expect.poll(() => highlightSizes(page)).toMatchObject({ anchored: 0, moved: 0 })
})

test("messages forged by the page cannot create a comment", async ({ page }) => {
  const forger = "<script>" + [
    "var P = 'agent-fs-comments:';",
    "function forge() {",
    "  parent.postMessage({ type: P + 'create', v: 1, path: 'reports/page.html', body: 'forged' }, '*');",
    "  parent.postMessage({ type: P + 'comment-add', v: 1, body: 'forged' }, '*');",
    "  parent.postMessage({ type: P + 'selection', v: 1, start: 0, end: 5, rect: { left: 10, top: 10, width: 50, height: 10 } }, '*');",
    "  parent.postMessage({ type: P + 'text', v: 1, text: 'x'.repeat(3 * 1024 * 1024) }, '*');",
    "  parent.postMessage({ type: P + 'activate', v: 1, id: 'c-other' }, '*');",
    "}",
    "setTimeout(forge, 500); setTimeout(forge, 1500);",
  ].join("\n") + "</script>"
  const f = fixture({ html: page1.replace("</body>", `${forger}</body>`) })
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/page.html")
  await expect.poll(() => highlightSizes(page)).not.toBeNull()
  await page.waitForTimeout(2000)
  // A proposed selection may show the Comment button, but only a person
  // typing and sending makes a comment.
  expect(f.adds).toEqual([])
})

test("a server without html-comments keeps the preview read-only", async ({ page }) => {
  const f = fixture({ features: ["share-links", "html-sites"] })
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/page.html")
  await expect(page.locator(FRAME)).toHaveAttribute("src", "http://fixture.test/site/tok/page.html")
  await expect(page.frameLocator(FRAME).locator("#target")).toBeVisible()
  expect(f.siteUrls.every((u) => !u.includes("__afs_comments"))).toBe(true)
  const target = page.frameLocator(FRAME).locator("#target")
  await target.scrollIntoViewIfNeeded()
  await target.click({ clickCount: 3 })
  await page.waitForTimeout(300)
  await expect(page.getByRole("button", { name: "Comment", exact: true })).toHaveCount(0)
})

/** Select the target paragraph and open the composer with a body typed in. */
async function startComment(page: Page, body: string) {
  const target = page.frameLocator(FRAME).locator("#target")
  await target.scrollIntoViewIfNeeded()
  await target.click({ clickCount: 3 })
  // The first click proposes the block, the third the selection: let the button settle.
  await page.waitForTimeout(200)
  await page.getByRole("button", { name: "Comment", exact: true }).click()
  await page.getByPlaceholder("Add a comment...").fill(body)
}

test("the composer keeps the passage it opened on when the page text changes", async ({ page }) => {
  const f = fixture()
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/page.html")
  await startComment(page, "Snapshot")
  // The page inserts text before the selection while the user types.
  await page.frameLocator(FRAME).locator("#target").evaluate((el) => el.insertAdjacentHTML("beforebegin", "<p>Inserted by a script.</p>"))
  await page.waitForTimeout(700) // the overlay re-sends text after 300 ms
  await page.getByRole("button", { name: "Send comment" }).click()
  await expect.poll(() => f.adds.length).toBe(1)
  expect(f.adds[0]).toMatchObject({ lineStart: 6, lineEnd: 6, quote: { exact: "Revenue grew & churn fell this quarter." } })
})

for (const link of ["#next", "#next-flagged"]) {
  test(`following a link (${link}) ends commenting, even mid-composition`, async ({ page }) => {
    const f = fixture()
    await installFixture(page, f)
    await page.goto("/file/~/org/drive/reports/page.html")
    await startComment(page, "Never saved")
    await page.frameLocator(FRAME).locator(link).evaluate((a) => (a as HTMLAnchorElement).click())
    await expect(page.getByPlaceholder("Add a comment...")).toHaveCount(0)
    const other = page.frameLocator(FRAME).locator("#other")
    await expect(other).toBeVisible()
    await other.click({ clickCount: 3 })
    await page.waitForTimeout(800) // the linked page keeps proposing selections
    await expect(page.getByRole("button", { name: "Comment", exact: true })).toHaveCount(0)
    expect(f.adds).toEqual([])
  })
}

test("highlights survive the page replacing a commented node with an identical one", async ({ page }) => {
  const quote = { exact: "Revenue grew & churn fell this quarter.", prefix: "about the quarter.\n", suffix: "\nClosing words." }
  const f = fixture({ comments: [comment({ ...otherUser, quote, quotedContent: quote.exact, lineStart: 6, lineEnd: 6, fileVersion: 1 })] })
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/page.html")
  await expect.poll(() => highlightSizes(page)).toMatchObject({ anchored: 1 })
  await page.frameLocator(FRAME).locator("#target").evaluate((el) => el.replaceWith(el.cloneNode(true)))
  const frame = page.frames().find((fr) => fr.url().includes("/site/tok/"))!
  await expect.poll(() => frame.evaluate(() => {
    const range = [...(CSS.highlights.get("afs-comment") ?? [])][0] as Range | undefined
    return range?.startContainer.isConnected ? range.toString() : null
  })).toBe(quote.exact)
})

test("clicking a paragraph, heading or table row comments on the whole block; a textless one offers nothing", async ({ page }) => {
  const f = fixture()
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/page.html")
  const frame = page.frameLocator(FRAME)
  const blocks: Array<[string, string, number]> = [
    ["h1", "Quarterly report", 3],
    ["p >> nth=0", "Intro paragraph about the quarter.", 4],
    ["#row", "Alpha cell\nBeta cell", 9],
  ]
  for (const [selector, exact, line] of blocks) {
    await frame.locator(selector).scrollIntoViewIfNeeded()
    await frame.locator(selector).click()
    // The block is selected, so it is marked, and the button sits under its
    // text like a selection's, not under the whole element box.
    const button = page.getByRole("button", { name: "Comment", exact: true })
    await expect(button).toBeVisible()
    const marked = await frame.locator(selector).evaluate(() => {
      const range = getSelection()!.getRangeAt(0)
      const r = range.getBoundingClientRect()
      return { text: range.toString(), center: r.left + r.width / 2 }
    })
    expect(marked.text.replace(/\s+/g, "")).toBe(exact.replace(/\s+/g, ""))
    const frameBox = (await page.locator(FRAME).boundingBox())!
    const box = (await button.boundingBox())!
    // Placed as for a selection: centred on a 108 px slot under the text.
    expect(Math.abs(box.x - (frameBox.x + marked.center - 54))).toBeLessThan(3)
    await button.click()
    await page.getByPlaceholder("Add a comment...").fill(`On ${selector}`)
    await page.getByRole("button", { name: "Send comment" }).click()
    await expect.poll(() => f.adds.length).toBe(blocks.indexOf(blocks.find(([s]) => s === selector)!) + 1)
    expect(f.adds.at(-1)).toMatchObject({ lineStart: line, lineEnd: line, quote: { exact } })
  }
  await frame.locator("#pic canvas").click()
  await page.waitForTimeout(300)
  await expect(page.getByRole("button", { name: "Comment", exact: true })).toHaveCount(0)
})

test("a comment whose text was rewritten is found through the version diff", async ({ page }) => {
  const lines = page1.split("\n")
  const html = [...lines.slice(0, 3), "<p>Inserted one.</p>", "<p>Inserted two.</p>", lines[3], lines[4],
    '<p id="target">Revenue rose strongly while churn dropped.</p>', ...lines.slice(6)].join("\n")
  // What the diff op returns for that edit, line by line.
  const diff = [
    ...[1, 2, 3].map((n) => ({ type: "context", oldLine: n, newLine: n })),
    { type: "add", newLine: 4 }, { type: "add", newLine: 5 },
    { type: "context", oldLine: 4, newLine: 6 }, { type: "context", oldLine: 5, newLine: 7 },
    { type: "remove", oldLine: 6 }, { type: "add", newLine: 8 },
    ...lines.slice(6).map((_, i) => ({ type: "context", oldLine: 7 + i, newLine: 9 + i })),
  ]
  const quote = { exact: "Revenue grew & churn fell this quarter.", prefix: "about the quarter.\n", suffix: "\nClosing words." }
  const f = fixture({ html, version: 2, diff, comments: [comment({ ...otherUser, quote, quotedContent: quote.exact, lineStart: 6, lineEnd: 6, fileVersion: 1 })] })
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/page.html")
  await expect(page.getByText("moved", { exact: true })).toBeVisible()
  const frame = page.frames().find((fr) => fr.url().includes("/site/tok/"))!
  await expect.poll(() => frame.evaluate(() => [...(CSS.highlights.get("afs-comment-moved") ?? [])].map((r) => (r as Range).toString())))
    .toEqual(["Revenue rose strongly while churn dropped."])
})

test("a block's Comment button follows the page when it scrolls", async ({ page }) => {
  await installFixture(page, fixture())
  await page.goto("/file/~/org/drive/reports/page.html")
  const frame = page.frameLocator(FRAME)
  await frame.locator("p >> nth=0").click()
  const button = page.getByRole("button", { name: "Comment", exact: true })
  const before = (await button.boundingBox())!
  await frame.locator("body").evaluate(() => scrollBy(0, 40))
  await expect.poll(async () => Math.round(before.y - (await button.boundingBox())!.y)).toBe(40)
})

test("commenting comes back when the page is restored from the back/forward cache", async ({ page }) => {
  await installFixture(page, fixture())
  await page.goto("/file/~/org/drive/reports/page.html")
  const frame = page.frameLocator(FRAME)
  const button = page.getByRole("button", { name: "Comment", exact: true })
  await expect.poll(() => highlightSizes(page)).not.toBeNull()
  // The whole app is cached and restored: the frame gets pagehide, then pageshow.
  await frame.locator("body").evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })))
  await frame.locator("h1").click()
  await page.waitForTimeout(300)
  await expect(button).toHaveCount(0)
  await frame.locator("body").evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })))
  await frame.locator("#target").click()
  await expect(button).toBeVisible()
})

test("a line-only comment finds text written with named, numeric and hex references", async ({ page }) => {
  const html = "<!doctype html><body>\n<h1>Menu</h1>\n<p>Caf&eacute; earnings, &#233;t&#xE9; &amp; more</p>\n<p>Next</p>\n</body>"
  const f = fixture({ html, comments: [comment({ ...otherUser, lineStart: 3, lineEnd: 3, fileVersion: 1 })] })
  await installFixture(page, f)
  await page.goto("/file/~/org/drive/reports/page.html")
  const frame = () => page.frames().find((fr) => fr.url().includes("/site/tok/"))!
  await expect.poll(() => frame()?.evaluate(() => [...(CSS.highlights.get("afs-comment") ?? [])].map((r) => (r as Range).toString())))
    .toEqual(["Café earnings, été & more"])
  await expect(page.getByText("anchor lost", { exact: true })).toHaveCount(0)
})
