import { describe, test, expect } from "bun:test";
import { getS3Key } from "../versioning.js";

describe("getS3Key", () => {
  test("formats key with orgId/drives/driveId/path", () => {
    expect(getS3Key("org1", "drive1", "/hello.txt")).toBe(
      "org1/drives/drive1/hello.txt"
    );
  });

  test("strips leading slash from path", () => {
    expect(getS3Key("org1", "drive1", "/a/b/c.txt")).toBe(
      "org1/drives/drive1/a/b/c.txt"
    );
  });

  test("handles path without leading slash", () => {
    expect(getS3Key("org1", "drive1", "file.txt")).toBe(
      "org1/drives/drive1/file.txt"
    );
  });

  test("handles nested paths", () => {
    expect(getS3Key("abc", "xyz", "/deep/nested/path/file.md")).toBe(
      "abc/drives/xyz/deep/nested/path/file.md"
    );
  });
});
