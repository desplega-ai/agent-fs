import { describe, expect, test } from "bun:test"
import { deliveryOutcome, disabledLabel, splitSecret, WEBHOOK_EVENT_TYPES } from "../webhooks"
import type { WebhookWithSecret } from "@/api/types"

describe("splitSecret", () => {
  test("returns the webhook without the secret field", () => {
    const res = { id: "wh_1", url: "https://x.test", secret: "whsec_abc" } as unknown as WebhookWithSecret
    const { webhook, secret } = splitSecret(res)
    expect(secret).toBe("whsec_abc")
    expect("secret" in webhook).toBe(false)
    expect(JSON.stringify(webhook)).not.toContain("whsec_")
  })
})

describe("WEBHOOK_EVENT_TYPES", () => {
  test("lists the six comment events core accepts, once each", () => {
    const values = WEBHOOK_EVENT_TYPES.map((e) => e.value)
    expect(new Set(values).size).toBe(6)
    expect(values.every((v) => v.startsWith("comment."))).toBe(true)
  })
})

describe("disabledLabel", () => {
  test("null while enabled", () => {
    expect(disabledLabel({ enabled: true, disabledReason: null })).toBeNull()
  })
  test("names the reason", () => {
    expect(disabledLabel({ enabled: false, disabledReason: "gone" })).toContain("410")
    expect(disabledLabel({ enabled: false, disabledReason: "failing" })).toContain("failures")
    expect(disabledLabel({ enabled: false, disabledReason: "manual" })).toBe("Disabled")
  })
})

describe("deliveryOutcome", () => {
  test("joins status code and error", () => {
    expect(deliveryOutcome({ status: "failed", lastStatusCode: 500, lastError: "Internal", attempts: 3 })).toBe("HTTP 500 · Internal")
  })
  test("describes a pending row with no answer yet", () => {
    expect(deliveryOutcome({ status: "pending", lastStatusCode: null, lastError: null, attempts: 0 })).toBe("Not sent yet")
    expect(deliveryOutcome({ status: "pending", lastStatusCode: null, lastError: null, attempts: 2 })).toBe("Retrying")
  })
})
