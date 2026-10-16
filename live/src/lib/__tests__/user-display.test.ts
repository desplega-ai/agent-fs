import { expect, test } from "bun:test"
import { buildUserDirectory, formatUserDisplay } from "../user-display"

const ADA = "33270fa4-1b2c-4d5e-8f90-123456789abc"
const BOB = "8c1d2e3f-4a5b-4c6d-8e7f-0123456789ab"

test("prefers a name carried by the payload over the directory", () => {
  const directory = buildUserDirectory([
    [{ userId: ADA, email: "ada@example.com", displayName: "Ada" }],
  ])
  expect(formatUserDisplay(ADA, "Ada Lovelace", directory.get(ADA))).toBe(
    "Ada Lovelace",
  )
})

test("falls back from display name to email to a shortened id", () => {
  const directory = buildUserDirectory([
    [
      { userId: ADA, email: "ada@example.com", displayName: "Ada Lovelace" },
      { userId: BOB, email: "bob@example.com", displayName: null },
    ],
  ])

  expect(formatUserDisplay(ADA, undefined, directory.get(ADA))).toBe("Ada Lovelace")
  expect(formatUserDisplay(BOB, undefined, directory.get(BOB))).toBe("bob@example.com")
  expect(formatUserDisplay(BOB, "  ", directory.get(BOB))).toBe("bob@example.com")
  expect(formatUserDisplay(ADA, undefined, null)).toBe("33270fa4")
})

test("resolves names for non-admins from drive members when the org list is absent", () => {
  // The org member endpoint is admin-only, so most users never get it.
  const directory = buildUserDirectory([
    [],
    [{ userId: ADA, email: "ada@example.com", displayName: "Ada Lovelace" }],
    undefined,
  ])
  expect(formatUserDisplay(ADA, undefined, directory.get(ADA))).toBe("Ada Lovelace")
})

test("a later source fills gaps without overriding an earlier name", () => {
  const directory = buildUserDirectory([
    [{ userId: ADA, email: "ada@example.com", displayName: null }],
    [{ userId: ADA, email: "ada@example.com", displayName: "Ada Lovelace" }],
    [{ userId: ADA, email: "other@example.com" }],
  ])
  expect(directory.get(ADA)).toEqual({
    email: "ada@example.com",
    displayName: "Ada Lovelace",
  })
})

test("shortens long email local parts", () => {
  expect(formatUserDisplay(BOB, undefined, { email: "verylongname@example.com", displayName: null })).toBe(
    "ver...@example.com",
  )
})
