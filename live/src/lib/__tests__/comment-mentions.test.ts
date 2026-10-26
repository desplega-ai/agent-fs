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

  test("opens after a quote or a colon", () => {
    expect(findMentionQuery('"@a', 3)).toEqual({ start: 1, end: 3, query: "a" })
    expect(findMentionQuery("'@a", 3)).toEqual({ start: 1, end: 3, query: "a" })
    expect(findMentionQuery("\u201C@a", 3)).toEqual({ start: 1, end: 3, query: "a" })
    expect(findMentionQuery("cc:@a", 5)).toEqual({ start: 3, end: 5, query: "a" })
  })

  test("stays closed after a character that can end an email local part", () => {
    expect(findMentionQuery("ada+@", 5)).toBeNull()
    expect(findMentionQuery("ada-@", 5)).toBeNull()
    expect(findMentionQuery("ada%@", 5)).toBeNull()
    expect(findMentionQuery("ada.@ex", 7)).toBeNull()
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

  test("drops a mention whose token was extended past the label", () => {
    expect(collectMentions("cc @Ada LovelaceX", [ada])).toEqual([])
    expect(collectMentions("cc @Ada Lovelace_2", [ada])).toEqual([])
  })

  test("a shorter picked label does not match inside a longer one", () => {
    const shortAda: DriveMember = { userId: "u-ada2", email: "ada2@example.test", displayName: "Ada" }
    expect(collectMentions("cc @Ada Lovelace", [shortAda, ada])).toEqual(["u-ada"])
    expect(collectMentions("cc @Ada LovelaceX", [shortAda, ada])).toEqual([])
    expect(collectMentions("@Ada and @Ada Lovelace", [shortAda, ada]).sort()).toEqual([
      "u-ada",
      "u-ada2",
    ])
  })

  test("an intact mention followed by punctuation or at end of text counts", () => {
    expect(collectMentions("thanks @Ada Lovelace, see this", [ada])).toEqual(["u-ada"])
    expect(collectMentions("thanks @Ada Lovelace.", [ada])).toEqual(["u-ada"])
    expect(collectMentions("thanks @Ada Lovelace", [ada])).toEqual(["u-ada"])
  })

  test("drops a mention whose label is followed by a combining mark or astral letter", () => {
    // COMBINING ACUTE ACCENT, decomposed: the token now ends in a different letter.
    expect(collectMentions("@Ada Lovelace\u0301", [ada])).toEqual([])
    // MATHEMATICAL BOLD CAPITAL A, a surrogate pair in UTF-16.
    expect(collectMentions("@Ada Lovelace\u{1D400}", [ada])).toEqual([])
  })

  test("needs the @ to open like a typed mention", () => {
    expect(collectMentions("x@Ada Lovelace", [ada])).toEqual([])
    expect(collectMentions("(@Ada Lovelace)", [ada])).toEqual(["u-ada"])
  })

  test("an @ inside a word or email does not count", () => {
    expect(collectMentions("ada@Ada Lovelace", [ada])).toEqual([])
    expect(collectMentions("ada_b@Ada Lovelace", [ada])).toEqual([])
    expect(collectMentions("e\u0301@Ada Lovelace", [ada])).toEqual([])
    expect(collectMentions("\u{1D400}@Ada Lovelace", [ada])).toEqual([])
  })

  test("an @ after a character that can end an email local part does not count", () => {
    expect(collectMentions("ada+@Ada Lovelace", [ada])).toEqual([])
    expect(collectMentions("ada-@Ada Lovelace", [ada])).toEqual([])
    expect(collectMentions("ada%@Ada Lovelace", [ada])).toEqual([])
    const domain: DriveMember = { userId: "u-domain", email: "d@example.test", displayName: "example.test" }
    expect(collectMentions("ada+@example.test", [domain])).toEqual([])
    expect(collectMentions("cc @example.test", [domain])).toEqual(["u-domain"])
  })

  test("a mention after a colon counts", () => {
    expect(collectMentions("cc:@Ada Lovelace", [ada])).toEqual(["u-ada"])
  })

  test("a quoted mention counts", () => {
    expect(collectMentions('"@Ada Lovelace"', [ada])).toEqual(["u-ada"])
    expect(collectMentions("'@Ada Lovelace'", [ada])).toEqual(["u-ada"])
    expect(collectMentions("cc \u201C@Ada Lovelace\u201D", [ada])).toEqual(["u-ada"])
  })

  test("an email label is one token", () => {
    const agents: DriveMember = { userId: "u-agents", email: "x", displayName: "agents.test" }
    expect(collectMentions("@review-bot@agents.test", [bot, agents])).toEqual(["u-bot"])
  })
})
