import { describe, test, expect } from "bun:test";
import { parseNumericFlag } from "../commands/ops.js";

/**
 * Numeric CLI flags (`--limit`, `--expires-in`, ...) used to go through a bare
 * `parseInt`: "abc" became NaN, which serializes to `null` on the wire — for
 * `share-create --expires-in` that meant a typo silently created a never-
 * expiring public link — and "2x" was silently truncated to 2. The strict
 * parser must accept whole decimal integers only and reject everything else.
 */
describe("parseNumericFlag", () => {
  test("accepts plain integers", () => {
    expect(parseNumericFlag("5")).toBe(5);
    expect(parseNumericFlag("0")).toBe(0);
    expect(parseNumericFlag("3600")).toBe(3600);
  });

  test("accepts an explicit sign and surrounding whitespace", () => {
    expect(parseNumericFlag(" 7 ")).toBe(7);
    expect(parseNumericFlag("+3")).toBe(3);
    expect(parseNumericFlag("-2")).toBe(-2);
  });

  test("rejects non-numeric input (previously NaN → null on the wire)", () => {
    expect(parseNumericFlag("abc")).toBe(null);
    expect(parseNumericFlag("")).toBe(null);
    expect(parseNumericFlag("never")).toBe(null);
    expect(parseNumericFlag("1.5")).toBe(null);
  });

  test("rejects trailing garbage (previously silently truncated)", () => {
    expect(parseNumericFlag("2x")).toBe(null);
    expect(parseNumericFlag("3600s")).toBe(null);
    expect(parseNumericFlag("12 34")).toBe(null);
  });

  test("accepts the largest safe integer", () => {
    expect(parseNumericFlag("9007199254740991")).toBe(9007199254740991);
    expect(parseNumericFlag("-9007199254740991")).toBe(-9007199254740991);
  });

  test("rejects values beyond the safe range (Infinity/rounding → corrupt request)", () => {
    expect(parseNumericFlag("9007199254740992")).toBe(null);
    expect(parseNumericFlag("9007199254740993")).toBe(null);
    expect(parseNumericFlag("9".repeat(400))).toBe(null);
    expect(parseNumericFlag("-9007199254740993")).toBe(null);
  });
});
