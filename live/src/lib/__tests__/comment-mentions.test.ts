import { describe, expect, test } from "bun:test"
import type { DriveMember } from "@/api/types"
import {
  collectMentions,
  filterMentionCandidates,
  findMentionQuery,
  insertMention,
  mentionLabel,
  supportsCommentMentions,
} from "../comment-mentions"

const ada: DriveMember = { userId: "u-ada", email: "ada@example.test", displayName: "Ada Lovelace" }
const grace: DriveMember = { userId: "u-grace", email: "grace@example.test", displayName: "Grace Hopper" }
const bot: DriveMember = { userId: "u-bot", email: "review-bot@agents.test", displayName: null }
const members = [ada, grace, bot]

describe("supportsCommentMentions", () => {
  test("needs the comment-mentions feature", () => {
    expect(supportsCommentMentions({ features: ["comment-mentions"] })).toBe(true)
    expect(supportsCommentMentions({ features: ["favorites"] })).toBe(false)
    expect(supportsCommentMentions(undefined)).toBe(false)
  })
})

describe("findMentionQuery", () => {
  test("opens on @ at the start, after whitespace or a bracket", () => {
    expect(findMentionQuery("@", 1)).toEqual({ start: 0, end: 1, query: "" })
    expect(findMentionQuery("hi @gr", 6)).toEqual({ start: 3, end: 6, query: "gr" })
    expect(findMentionQuery("line\n@a", 7)).toEqual({ start: 5, end: 7, query: "a" })
    expect(findMentionQuery("(@a", 3)).toEqual({ start: 1, end: 3, query: "a" })
  })

  test("reads only the text before the caret", () => {
    expect(findMentionQuery("hi @grace there", 6)).toEqual({ start: 3, end: 6, query: "gr" })
  })

  test("stays closed inside an email, after a space, or without @", () => {
    expect(findMentionQuery("ada@example", 11)).toBeNull()
    expect(findMentionQuery("@ada done", 9)).toBeNull()
    expect(findMentionQuery("no mention", 10)).toBeNull()
  })
})

describe("filterMentionCandidates", () => {
  test("an empty query lists everyone but the signed-in user, by label", () => {
    expect(filterMentionCandidates(members, "", "u-grace").map((m) => m.userId)).toEqual([
      "u-ada",
      "u-bot",
    ])
  })

  test("matches name, a word of the name, or email, name prefix first", () => {
    expect(filterMentionCandidates(members, "HOP").map((m) => m.userId)).toEqual(["u-grace"])
    expect(filterMentionCandidates(members, "rev").map((m) => m.userId)).toEqual(["u-bot"])
    const loud = { userId: "u-l", email: "l@example.test", displayName: "Lo Gr" }
    expect(filterMentionCandidates([...members, loud], "gr").map((m) => m.userId)).toEqual([
      "u-grace",
      "u-l",
    ])
  })

  test("caps the list", () => {
    expect(filterMentionCandidates(members, "", undefined, 2)).toHaveLength(2)
  })
})

describe("insertMention", () => {
  test("replaces the typed query with @Label and a space", () => {
    const text = "cc @gr please"
    const result = insertMention(text, findMentionQuery(text, 6)!, grace)
    expect(result).toEqual({ text: "cc @Grace Hopper  please", caret: 17 })
  })

  test("falls back to the email when there is no display name", () => {
    expect(mentionLabel(bot)).toBe("review-bot@agents.test")
    expect(insertMention("@r", { start: 0, end: 2, query: "r" }, bot).text).toBe(
      "@review-bot@agents.test ",
    )
  })
})

describe("collectMentions", () => {
  test("returns user IDs of picked members still in the body, once each", () => {
    expect(collectMentions("@Ada Lovelace and @Ada Lovelace", [ada, ada])).toEqual(["u-ada"])
  })

  test("drops a member whose mention text was deleted", () => {
    expect(collectMentions("only @Grace Hopper", [ada, grace])).toEqual(["u-grace"])
    expect(collectMentions("nobody", [ada])).toEqual([])
  })
})
