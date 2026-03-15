import { describe, test, expect } from "bun:test";
import { normalizePath, normalizePrefix, stripLeadingSlash } from "../paths.js";

describe("normalizePath", () => {
  test("adds leading slash if missing", () => {
    expect(normalizePath("foo.txt")).toBe("/foo.txt");
  });

  test("preserves existing leading slash", () => {
    expect(normalizePath("/foo.txt")).toBe("/foo.txt");
  });

  test("removes trailing slash", () => {
    expect(normalizePath("/foo/")).toBe("/foo");
  });

  test("handles root path", () => {
    expect(normalizePath("/")).toBe("/");
  });

  test("handles nested paths", () => {
    expect(normalizePath("a/b/c.txt")).toBe("/a/b/c.txt");
  });

  test("handles path with only slash prefix and trailing slash", () => {
    expect(normalizePath("/dir/")).toBe("/dir");
  });
});

describe("normalizePrefix", () => {
  test("adds leading slash if missing", () => {
    expect(normalizePrefix("foo")).toBe("/foo/");
  });

  test("adds trailing slash if missing", () => {
    expect(normalizePrefix("/foo")).toBe("/foo/");
  });

  test("preserves both slashes", () => {
    expect(normalizePrefix("/foo/")).toBe("/foo/");
  });

  test("handles nested prefixes", () => {
    expect(normalizePrefix("a/b")).toBe("/a/b/");
  });
});

describe("stripLeadingSlash", () => {
  test("strips leading slash", () => {
    expect(stripLeadingSlash("/foo.txt")).toBe("foo.txt");
  });

  test("no-op when no leading slash", () => {
    expect(stripLeadingSlash("foo.txt")).toBe("foo.txt");
  });

  test("strips only first slash", () => {
    expect(stripLeadingSlash("/a/b/c")).toBe("a/b/c");
  });

  test("handles empty string", () => {
    expect(stripLeadingSlash("")).toBe("");
  });
});
