import { describe, test, expect } from "bun:test";
import { outputResult } from "../formatters.js";

// Capture console.log output
function captureOutput(fn: () => void): string {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => logs.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = origLog;
  }
  return logs.join("\n");
}

describe("signed-url formatter", () => {
  test("formats presigned URL with expiry", () => {
    const result = {
      url: "https://s3.example.com/bucket/key?X-Amz-Signature=abc123",
      path: "/test/file.txt",
      expiresIn: 86400,
      expiresAt: "2026-03-20T12:00:00.000Z",
    };

    const output = captureOutput(() => outputResult("signed-url", result, false));
    expect(output).toContain("https://s3.example.com/bucket/key?X-Amz-Signature=abc123");
    expect(output).toContain("86400s");
    expect(output).toContain("2026-03-20");
  });

  test("includes appUrl when present", () => {
    const result = {
      url: "https://s3.example.com/presigned",
      path: "/test/file.txt",
      expiresIn: 3600,
      expiresAt: "2026-03-19T13:00:00.000Z",
      appUrl: "https://live.agent-fs.dev/file/~/org-1/drive-1/test/file.txt",
    };

    const output = captureOutput(() => outputResult("signed-url", result, false));
    expect(output).toContain("App:");
    expect(output).toContain("https://live.agent-fs.dev/file/~/org-1/drive-1/test/file.txt");
  });

  test("omits App line when appUrl is absent", () => {
    const result = {
      url: "https://s3.example.com/presigned",
      path: "/test/file.txt",
      expiresIn: 3600,
      expiresAt: "2026-03-19T13:00:00.000Z",
    };

    const output = captureOutput(() => outputResult("signed-url", result, false));
    expect(output).not.toContain("App:");
  });

  test("outputs JSON when json flag is set", () => {
    const result = {
      url: "https://s3.example.com/presigned",
      path: "/test.txt",
      expiresIn: 86400,
      expiresAt: "2026-03-20T12:00:00.000Z",
    };

    const output = captureOutput(() => outputResult("signed-url", result, true));
    const parsed = JSON.parse(output);
    expect(parsed.url).toBe("https://s3.example.com/presigned");
    expect(parsed.expiresIn).toBe(86400);
  });
});

describe("stat formatter with appUrl", () => {
  test("includes App URL when present in stat result", () => {
    const result = {
      path: "/docs/readme.md",
      size: 1024,
      contentType: "text/markdown",
      author: "user@test.com",
      currentVersion: 3,
      createdAt: "2026-03-01T00:00:00.000Z",
      modifiedAt: "2026-03-19T12:00:00.000Z",
      isDeleted: false,
      appUrl: "https://live.agent-fs.dev/file/~/org-1/drive-1/docs/readme.md",
    };

    const output = captureOutput(() => outputResult("stat", result, false));
    expect(output).toContain("App URL:");
    expect(output).toContain("https://live.agent-fs.dev/file/~/org-1/drive-1/docs/readme.md");
  });

  test("omits App URL when not present in stat result", () => {
    const result = {
      path: "/docs/readme.md",
      size: 1024,
      contentType: "text/markdown",
      author: "user@test.com",
      currentVersion: 3,
      createdAt: "2026-03-01T00:00:00.000Z",
      modifiedAt: "2026-03-19T12:00:00.000Z",
      isDeleted: false,
    };

    const output = captureOutput(() => outputResult("stat", result, false));
    expect(output).not.toContain("App URL");
  });
});
