import { expect, test, type Page } from "@playwright/test"

type Status = "active" | "expired" | "exhausted" | "revoked"
interface Link {
  id: string
  driveId: string
  path: string
  kind: "file" | "site"
  status: Status
  createdBy: string
  expiresAt: string | null
}

const DRIVES: Record<string, string> = { drive: "QA", other: "Research" }
const ME = "qa"

/**
 * Production app shell against deterministic API fixtures; no live account.
 * The fixture keeps share links in memory, answers `share-list` the way the
 * server does (exact + covering for a path, the caller's own links for
 * `mine`), and records every share op with the drive it was sent to.
 */
async function installFixture(page: Page, features = ["share-links", "share-no-expiry", "share-list"]) {
  const links: Link[] = []
  const calls: string[] = []
  let minted = 0
  await page.addInitScript(() => {
    localStorage.setItem("agent-fs-credentials", JSON.stringify([
      { id: "qa", name: "QA", endpoint: "http://fixture.test", apiKey: "fixture" },
    ]))
    localStorage.setItem("agent-fs-active-credential", "qa")
  })
  await page.route("http://fixture.test/**", async route => {
    const url = new URL(route.request().url())
    let json: unknown
    if (url.pathname === "/auth/me") json = { userId: ME, email: "qa@example.test", displayName: "QA", defaultOrgId: "org", defaultDriveId: "drive" }
    else if (url.pathname === "/orgs") json = { orgs: [{ id: "org", name: "QA" }] }
    else if (url.pathname.endsWith("/drives")) json = { drives: Object.entries(DRIVES).map(([id, name]) => ({ id, name, orgId: "org" })) }
    else if (url.pathname === "/health") json = { ok: true, version: "test", features }
    else if (url.pathname.endsWith("/ops")) {
      const body = route.request().postDataJSON()
      const norm = body.path ? `/${String(body.path).replace(/^\/+|\/+$/g, "")}` : "/"
      switch (body.op) {
        case "ls": json = { entries: norm === "/" ? [{ name: "docs", type: "directory", size: 0 }] : [{ name: "a.md", type: "file", size: 4, modifiedAt: "2026-10-01T10:00:00.000Z" }] }; break
        case "stat": json = { path: norm, size: 4, contentType: "text/markdown", author: "qa", currentVersion: 1, createdAt: "2026-10-01", modifiedAt: "2026-10-01", isDeleted: false }; break
        case "cat": json = { content: "# A\n", totalLines: 1, truncated: false }; break
        case "comment-list": json = { comments: [] }; break
        case "comment-notification-list": json = { notifications: [], unreadCount: 0 }; break
        case "favorite-list": json = { favorites: [] }; break
        case "share-create": {
          minted += 1
          const id = `new-${minted}`
          calls.push(`create ${body.driveId} ${norm}`)
          links.unshift({ id, driveId: body.driveId, path: norm, kind: "file", status: "active", createdBy: ME, expiresAt: "2026-11-06T12:00:00.000Z" })
          json = { url: `http://fixture.test/share/tok${minted}`, sharePath: `/share/tok${minted}`, expiresAt: "2026-11-06T12:00:00.000Z", expiresIn: 86400, kind: "file" }
          break
        }
        case "share-list": {
          calls.push(`list ${body.scope ?? "drive"} ${body.driveId}${body.path ? ` ${norm}` : ""}`)
          const covers = (l: Link) => l.kind === "site" && (l.path === "/" || norm.startsWith(`${l.path}/`))
          const rows = links
            .filter((l) => body.includeInactive || l.status === "active")
            .filter((l) => body.scope === "mine"
              ? l.createdBy === ME
              : l.driveId === body.driveId && (!body.path || l.path === norm || covers(l)))
            .map((l) => ({
              id: l.id,
              drive: { id: l.driveId, name: DRIVES[l.driveId] },
              path: l.path,
              kind: l.kind,
              ...(body.path && body.scope !== "mine" ? { relation: l.path === norm ? "exact" : "covering" } : {}),
              status: l.status,
              createdAt: "2026-11-05T10:00:00.000Z",
              createdBy: { userId: l.createdBy, email: `${l.createdBy}@example.test`, displayName: l.createdBy === ME ? "QA" : "Bo" },
              expiresAt: l.expiresAt,
              views: 2,
              maxViews: null,
              lastViewedAt: null,
              revokedAt: l.status === "revoked" ? "2026-11-05T11:00:00.000Z" : null,
              canRevoke: true,
            }))
          json = { shares: rows, total: rows.length, limit: 100, offset: 0, scope: body.scope ?? "drive", visibility: body.scope === "mine" ? "own" : "all" }
          break
        }
        case "share-revoke": {
          calls.push(`revoke ${body.driveId} ${body.id}`)
          const link = links.find((l) => l.id === body.id && l.driveId === body.driveId && l.status === "active")
          if (link) link.status = "revoked"
          json = { revoked: link ? 1 : 0, ids: link ? [link.id] : [] }
          break
        }
        default: return route.abort()
      }
    } else return route.abort()
    await route.fulfill({ json })
  })
  return { links, calls }
}

function seed(links: Link[]) {
  links.push(
    { id: "exact-1", driveId: "drive", path: "/docs/a.md", kind: "file", status: "active", createdBy: ME, expiresAt: "2026-11-06T12:00:00.000Z" },
    { id: "exact-2", driveId: "drive", path: "/docs/a.md", kind: "file", status: "active", createdBy: "bo", expiresAt: null },
    { id: "site-1", driveId: "drive", path: "/docs", kind: "site", status: "active", createdBy: ME, expiresAt: "2026-11-08T12:00:00.000Z" },
    { id: "other-1", driveId: "other", path: "/paper.md", kind: "file", status: "active", createdBy: ME, expiresAt: null },
  )
}

async function openShareDialog(page: Page) {
  await page.goto("/file/~/org/drive/docs/a.md")
  await page.getByRole("button", { name: "Share", exact: true }).first().click()
  return page.getByRole("dialog")
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
})

test("the share dialog lists exact and covering links and revokes one", async ({ page }) => {
  const { links, calls } = await installFixture(page)
  seed(links)
  const dialog = await openShareDialog(page)
  const list = dialog.getByRole("region", { name: "Existing links" })
  await expect(list.getByText("Existing links (3)")).toBeVisible()
  await expect(list.getByText("Shared via folder /docs")).toBeVisible()
  await expect(list.getByText("Never expires")).toBeVisible()
  await expect(list.getByText(/by Bo/)).toBeVisible()
  expect(calls).toContain("list drive drive /docs/a.md")

  await list.getByRole("button", { name: "Revoke link" }).first().click()
  await list.getByRole("button", { name: "Confirm revoke link" }).click()
  await expect(list.getByText("Existing links (2)")).toBeVisible()
  expect(calls).toContain("revoke drive exact-1")

  // The revoked link is still there under "Show inactive".
  await list.getByRole("switch").click()
  await expect(list.getByText("Revoked")).toBeVisible()
})

test("creating a link adds it to the dialog list", async ({ page }) => {
  const { calls } = await installFixture(page)
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  const dialog = await openShareDialog(page)
  await expect(dialog.getByRole("region", { name: "Existing links" })).toHaveCount(0)
  await dialog.getByRole("button", { name: "Copy link" }).click()
  await expect(dialog.getByRole("region", { name: "Existing links" }).getByText("Existing links (1)")).toBeVisible()
  expect(calls).toContain("create drive /docs/a.md")
})

test("the Shared links page lists links from every drive and revokes on the link's own drive", async ({ page }) => {
  const { links, calls } = await installFixture(page)
  seed(links)
  await page.goto("/files")
  await page.getByRole("button", { name: /QA/ }).last().click()
  await page.getByRole("menuitem", { name: "Shared links" }).click()
  await expect(page).toHaveURL(/\/shares\/~\/org\/drive$/)

  const list = page.getByRole("list", { name: "Shared links" })
  await expect(list.getByRole("listitem")).toHaveCount(3)
  await expect(list.getByText("/paper.md")).toBeVisible()
  await expect(list.getByText("Research")).toBeVisible()

  // Revoke the row in the other drive: the request names that drive, not the active one.
  const row = list.getByRole("listitem").filter({ hasText: "/paper.md" })
  await row.getByRole("button", { name: "Revoke link to /paper.md" }).click()
  await row.getByRole("button", { name: "Confirm revoke link to /paper.md" }).click()
  await expect(list.getByRole("listitem")).toHaveCount(2)
  expect(calls).toContain("revoke other other-1")

  await page.getByRole("radio", { name: "All" }).or(page.getByRole("button", { name: "All", exact: true })).first().click()
  await expect(list.getByRole("listitem")).toHaveCount(3)
  await expect(list.getByRole("listitem").filter({ hasText: "/paper.md" }).getByText("Revoked")).toBeVisible()

  // Drive filter narrows the loaded rows.
  await page.getByRole("combobox", { name: "Drive" }).selectOption({ label: "Research" })
  await expect(list.getByRole("listitem")).toHaveCount(1)
})

test("servers without share-list get no menu item, no dialog list and no request", async ({ page }) => {
  const { links, calls } = await installFixture(page, ["share-links"])
  seed(links)
  const dialog = await openShareDialog(page)
  await expect(dialog.getByRole("button", { name: "Copy link" })).toBeVisible()
  await expect(dialog.getByRole("region", { name: "Existing links" })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: /QA/ }).last().click()
  await expect(page.getByRole("menuitem", { name: "API keys" })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "Shared links" })).toHaveCount(0)
  expect(calls.filter((c) => c.startsWith("list"))).toEqual([])
})

test("the Shared links page fits a 390 px phone", async ({ page }) => {
  const { links } = await installFixture(page)
  seed(links)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/shares/~/org/drive")
  await expect(page.getByRole("list", { name: "Shared links" }).getByRole("listitem")).toHaveCount(3)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
