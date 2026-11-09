import { expect, test, type Page } from "@playwright/test"

type Entry = { name: string; type: "file" | "directory"; size: number; modifiedAt?: string }

const file = (name: string): Entry => ({ name, type: "file", size: 8, modifiedAt: "2026-10-01T10:00:00.000Z" })
const dir = (name: string): Entry => ({ name, type: "directory", size: 0 })
const pad = (n: number) => String(n).padStart(3, "0")

// A large drive: 120 folders of 40 files each at the root, target 4 levels deep.
const listings: Record<string, Entry[]> = { "": [] }
for (let a = 0; a < 120; a++) {
  listings[""].push(dir(`area-${pad(a)}`))
  listings[`area-${pad(a)}`] = [dir("sub"), ...Array.from({ length: 40 }, (_, i) => file(`f-${pad(i)}.md`))]
  listings[`area-${pad(a)}/sub`] = [dir("deep"), ...Array.from({ length: 30 }, (_, i) => file(`s-${pad(i)}.md`))]
  listings[`area-${pad(a)}/sub/deep`] = Array.from({ length: 30 }, (_, i) => file(i === 17 ? "target.md" : `d-${pad(i)}.md`))
}
for (let i = 0; i < 20; i++) listings[""].push(file(`root-${pad(i)}.md`))

const TARGET = "area-100/sub/deep/target.md"
// Folders the user expanded on an earlier visit, persisted in localStorage.
// The set only grows (a reveal adds the target's ancestors), so a long-lived
// browser carries hundreds. Those above the target load after the reveal lands
// and push it down.
const PREVIOUSLY_EXPANDED = Array.from({ length: 120 }, (_, a) => [`area-${pad(a)}`, `area-${pad(a)}/sub`])
  .flat()
  .filter((path) => !path.startsWith("area-100"))

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function installFixture(page: Page, opts: { reveal: boolean }) {
  const ops: string[] = []
  await page.addInitScript((expanded) => {
    // An active org and drive matching the URL, so opening it keeps the
    // persisted expansion instead of clearing it as a drive switch.
    localStorage.setItem("agent-fs-active-org", "org")
    localStorage.setItem("agent-fs-active-drive", "drive")
    localStorage.setItem("agent-fs-credentials", JSON.stringify([
      { id: "qa", name: "QA", endpoint: "http://fixture.test", apiKey: "fixture" },
    ]))
    localStorage.setItem("agent-fs-active-credential", "qa")
    localStorage.setItem("liveui:tree:expanded", JSON.stringify(expanded))
  }, PREVIOUSLY_EXPANDED)
  await page.route("http://fixture.test/**", async route => {
    const url = new URL(route.request().url())
    let json: unknown
    if (url.pathname === "/auth/me") json = { userId: "qa", email: "qa@example.test", defaultOrgId: "org", defaultDriveId: "drive" }
    else if (url.pathname === "/orgs") json = { orgs: [{ id: "org", name: "QA" }] }
    else if (url.pathname.endsWith("/drives")) json = { drives: [{ id: "drive", name: "QA", orgId: "org" }] }
    else if (url.pathname === "/health") json = { ok: true, version: "test", features: [] }
    else if (url.pathname.endsWith("/ops")) {
      const { op, path } = route.request().postDataJSON()
      const norm = String(path ?? "").replace(/^\/+|\/+$/g, "")
      ops.push(`${op} ${norm}`)
      switch (op) {
        case "ls": {
          // Previously expanded folders answer slowly and out of order.
          const index = PREVIOUSLY_EXPANDED.indexOf(norm)
          if (index >= 0) await sleep(300 + ((index * 337) % 2500))
          json = { entries: listings[norm] ?? [] }
          break
        }
        case "reveal": {
          if (!opts.reveal) return route.fulfill({ status: 400, json: { error: "Unknown operation: reveal" } })
          await sleep(150)
          const parts = norm.split("/")
          const paths = ["", ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"))]
          json = {
            path: norm,
            stat: { path: `/${norm}`, size: 8, contentType: "text/markdown", author: "qa", currentVersion: 1, createdAt: "2026-10-01", modifiedAt: "2026-10-01", isDeleted: false },
            listings: paths.map((p) => ({ path: `/${p}`, entries: listings[p] ?? [] })),
          }
          break
        }
        case "stat": json = { path: `/${norm}`, size: 8, contentType: "text/markdown", author: "qa", currentVersion: 1, createdAt: "2026-10-01", modifiedAt: "2026-10-01", isDeleted: false }; break
        case "cat": json = { content: "# Target\n", totalLines: 1, truncated: false }; break
        case "comment-list": json = { comments: [] }; break
        case "comment-notification-list": json = { notifications: [], unreadCount: 0 }; break
        default: return route.abort()
      }
    } else return route.abort()
    await route.fulfill({ json })
  })
  return { ops }
}

/**
 * Sample, once per frame, where the target row sits in the sidebar and which
 * row is at the top of it, plus every scrollTop the sidebar reports.
 */
async function recordTree(page: Page, ms: number) {
  return page.evaluate(async ({ ms, target }) => {
    const panel = document.querySelector<HTMLElement>('[role="tabpanel"]')!
    const scrollTops: number[] = []
    panel.addEventListener("scroll", () => scrollTops.push(Math.round(panel.scrollTop)))
    const rowTops: number[] = []
    const topRows: string[] = []
    let maxMounted = 0
    const heights = new Set<number>()
    const start = performance.now()
    while (performance.now() - start < ms) {
      const box = panel.getBoundingClientRect()
      const row = panel.querySelector<HTMLElement>(`[data-tree-path="${target}"]`)
      if (row) {
        const top = Math.round(row.getBoundingClientRect().top - box.top)
        if (rowTops.at(-1) !== top) rowTops.push(top)
        // The row painted a quarter of the way down the sidebar.
        const probe = box.top + box.height / 4
        const topRow =
          Array.from(panel.querySelectorAll<HTMLElement>("[data-tree-path]")).find((el) => {
            const rect = el.getBoundingClientRect()
            return rect.top <= probe && rect.bottom > probe
          })?.dataset.treePath ?? "(blank)"
        if (topRows.at(-1) !== topRow) topRows.push(topRow)
      }
      const mounted = panel.querySelectorAll<HTMLElement>('[role="tree"] > div')
      maxMounted = Math.max(maxMounted, mounted.length)
      mounted.forEach((el) => heights.add(Math.round(el.getBoundingClientRect().height)))
      // Sample right after each paint: a task queued from a frame callback
      // runs once that frame has rendered, so this is the DOM it painted.
      await new Promise((resolve) =>
        requestAnimationFrame(() => {
          const channel = new MessageChannel()
          channel.port1.onmessage = resolve
          channel.port2.postMessage(null)
        }),
      )
    }
    return { scrollTops, rowTops, topRows, maxMounted, heights: [...heights] }
  }, { ms, target: TARGET })
}

for (const reveal of [true, false]) {
  test(`deep link reveals the file once while folders above it load (${reveal ? "reveal op" : "per-ancestor ls"})`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 844 })
    const { ops } = await installFixture(page, { reveal })
    await page.goto(`/file/~/org/drive/${TARGET}`)
    await page.locator('[role="tabpanel"]').waitFor()
    const result = await recordTree(page, 4500)
    await page.screenshot({ path: `test-results/tree-reveal-${reveal ? "reveal" : "ls"}.png` })

    // The folders expanded on an earlier visit did load, after the reveal.
    for (const path of PREVIOUSLY_EXPANDED) expect(ops).toContain(`ls ${path}`)
    await expect(page.locator(`[data-tree-path="${TARGET}"]`)).toBeInViewport()
    // Once painted, the target row and the row at the top never move.
    expect(result.rowTops).toHaveLength(1)
    expect(result.topRows).toHaveLength(1)
    // Fixed-height rows, and only the rows near the viewport are mounted.
    expect(result.heights).toEqual([28])
    expect(result.maxMounted).toBeLessThan(80)
  })
}

test("a scroll away from the revealed file sticks while folders above it load", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  await installFixture(page, { reveal: true })
  await page.goto(`/file/~/org/drive/${TARGET}`)
  await page.locator(`[data-tree-path="${TARGET}"]`).waitFor()
  const scrollTops = await page.evaluate(async () => {
    const panel = document.querySelector<HTMLElement>('[role="tabpanel"]')!
    panel.scrollTop = 0
    const seen: number[] = []
    const start = performance.now()
    while (performance.now() - start < 3500) {
      const top = Math.round(panel.scrollTop)
      if (seen.at(-1) !== top) seen.push(top)
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    return seen
  })
  // The listings still landing above the target never pull the sidebar back.
  expect(scrollTops).toEqual([0])
})

test("collapsing a folder above the viewport at the bottom of the sidebar keeps the visible rows still", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  const { ops } = await installFixture(page, { reveal: true })
  await page.goto(`/file/~/org/drive/${TARGET}`)
  await page.locator(`[data-tree-path="${TARGET}"]`).waitFor()
  // Let every previously expanded listing land.
  await expect.poll(() => PREVIOUSLY_EXPANDED.every((path) => ops.includes(`ls ${path}`)), { timeout: 10_000 }).toBe(true)
  // The slowest of them answers 2.8 s after its request.
  await sleep(3000)

  const folder = page.locator('[data-tree-path="area-000"]')
  await folder.focus()
  const before = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[role="tabpanel"]')!
    panel.scrollTop = panel.scrollHeight
    return new Promise<{ scrollTop: number; rows: Record<string, number> }>((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const box = panel.getBoundingClientRect()
          const rows: Record<string, number> = {}
          for (const el of panel.querySelectorAll<HTMLElement>("[data-tree-path]")) {
            const rect = el.getBoundingClientRect()
            if (rect.top >= box.top && rect.bottom <= box.bottom) rows[el.dataset.treePath!] = Math.round(rect.top - box.top)
          }
          resolve({ scrollTop: panel.scrollTop, rows })
        }),
      ),
    )
  })
  // The focused folder is far above the viewport, which sits at the bottom.
  await expect(folder).toBeFocused()
  const tree = page.locator('[role="tree"]')
  const treeHeight = () => tree.evaluate((el) => el.getBoundingClientRect().height)
  const heightBefore = await treeHeight()
  expect(Object.keys(before.rows)).not.toContain("area-000")
  expect(Object.keys(before.rows).length).toBeGreaterThan(10)

  await page.keyboard.press("ArrowLeft")
  // area-000 had 41 rows of its own plus 31 in its expanded `sub`.
  await expect.poll(treeHeight).toBe(heightBefore - 72 * 28)
  await expect(folder).toBeFocused()
  await sleep(300)
  const after = await page.evaluate((paths) => {
    const panel = document.querySelector<HTMLElement>('[role="tabpanel"]')!
    const box = panel.getBoundingClientRect()
    return Object.fromEntries(
      paths.map((path) => {
        const el = panel.querySelector<HTMLElement>(`[data-tree-path="${path}"]`)
        return [path, el ? Math.round(el.getBoundingClientRect().top - box.top) : null]
      }),
    )
  }, Object.keys(before.rows))
  // The 72 rows removed above the viewport leave every visible row in place.
  expect(after).toEqual(before.rows)
})
