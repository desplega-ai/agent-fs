// Numeric flag parsing tests for the ops command family.

import { describe, expect, test } from "bun:test";
import { parseNumericFlag } from "../ops.js";

describe("parseNumericFlag", () => {
  test("accepts plain integers", () => {
    expect(parseNumericFlag("200", "--limit")).toBe(200);
    expect(parseNumericFlag("0", "--offset")).toBe(0);
    expect(parseNumericFlag("-5", "--offset")).toBe(-5);
    expect(parseNumericFlag(" 3600 ", "--expires-in")).toBe(3600);
  });

  test("passes through integers that are already numbers", () => {
    // `--one-off` sets maxViews = 1 as a number before the parse loop runs.
    expect(parseNumericFlag(1, "--max-views")).toBe(1);
  });

  test("rejects non-numeric garbage instead of yielding NaN", () => {
    expect(() => parseNumericFlag("abc", "--expires-in")).toThrow('Invalid value for --expires-in: "abc"');
    expect(() => parseNumericFlag("", "--limit")).toThrow("Invalid value");
  });

  test("rejects trailing junk instead of truncating", () => {
    expect(() => parseNumericFlag("2x", "--limit")).toThrow('Invalid value for --limit: "2x"');
    expect(() => parseNumericFlag("3600s", "--expires-in")).toThrow("Invalid value");
    expect(() => parseNumericFlag("1.5", "--depth")).toThrow("Invalid value");
  });
});
