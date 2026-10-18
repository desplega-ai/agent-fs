import { expect, test, type Page } from "@playwright/test"

const markdown = "# Notes\n\nThe quick brown fox jumps over the lazy dog.\n"

/** Another user on the open doc, with a selection and a pointer. */
const olga = {
  sessionId: "olga-session-1",
  userId: "olga",
  email: "olga@example.test",
  displayName: "Olga",
  path: "notes.md",
  mode: "edit",
  selection: {
    quote: { exact: "brown fox", prefix: "The quick ", suffix: " jumps over" },
    lineStart: 3,
    lineEnd: 3,
    fileVersion: 1,
    collapsed: false,
  },
  pointer: { quote: { exact: "lazy", prefix: "jumps over the ", suffix: " dog." }, charOffset: 2, lineStart: 3, fileVersion: 1 },
  commentId: null,
  commentState: null,
  updatedAt: "2026-10-18T10:00:00.000Z",
}

/** The signed-in user's other tab: never shown. */
const ownOtherTab = { ...olga, sessionId: "qa-other-tab", userId: "qa", email: "qa@example.test", displayName: "QA" }

function sse(frames: Array<[string, unknown]>): string {
  return frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("")
}

/**
 * Production app shell against deterministic API fixtures; no live account.
 * The drive event stream is answered with `ready` + `presence.snapshot`, and
 * the page keeps that stream open like a live server (see below).
 * Every request is logged so a test can prove which ones were (not) made.
 */
async function installFixture(page: Page, features: string[], opts: { sessions?: unknown[]; comments?: unknown[] } = {}) {
  const sessions = opts.sessions ?? [olga, ownOtherTab]
  const requests: string[] = []
  const puts: Array<Record<string, unknown>> = []
  await page.addInitScript(() => {
    // `route.fulfill` can only send a finished body, and a finished stream makes
    // the client drop the list and reconnect. Keep the event stream open (until
    // the client aborts it), as a live server does.
    const realFetch = window.fetch
    window.fetch = async (input, init) => {
      const res = await realFetch(input, init)
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (!url.includes("/events?") || !res.ok) return res
      const bytes = new Uint8Array(await res.arrayBuffer())
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")))
        },
      })
      return new Response(body, { status: res.status, headers: res.headers })
    }
    localStorage.setItem("agent-fs-credentials", JSON.stringify([
      { id: "qa", name: "QA", endpoint: "http://fixture.test", apiKey: "fixture" },
    ]))
    localStorage.setItem("agent-fs-active-credential", "qa")
  })
  await page.route("http://fixture.test/**", async route => {
    const request = route.request()
    const url = new URL(request.url())
    requests.push(`${request.method()} ${url.pathname}${url.search}`)
    let json: unknown
    if (url.pathname === "/auth/me") json = { userId: "qa", email: "qa@example.test", defaultOrgId: "org", defaultDriveId: "drive" }
    else if (url.pathname === "/orgs") json = { orgs: [{ id: "org", name: "QA" }] }
    else if (url.pathname.endsWith("/drives")) json = { drives: [{ id: "drive", name: "QA", orgId: "org" }] }
    else if (url.pathname.endsWith("/members")) json = { members: [] }
    else if (url.pathname === "/health") json = { ok: true, version: "test", features }
    else if (url.pathname === "/content") return route.fulfill({ body: markdown, contentType: "text/markdown" })
    else if (url.pathname === "/orgs/org/drives/drive/events") {
      return route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: sse([
          ["ready", { driveId: "drive", at: "2026-10-18T10:00:00.000Z" }],
          ["presence.snapshot", { driveId: "drive", sessions, at: "2026-10-18T10:00:00.000Z" }],
        ]),
      })
    } else if (url.pathname.startsWith("/orgs/org/drives/drive/presence/")) {
      if (request.method() === "PUT") {
        const body = request.postDataJSON()
        puts.push(body)
        json = { session: { ...body, sessionId: url.pathname.split("/").pop(), userId: "qa", email: "qa@example.test", displayName: null, updatedAt: new Date().toISOString() } }
      } else json = { ok: true }
    } else if (url.pathname === "/orgs/org/drives/drive/presence") {
      json = { driveId: "drive", sessions: [olga], at: "2026-10-18T10:00:00.000Z" }
    } else if (url.pathname.endsWith("/ops")) {
      const { op, path } = request.postDataJSON()
      switch (op) {
        case "stat": json = { path, size: markdown.length, contentType: "text/markdown", author: "qa", currentVersion: 1, createdAt: "2026-10-01", modifiedAt: "2026-10-01", isDeleted: false }; break
        case "signed-url": json = { url: `http://fixture.test/content?path=${path}` }; break
        case "comment-list": json = { comments: opts.comments ?? [] }; break
        case "comment-notification-list": json = { notifications: [], unreadCount: 0 }; break
        case "drive-members": json = { members: [] }; break
        case "ls": json = { entries: [] }; break
        case "tree": json = { tree: [] }; break
        // Side panels (reveal, recent, log, ...) degrade gracefully.
        default: return route.abort()
      }
    } else return route.abort()
    await route.fulfill({ json })
  })
  return { requests, puts }
}

const presenceHighlights = (page: Page) =>
  page.evaluate(() => [...CSS.highlights.keys()].filter((name) => name.startsWith("presence-")))

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
})

test("another user on the doc shows in the header, and the view toggles persist", async ({ page }) => {
  const { requests, puts } = await installFixture(page, ["presence"])
  await page.goto("/detail/~/org/drive/notes.md")
  await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible()

  // One avatar: Olga. The user's own other tab is not counted.
  const stack = page.getByRole("button", { name: "1 other person on this file" })
  await expect(stack).toBeVisible()
  expect(requests.some((r) => r.startsWith("GET /orgs/org/drives/drive/events?presence=1&sessionId="))).toBe(true)
  // This tab published the open doc.
  await expect.poll(() => puts.some((p) => p.path === "notes.md" && p.mode === "view")).toBe(true)

  // Her selection, caret and pointer are drawn in the preview.
  const layer = page.locator("[data-presence-layer]")
  await expect(layer.locator(".presence-tag", { hasText: "Olga" })).toHaveCount(2)
  await expect.poll(() => presenceHighlights(page)).toHaveLength(1)

  await stack.click()
  const popover = page.getByRole("dialog")
  await expect(popover.getByText("On this file")).toBeVisible()
  await expect(popover.getByRole("button", { name: "Go to Olga, editing" })).toBeVisible()
  const cursors = popover.getByRole("switch", { name: "See cursors" })
  const selections = popover.getByRole("switch", { name: "See selections" })
  await expect(cursors).toHaveAttribute("aria-checked", "true")
  await expect(selections).toHaveAttribute("aria-checked", "true")

  await cursors.click()
  await expect(cursors).toHaveAttribute("aria-checked", "false")
  await expect(layer.locator(".presence-tag")).toHaveCount(0)
  await selections.click()
  await expect(selections).toHaveAttribute("aria-checked", "false")
  await expect.poll(() => presenceHighlights(page)).toHaveLength(0)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("liveui:presence") ?? "null"))).toEqual({
    showCursors: false,
    showSelections: false,
  })

  // The choice survives a reload.
  await page.reload()
  await page.getByRole("button", { name: "1 other person on this file" }).click()
  await expect(page.getByRole("switch", { name: "See cursors" })).toHaveAttribute("aria-checked", "false")
  await expect(page.getByRole("switch", { name: "See selections" })).toHaveAttribute("aria-checked", "false")
  await expect(page.locator("[data-presence-layer] .presence-tag")).toHaveCount(0)
})

test("the file browser's viewer header shows the avatar stack too", async ({ page }) => {
  await installFixture(page, ["presence"])
  await page.goto("/file/~/org/drive/notes.md")
  await expect(page.getByRole("button", { name: "1 other person on this file" })).toBeVisible()
})

test("a server without presence gets no presence requests and shows nothing", async ({ page }) => {
  const { requests } = await installFixture(page, ["favorites"])
  await page.goto("/detail/~/org/drive/notes.md")
  await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible()
  // Give a presence start (it would follow /health) time to show up.
  await expect.poll(() => requests.some((r) => r.startsWith("GET /health"))).toBe(true)
  await page.waitForTimeout(1_500)

  expect(requests.filter((r) => r.includes("/presence") || r.includes("/events"))).toEqual([])
  await expect(page.locator("[data-presence-avatars]")).toHaveCount(0)
  await expect(page.locator("[data-presence-layer]")).toHaveCount(0)
  expect(await presenceHighlights(page)).toEqual([])
})

test("a comment card shows who is on its thread, and hovering it publishes this tab's comment state", async ({ page }) => {
  const comment = {
    id: "c1",
    path: "notes.md",
    body: "Is the fox brown?",
    quote: { exact: "brown fox" },
    lineStart: 3,
    lineEnd: 3,
    author: "olga",
    authorDisplayName: "Olga",
    resolved: false,
    replyCount: 0,
    createdAt: "2026-10-18T09:00:00.000Z",
    updatedAt: "2026-10-18T09:00:00.000Z",
    replies: [],
  }
  const { puts } = await installFixture(page, ["presence"], {
    sessions: [{ ...olga, commentId: "c1", commentState: "replying" }],
    comments: [comment],
  })
  await page.goto("/detail/~/org/drive/notes.md")

  await expect(page.getByText("Olga is replying...")).toBeVisible()
  await expect(page.getByRole("img", { name: "Olga is replying" })).toBeVisible()

  await page.getByText("Is the fox brown?").hover()
  await expect.poll(() => puts.some((p) => p.commentId === "c1" && p.commentState === "viewing")).toBe(true)
})
