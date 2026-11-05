import { expect, test, type Page } from "@playwright/test"
import { WebhooksFixture } from "./support/webhooks-fixture"

const hookRow = (page: Page, url: string) => page.locator(`[data-webhook-url="${url}"]`)

/** Everything the page could leave a secret in after its dialog closed: DOM, web storage, console. */
async function secretTraces(page: Page, consoleLines: string[]) {
  const where = await page.evaluate(() => ({
    dom: document.documentElement.outerHTML,
    local: JSON.stringify({ ...localStorage }),
    session: JSON.stringify({ ...sessionStorage }),
  }))
  return { ...where, console: consoleLines.join("\n") }
}

function expectNoSecret(traces: Record<string, string>, secrets: string[]) {
  for (const [where, text] of Object.entries(traces)) {
    expect(text, `whsec_ in ${where}`).not.toContain("whsec_")
    for (const s of secrets) expect(text, `secret in ${where}`).not.toContain(s.slice(6))
  }
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
})

test("an org admin creates, tests, disables, rotates and deletes a webhook, and redelivers from the log", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  const fx = new WebhooksFixture()
  await fx.install(page)
  const consoleLines: string[] = []
  page.on("console", (m) => consoleLines.push(m.text()))

  await page.goto("/file/~/org/work/")
  await page.locator("[data-drive-switcher]").click()
  await page.getByRole("menuitem", { name: /Webhooks/ }).click()
  await expect(page).toHaveURL(/\/webhooks\/~\/org\/work$/)
  await expect(page.getByRole("heading", { name: "Webhooks" })).toBeVisible()
  // The org admin sees the org-wide hook next to the drive's own.
  await expect(hookRow(page, "https://ops.example.test/agent-fs").getByText("Every drive in the org")).toBeVisible()
  await expect(hookRow(page, "https://hooks.example.test/comments")).toBeVisible()
  expect(fx.calls[0]).toBe('webhook-list {"scope":"all"}')

  // Create: the secret shows once, with copy.
  await page.getByRole("button", { name: "New webhook" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Endpoint URL").fill("https://new.example.test/hook")
  await dialog.getByLabel("Description").fill("Mentions to triage")
  await dialog.getByLabel("Comment deleted").uncheck()
  await expect(dialog.getByLabel("Scope")).toHaveValue("drive")
  await dialog.getByRole("button", { name: "Create webhook" }).click()
  await expect(dialog.getByRole("heading", { name: "Webhook created" })).toBeVisible()
  const first = fx.secrets[0]
  await expect(dialog.getByRole("textbox", { name: "Signing secret" })).toHaveValue(first)
  await dialog.getByRole("button", { name: "Copy signing secret" }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first)
  expect(fx.calls.at(-2)).toContain('"eventTypes":["comment.created","comment.mentioned","comment.updated","comment.resolved","comment.reopened"]')
  await dialog.getByRole("button", { name: "Done", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)

  const row = hookRow(page, "https://new.example.test/hook")
  await expect(row).toBeVisible()
  expectNoSecret(await secretTraces(page, consoleLines), fx.secrets)
  // Reopening the dialog starts from an empty form, not the last secret.
  await page.getByRole("button", { name: "New webhook" }).click()
  await expect(page.getByRole("dialog").getByRole("textbox", { name: "Signing secret" })).toHaveCount(0)
  await expect(page.getByRole("dialog").getByLabel("Endpoint URL")).toHaveValue("")
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)

  // Test: the receiver's answer shows inline on the row.
  await row.getByRole("button", { name: "Test", exact: true }).click()
  await expect(row.locator("[data-webhook-test-result]")).toHaveText("Ping delivered: HTTP 200 · 42 ms")

  // Disable, then enable.
  const toggle = row.getByRole("switch", { name: "Enabled: https://new.example.test/hook" })
  await toggle.click()
  await expect(row.getByText("Disabled", { exact: true })).toBeVisible()
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect(row.getByText("Disabled", { exact: true })).toHaveCount(0)
  expect(fx.calls.filter((c) => c.startsWith("webhook-update")).map((c) => JSON.parse(c.slice(15)).enabled)).toEqual([false, true])

  // Rotate: a new secret, once, and the old one is gone from the page.
  await row.getByRole("button", { name: "Rotate secret", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Rotate secret", exact: true }).click()
  await expect(page.getByRole("dialog").getByRole("heading", { name: "New signing secret" })).toBeVisible()
  const second = fx.secrets[1]
  expect(second).not.toBe(first)
  await expect(page.getByRole("dialog").getByRole("textbox", { name: "Signing secret" })).toHaveValue(second)
  await page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  expectNoSecret(await secretTraces(page, consoleLines), fx.secrets)

  // Delivery log of the seeded hook: redeliver the failed one.
  const comments = hookRow(page, "https://hooks.example.test/comments")
  await comments.getByRole("button", { name: "Deliveries", exact: true }).click()
  const failed = comments.locator('[data-delivery-id="dl_failed"]')
  await expect(failed).toContainText("HTTP 500 · Internal Server Error")
  await expect(failed).toContainText("8 attempts")
  await failed.getByRole("button", { name: "Redeliver", exact: true }).click()
  await expect(failed.getByText("pending", { exact: true })).toBeVisible()
  expect(fx.calls).toContain('webhook-redeliver {"deliveryId":"dl_failed"}')

  // Delete.
  await row.getByRole("button", { name: "Delete https://new.example.test/hook" }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Delete webhook" }).click()
  await expect(row).toHaveCount(0)
  expect(fx.hooks.map((h) => h.url)).not.toContain("https://new.example.test/hook")

  expectNoSecret(await secretTraces(page, consoleLines), fx.secrets)
})

test("redeliver is off while the webhook is disabled", async ({ page }) => {
  const fx = new WebhooksFixture()
  fx.hooks[0].enabled = false
  fx.hooks[0].disabledReason = "failing"
  await fx.install(page)
  await page.goto("/webhooks/~/org/work")

  const comments = hookRow(page, "https://hooks.example.test/comments")
  await expect(comments.getByText("Disabled after repeated failures")).toBeVisible()
  await comments.getByRole("button", { name: "Deliveries", exact: true }).click()
  await expect(comments.getByText("Turn the webhook on to redeliver.")).toBeVisible()
  await expect(comments.locator('[data-delivery-id="dl_failed"]').getByRole("button", { name: "Redeliver", exact: true })).toBeDisabled()
})

test("a drive admin who is not an org admin sees only the drive's hooks and cannot pick org scope", async ({ page }) => {
  const fx = new WebhooksFixture({ orgAdmin: false })
  await fx.install(page)
  await page.goto("/webhooks/~/org/work")

  await expect(hookRow(page, "https://hooks.example.test/comments")).toBeVisible()
  await expect(hookRow(page, "https://ops.example.test/agent-fs")).toHaveCount(0)
  await page.getByRole("button", { name: "New webhook" }).click()
  await expect(page.getByRole("dialog").getByLabel("Endpoint URL")).toBeVisible()
  await expect(page.getByRole("dialog").getByLabel("Scope")).toHaveCount(0)
})

test("a member who is not an admin never sees the page or its menu entry", async ({ page }) => {
  const fx = new WebhooksFixture({ orgAdmin: false, driveAdmin: false })
  await fx.install(page)

  await page.goto("/file/~/org/work/")
  await page.locator("[data-drive-switcher]").click()
  await expect(page.getByRole("menuitem", { name: /Members/ })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: /Webhooks/ })).toHaveCount(0)
  await page.keyboard.press("Escape")

  await page.goto("/webhooks/~/org/work")
  await expect(page.getByText("Only drive admins and org admins manage this drive's webhooks.")).toBeVisible()
  await expect(page.getByRole("button", { name: "New webhook" })).toHaveCount(0)
  await expect(page.getByRole("list", { name: "Webhooks" })).toHaveCount(0)
  await expect(page.getByText("hooks.example.test")).toHaveCount(0)
  // The gate holds the list request back entirely.
  expect(fx.calls).toEqual([])
})

test("when the server refuses the list, the page shows the gate, not the hooks", async ({ page }) => {
  const fx = new WebhooksFixture()
  fx.listForbidden = true
  await fx.install(page)
  await page.goto("/webhooks/~/org/work")

  await expect(page.getByText("Only drive admins and org admins manage this drive's webhooks.")).toBeVisible()
  await expect(page.getByRole("button", { name: "New webhook" })).toHaveCount(0)
  expect(fx.calls).toEqual(['webhook-list {"scope":"all"}'])
})
