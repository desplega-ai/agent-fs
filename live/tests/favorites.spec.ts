import { expect, test, type Page } from "@playwright/test"

type Entry = { name: string; type: "file" | "directory"; size: number; modifiedAt?: string }

const listings: Record<string, Entry[]> = {
  "/": [
    { name: "docs", type: "directory", size: 0 },
    { name: "notes.md", type: "file", size: 8, modifiedAt: "2026-10-01T10:00:00.000Z" },
  ],
  "/docs/": [{ name: "a.md", type: "file", size: 4, modifiedAt: "2026-10-01T10:00:00.000Z" }],
}

/**
 * Production app shell against deterministic API fixtures; no live account.
 * The fixture keeps the user's favorites in memory and records every favorite
 * op, so a test can tell a star toggle from an accidental navigation.
 */
async function installFixture(page: Page, features = ["favorites"]) {
  const favorites = new Map<string, "file" | "directory">()
  const calls: string[] = []
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
    else if (url.pathname === "/health") json = { ok: true, version: "test", features }
    else if (url.pathname.endsWith("/ops")) {
      const { op, path } = route.request().postDataJSON()
      const norm = path ? `/${String(path).replace(/^\/+|\/+$/g, "")}` : "/"
      switch (op) {
        case "ls": {
          const key = norm === "/" ? "/" : `${norm}/`
          json = { entries: listings[key] ?? [] }
          break
        }
        case "stat": json = { path: norm, size: 8, contentType: "text/markdown", author: "qa", currentVersion: 1, createdAt: "2026-10-01", modifiedAt: "2026-10-01", isDeleted: false }; break
        case "cat": json = { content: "# Notes\n", totalLines: 1, truncated: false }; break
        case "comment-list": json = { comments: [] }; break
        case "comment-notification-list": json = { notifications: [], unreadCount: 0 }; break
        case "favorite-list":
          json = { favorites: [...favorites].sort().map(([p, kind]) => ({ path: p, kind, createdAt: "2026-10-10T10:00:00.000Z" })) }
          break
        case "favorite-add": {
          calls.push(`add ${norm}`)
          const kind = listings[`${norm}/`] ? "directory" : "file"
          favorites.set(norm, kind)
          json = { path: norm, kind, createdAt: "2026-10-10T10:00:00.000Z", favorited: true }
          break
        }
        case "favorite-remove":
          calls.push(`remove ${norm}`)
          json = { path: norm, removed: favorites.delete(norm) }
          break
        // Side panels (reveal, recent, ...) degrade gracefully.
        default: return route.abort()
      }
    } else return route.abort()
    await route.fulfill({ json })
  })
  return { favorites, calls }
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
})

test("clicking a tree row's star stars it without opening the file or folder", async ({ page }) => {
  const { calls } = await installFixture(page)
  await page.goto("/files")
  const urlBefore = page.url()
  const tree = page.getByRole("tabpanel", { name: "Tree" })

  await tree.locator('[data-tree-path="notes.md"]').hover()
  await tree.getByRole("button", { name: "Add notes.md to favorites" }).click()
  await expect(tree.getByRole("button", { name: "Remove notes.md from favorites" })).toHaveAttribute("aria-pressed", "true")
  // Every star reads the same list, so the folder view's star follows.
  await expect(page.getByRole("region", { name: "Folder drive root" }).getByRole("button", { name: "Remove notes.md from favorites" })).toBeAttached()

  // A folder star must not expand the folder either.
  await tree.locator('[data-tree-path="docs"]').hover()
  await tree.getByRole("button", { name: "Add docs to favorites" }).click()
  await expect(page.locator('[data-tree-path="docs"]')).toHaveAttribute("data-tree-expanded", "false")

  expect(page.url()).toBe(urlBefore)
  expect(calls).toEqual(["add /notes.md", "add /docs"])
})

test("Enter and Space on a folder-view star toggle it and never open the entry", async ({ page }) => {
  const { calls } = await installFixture(page)
  await page.goto("/file/~/org/drive/docs/")
  const star = page.getByRole("button", { name: "Add a.md to favorites" })
  await expect(star).toBeAttached()
  const urlBefore = page.url()

  await star.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("button", { name: "Remove a.md from favorites" })).toBeFocused()
  await page.keyboard.press("Space")
  await expect(page.getByRole("button", { name: "Add a.md to favorites" })).toBeFocused()

  expect(page.url()).toBe(urlBefore)
  expect(calls).toEqual(["add /docs/a.md", "remove /docs/a.md"])
})

test("the Favorites tab lists stars, opens them, and unstars without navigating", async ({ page }) => {
  const { favorites, calls } = await installFixture(page)
  favorites.set("/docs", "directory")
  favorites.set("/notes.md", "file")
  await page.goto("/files")

  await page.getByRole("tab", { name: "Favorites" }).click()
  const list = page.getByRole("list", { name: "Favorites" })
  await expect(list.getByRole("button", { name: /notes\.md/ }).first()).toBeVisible()
  await expect(list.getByRole("button", { name: /^docs/ }).first()).toBeVisible()

  // Unstar from the list: stays on the same page.
  const urlBefore = page.url()
  await list.getByRole("button", { name: "Remove docs from favorites" }).click()
  await expect(list.getByRole("button", { name: "Remove docs from favorites" })).toHaveCount(0)
  expect(page.url()).toBe(urlBefore)
  expect(calls).toEqual(["remove /docs"])

  // Opening a favorite navigates to it.
  await list.getByRole("button", { name: "notes.md Drive root" }).click()
  await expect(page).toHaveURL(/\/file\/~\/org\/drive\/notes\.md$/)
})

test("the open file's header star toggles the favorite", async ({ page }) => {
  const { calls } = await installFixture(page)
  await page.goto("/file/~/org/drive/notes.md")
  const header = page.getByRole("button", { name: "Add notes.md to favorites" }).first()
  await header.click()
  await expect(page.getByRole("button", { name: "Remove notes.md from favorites" }).first()).toHaveAttribute("aria-pressed", "true")
  await expect(page).toHaveURL(/\/file\/~\/org\/drive\/notes\.md$/)
  expect(calls).toEqual(["add /notes.md"])
})

test("a server without favorites shows no stars and no Favorites tab", async ({ page }) => {
  await installFixture(page, [])
  await page.goto("/files")
  await expect(page.locator('[data-tree-path="notes.md"]')).toBeVisible()
  await expect(page.locator("[data-favorite-toggle]")).toHaveCount(0)
  await expect(page.getByRole("tab", { name: "Favorites" })).toHaveCount(0)
})
