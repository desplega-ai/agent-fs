import { describe, test, expect } from "bun:test";
import { assertPageDataWrite, resolvePagePath } from "../page-paths.js";

describe("resolvePagePath", () => {
  test("joins a relative path to the folder", () => {
    expect(resolvePagePath("/work/foo", "data/state.json")).toBe("/work/foo/data/state.json");
    expect(resolvePagePath("/work/foo", "ñ/日本.json")).toBe("/work/foo/ñ/日本.json");
  });

  test("takes the path literally: percent-encoding is a name", () => {
    expect(resolvePagePath("/f", "%2e%2e/x")).toBe("/f/%2e%2e/x");
  });

  test.each([
    ["", "1 to 512"],
    ["a".repeat(513), "1 to 512"],
    ["/abs", "relative"],
    ["a\\b", "backslash"],
    ["a\0b", "NUL"],
    ["../x", "segments"],
    ["a/./b", "segments"],
    ["a//b", "segments"],
    ["a/", "segments"],
  ])("refuses %j", (path, why) => {
    expect(() => resolvePagePath("/f", path)).toThrow(why);
    try {
      resolvePagePath("/f", path);
    } catch (err) {
      expect((err as { code: string }).code).toBe("NOT_ALLOWED");
    }
  });
});

describe("assertPageDataWrite", () => {
  test("allows data files under data/", () => {
    expect(() => assertPageDataWrite("/f", "/f/data/a.json", "{}")).not.toThrow();
    expect(() => assertPageDataWrite("/f", "/f/data/sub/b.NDJSON", "")).not.toThrow();
  });

  test("refuses other folders, a sibling with the same prefix, page extensions and big content", () => {
    expect(() => assertPageDataWrite("/f", "/f/a.json", "")).toThrow("under data/");
    expect(() => assertPageDataWrite("/f", "/f/database/a.json", "")).toThrow("under data/");
    expect(() => assertPageDataWrite("/f", "/f/data/a.html", "")).toThrow("can only write");
    expect(() => assertPageDataWrite("/f", "/f/data/.json", "")).toThrow("can only write");
    expect(() => assertPageDataWrite("/f", "/f/data/a", "")).toThrow("can only write");
    // 256 KB counted in UTF-8 bytes: 2-byte characters reach it at half the length.
    expect(() => assertPageDataWrite("/f", "/f/data/a.txt", "é".repeat(128 * 1024))).not.toThrow();
    expect(() => assertPageDataWrite("/f", "/f/data/a.txt", "é".repeat(128 * 1024 + 1))).toThrow("256 KB");
  });
});
