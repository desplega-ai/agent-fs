import { describe, expect, test } from "bun:test"
import { buildAcceptLink, describeTimeLeft, supportsInvites } from "../invites"

const TOKEN = "t".repeat(43)

describe("buildAcceptLink", () => {
  test("puts the API endpoint in the link so a browser with no saved account can open it", () => {
    const link = buildAcceptLink({ token: TOKEN, endpoint: "https://api.example.com/", origin: "https://live.example.com" })
    const url = new URL(link)
    expect(url.origin + url.pathname).toBe(`https://live.example.com/invite/${TOKEN}`)
    expect(url.searchParams.get("apiUrl")).toBe("https://api.example.com")
  })

  test("keeps the server's own accept URL when it has one", () => {
    const link = buildAcceptLink({
      token: TOKEN,
      endpoint: "https://api.example.com",
      acceptUrl: `https://app.example.com/invite/${TOKEN}`,
      origin: "https://ignored.example.com",
    })
    expect(link).toBe(`https://app.example.com/invite/${TOKEN}?apiUrl=https%3A%2F%2Fapi.example.com`)
  })
})

describe("describeTimeLeft", () => {
  const now = Date.parse("2026-10-27T12:00:00Z")
  const at = (ms: number) => new Date(now + ms).toISOString()

  test("counts days, then hours", () => {
    expect(describeTimeLeft(at(7 * 86_400_000), now)).toBe("in 7 days")
    expect(describeTimeLeft(at(86_400_000), now)).toBe("in 1 day")
    expect(describeTimeLeft(at(5 * 3_600_000), now)).toBe("in 5 hours")
    expect(describeTimeLeft(at(60_000), now)).toBe("in 1 hour")
  })

  test("a past expiry reads expired", () => {
    expect(describeTimeLeft(at(-1), now)).toBe("expired")
  })
})

describe("supportsInvites", () => {
  test("needs both invite features: older servers ignore the drive list", () => {
    expect(supportsInvites({ ok: true, version: "1", features: ["drive-invites", "pending-invites"] })).toBe(true)
    expect(supportsInvites({ ok: true, version: "1", features: ["drive-invites"] })).toBe(false)
    expect(supportsInvites({ ok: true, version: "1" })).toBe(false)
    expect(supportsInvites(undefined)).toBe(false)
  })
})
