import { describe, expect, test } from "bun:test"
import { describeRequestError, isRateLimitError } from "../request-errors"

function apiError(status: number, error: string, message: string) {
  return Object.assign(new Error(message), { error, status })
}

describe("describeRequestError", () => {
  test("turns the rate limiter into a retry instruction", () => {
    const err = apiError(429, "RATE_LIMITED", "Too many requests")
    expect(isRateLimitError(err)).toBe(true)
    expect(describeRequestError(err)).toBe(
      "The server is busy right now. Wait a few seconds, then retry.",
    )
  })

  test("maps auth, server and network failures", () => {
    expect(describeRequestError(apiError(401, "UNAUTHORIZED", "Unauthorized"))).toContain("Sign in again")
    expect(describeRequestError(apiError(503, "UNKNOWN", "Service Unavailable"))).toContain("server hit an error")
    expect(describeRequestError(new TypeError("Failed to fetch"))).toContain("Couldn't reach the server")
  })

  test("keeps specific server messages and falls back for unknown values", () => {
    expect(describeRequestError(apiError(400, "INVALID", "Pattern is too long"))).toBe("Pattern is too long")
    expect(describeRequestError(null, "The file search request failed.")).toBe(
      "The file search request failed.",
    )
    expect(isRateLimitError(apiError(500, "INTERNAL", "boom"))).toBe(false)
  })
})
