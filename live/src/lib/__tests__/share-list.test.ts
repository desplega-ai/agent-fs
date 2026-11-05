import { describe, expect, test } from "bun:test"
import {
  coveringLabel,
  creatorLabel,
  driveOptions,
  expiryLabel,
  formatWhen,
  lifetimeLabel,
  lifetimeTitle,
  shareListQueryPrefix,
  statusLabel,
  supportsShareList,
  viewsLabel,
} from "../share-list"

describe("supportsShareList", () => {
  test("only a server that lists the feature shows the views", () => {
    expect(supportsShareList({ ok: true, version: "1", features: ["share-links", "share-list"] })).toBe(true)
    expect(supportsShareList({ ok: true, version: "1", features: ["share-links"] })).toBe(false)
    expect(supportsShareList({ ok: true, version: "1" })).toBe(false)
    expect(supportsShareList(undefined)).toBe(false)
  })
})

describe("shareListQueryPrefix", () => {
  test("keys by account, endpoint and org so accounts never share an entry", () => {
    expect(shareListQueryPrefix("a", "http://x", "org")).toEqual(["share-list", "a", "http://x", "org"])
    expect(shareListQueryPrefix("a", "http://x", "org")).not.toEqual(shareListQueryPrefix("b", "http://x", "org"))
  })
})

describe("statusLabel", () => {
  test("names every status", () => {
    expect(statusLabel("active")).toBe("Active")
    expect(statusLabel("expired")).toBe("Expired")
    expect(statusLabel("exhausted")).toBe("Used up")
    expect(statusLabel("revoked")).toBe("Revoked")
  })
})

describe("expiryLabel", () => {
  const now = Date.parse("2026-11-05T12:00:00.000Z")
  test("null never expires", () => {
    expect(expiryLabel(null, now)).toBe("Never")
  })
  test("minutes, hours and days, past and future", () => {
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
    expect(expiryLabel("2026-11-05T12:30:00.000Z", now)).toBe(rtf.format(30, "minute"))
    expect(expiryLabel("2026-11-05T15:00:00.000Z", now)).toBe(rtf.format(3, "hour"))
    expect(expiryLabel("2026-11-08T12:00:00.000Z", now)).toBe(rtf.format(3, "day"))
    expect(expiryLabel("2026-11-03T12:00:00.000Z", now)).toBe(rtf.format(-2, "day"))
  })
  test("an unparseable date does not throw", () => {
    expect(expiryLabel("nope", now)).toBe("Unknown")
  })
})

describe("lifetimeLabel", () => {
  const now = Date.parse("2026-11-05T12:00:00.000Z")
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
  test("revoked shows when, not the expiry it never reached", () => {
    expect(lifetimeLabel({ status: "revoked", expiresAt: "2026-11-08T12:00:00.000Z", revokedAt: "2026-11-05T11:30:00.000Z" }, now))
      .toBe(`Revoked ${rtf.format(-30, "minute")}`)
  })
  test("never, expired and active", () => {
    expect(lifetimeLabel({ status: "active", expiresAt: null, revokedAt: null }, now)).toBe("Never expires")
    expect(lifetimeLabel({ status: "expired", expiresAt: "2026-11-05T10:00:00.000Z", revokedAt: null }, now))
      .toBe(`Expired ${rtf.format(-2, "hour")}`)
    expect(lifetimeLabel({ status: "active", expiresAt: "2026-11-06T12:00:00.000Z", revokedAt: null }, now))
      .toBe(`Expires ${rtf.format(24, "hour")}`)
  })
})

describe("lifetimeTitle", () => {
  test("revoked points at revokedAt, never-expiring has none", () => {
    expect(lifetimeTitle({ status: "revoked", expiresAt: "2026-11-08T12:00:00.000Z", revokedAt: "2026-11-05T11:30:00.000Z" }))
      .toBe(formatWhen("2026-11-05T11:30:00.000Z"))
    expect(lifetimeTitle({ status: "active", expiresAt: null, revokedAt: null })).toBeUndefined()
    expect(lifetimeTitle({ status: "expired", expiresAt: "2026-11-05T10:00:00.000Z", revokedAt: null }))
      .toBe(formatWhen("2026-11-05T10:00:00.000Z"))
  })
})

describe("viewsLabel", () => {
  test("with and without a view limit", () => {
    expect(viewsLabel(0, null)).toBe("0 views")
    expect(viewsLabel(1, null)).toBe("1 view")
    expect(viewsLabel(1, 1)).toBe("1 of 1 view")
    expect(viewsLabel(2, 5)).toBe("2 of 5 views")
  })
})

describe("coveringLabel", () => {
  test("only covering links get a label", () => {
    expect(coveringLabel({ relation: "exact", path: "/a.md" })).toBeNull()
    expect(coveringLabel({ path: "/a.md" })).toBeNull()
    expect(coveringLabel({ relation: "covering", path: "/docs" })).toBe("Shared via folder /docs")
    expect(coveringLabel({ relation: "covering", path: "/" })).toBe("Shared via folder / (whole drive)")
  })
})

describe("creatorLabel", () => {
  test("prefers the display name, then the email, then a deleted user", () => {
    expect(creatorLabel({ createdBy: { userId: "u", email: "a@b.c", displayName: "Ana" } })).toBe("Ana")
    expect(creatorLabel({ createdBy: { userId: "u", email: "a@b.c", displayName: null } })).toBe("a@b.c")
    expect(creatorLabel({ createdBy: { userId: "u", email: null, displayName: null } })).toBe("a former member")
  })
})

describe("driveOptions", () => {
  test("one entry per drive, sorted by name, id when the drive is gone", () => {
    expect(
      driveOptions([
        { drive: { id: "2", name: "Zeta" } },
        { drive: { id: "1", name: "Alpha" } },
        { drive: { id: "2", name: "Zeta" } },
        { drive: { id: "3", name: null } },
      ]),
    ).toEqual([
      { id: "3", name: "3" },
      { id: "1", name: "Alpha" },
      { id: "2", name: "Zeta" },
    ])
  })
})
