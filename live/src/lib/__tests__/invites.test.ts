import { describe, expect, test } from "bun:test"
import {
  buildAcceptLink,
  describeTimeLeft,
  findOrgMember,
  forgetInviteToken,
  invitesAvailable,
  inviteTokenFromUrl,
  isInviteReturnPath,
  recallInviteToken,
  rememberInviteToken,
  splitDriveGrants,
  supportsInvites,
} from "../invites"

const TOKEN = "t".repeat(43)

describe("buildAcceptLink", () => {
  test("puts the token in the fragment and the API endpoint in the query", () => {
    const link = buildAcceptLink({ token: TOKEN, endpoint: "https://api.example.com/", origin: "https://live.example.com" })
    const url = new URL(link)
    expect(url.origin + url.pathname + url.search).toBe("https://live.example.com/invite?apiUrl=https%3A%2F%2Fapi.example.com")
    expect(url.hash).toBe(`#${TOKEN}`)
  })

  test("the token never appears in what a browser sends: path and query", () => {
    const link = buildAcceptLink({ token: TOKEN, endpoint: "https://api.example.com", origin: "https://live.example.com" })
    const url = new URL(link)
    expect(url.pathname + url.search).not.toContain(TOKEN)
  })

  test("keeps the server's own accept URL when it has one", () => {
    const link = buildAcceptLink({
      token: TOKEN,
      endpoint: "https://api.example.com",
      acceptUrl: `https://app.example.com/invite#${TOKEN}`,
      origin: "https://ignored.example.com",
    })
    expect(link).toBe(`https://app.example.com/invite?apiUrl=https%3A%2F%2Fapi.example.com#${TOKEN}`)
  })
})

describe("inviteTokenFromUrl", () => {
  test("reads the fragment, or the path of a link issued before the fragment form", () => {
    expect(inviteTokenFromUrl(undefined, `#${TOKEN}`)).toBe(TOKEN)
    expect(inviteTokenFromUrl(TOKEN, "")).toBe(TOKEN)
  })

  test("the fragment wins over the path", () => {
    expect(inviteTokenFromUrl("p".repeat(43), `#${TOKEN}`)).toBe(TOKEN)
  })

  test("ignores anything that is not token characters", () => {
    expect(inviteTokenFromUrl(undefined, "")).toBeNull()
    expect(inviteTokenFromUrl(undefined, "#section one")).toBeNull()
    expect(inviteTokenFromUrl("a b", "")).toBeNull()
  })
})

describe("invite token storage", () => {
  const memory = () => {
    const data = new Map<string, string>()
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    }
  }

  test("a token survives a reload until it is forgotten", () => {
    const store = memory()
    expect(recallInviteToken(store)).toBeNull()
    rememberInviteToken(TOKEN, store)
    expect(recallInviteToken(store)).toBe(TOKEN)
    forgetInviteToken(store)
    expect(recallInviteToken(store)).toBeNull()
  })

  test("blocked storage degrades to no token instead of throwing", () => {
    const blocked = {
      getItem: () => { throw new Error("denied") },
      setItem: () => { throw new Error("denied") },
      removeItem: () => { throw new Error("denied") },
    }
    expect(() => rememberInviteToken(TOKEN, blocked)).not.toThrow()
    expect(recallInviteToken(blocked)).toBeNull()
    expect(() => forgetInviteToken(blocked)).not.toThrow()
  })

  test("a stored value that is not token-shaped is not trusted", () => {
    expect(recallInviteToken({ getItem: () => "<script>" })).toBeNull()
  })
})

describe("isInviteReturnPath", () => {
  test("accepts the accept page with or without a legacy path token, and rejects everything else", () => {
    expect(isInviteReturnPath("/invite?apiUrl=https%3A%2F%2Fapi.example.com")).toBe(true)
    expect(isInviteReturnPath("/invite")).toBe(true)
    expect(isInviteReturnPath(`/invite/${TOKEN}?apiUrl=x`)).toBe(true)
    expect(isInviteReturnPath("//evil.example/invite")).toBe(false)
    expect(isInviteReturnPath("https://evil.example/invite")).toBe(false)
    expect(isInviteReturnPath("/invite/../files")).toBe(false)
    expect(isInviteReturnPath("/files")).toBe(false)
  })
})

describe("findOrgMember", () => {
  const members = [{ email: "Ana@Example.test", userId: "ana" }, { email: "qa@example.test", userId: "qa" }]

  test("matches without case or surrounding space", () => {
    expect(findOrgMember(members, "  ana@example.TEST ")?.userId).toBe("ana")
  })

  test("no members yet, or an empty email, matches nobody", () => {
    expect(findOrgMember(undefined, "ana@example.test")).toBeUndefined()
    expect(findOrgMember(members, "  ")).toBeUndefined()
    expect(findOrgMember(members, "other@example.test")).toBeUndefined()
  })
})

describe("splitDriveGrants", () => {
  test("a drive the person already has a role on is kept with that role, never granted again", () => {
    const { add, kept } = splitDriveGrants(
      [
        { driveId: "ledger", role: "viewer" },
        { driveId: "context", role: "editor" },
      ],
      { ledger: "admin", context: undefined },
    )
    expect(kept).toEqual([{ driveId: "ledger", role: "admin" }])
    expect(add).toEqual([{ driveId: "context", role: "editor" }])
  })

  test("nothing held yet: everything is added", () => {
    const grants = [{ driveId: "work", role: "viewer" as const }]
    expect(splitDriveGrants(grants, {})).toEqual({ add: grants, kept: [] })
  })
})

describe("invitesAvailable", () => {
  const health = { ok: true, version: "1", features: ["drive-invites", "pending-invites"] }

  test("a failed refetch keeps the old health data but hides the controls", () => {
    expect(invitesAvailable({ isSuccess: true, data: health })).toBe(true)
    // react-query keeps `data` after a failed refetch and flips the status to error.
    expect(invitesAvailable({ isSuccess: false, data: health })).toBe(false)
  })

  test("still loading: hidden", () => {
    expect(invitesAvailable({ isSuccess: false, data: undefined })).toBe(false)
  })

  test("success without the features: hidden", () => {
    expect(invitesAvailable({ isSuccess: true, data: { ok: true, version: "1", features: ["drive-invites"] } })).toBe(false)
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
