import { describe, expect, test } from "bun:test"
import { serializeLiteralFtsQuery } from "../literal-fts"

describe("serializeLiteralFtsQuery", () => {
  test.each([
    ["ai-tinkerers", '"ai-tinkerers"'],
    ["ai tinkerers", '"ai" AND "tinkerers"'],
    ['say "hello"', '"say" AND """hello"""'],
    ["title:value", '"title:value"'],
    ["(alpha)", '"(alpha)"'],
    ["café 東京", '"café" AND "東京"'],
    ["AND OR NOT", '"AND" AND "OR" AND "NOT"'],
    ["", ""],
    [" \t\n ", ""],
  ])("serializes %j as literal terms", (input, expected) => {
    expect(serializeLiteralFtsQuery(input)).toBe(expected)
  })
})
