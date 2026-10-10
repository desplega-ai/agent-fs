import { describe, test, expect } from "bun:test";
import { diffSourceWarning, outputResult } from "../formatters.js";
import { stdio } from "../stdio.js";

// Capture stdio.writeStdout output (outputResult writes via a flush-safe
// writeSync loop, not console.log — see stdio.ts)
function captureOutput(fn: () => void): string {
  const logs: string[] = [];
  const orig = stdio.writeStdout;
  stdio.writeStdout = (data: string) => logs.push(data.replace(/\n$/, ""));
  try {
    fn();
  } finally {
    stdio.writeStdout = orig;
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

describe("share-create formatter", () => {
  test("file share prints the URL and the view limit", () => {
    const result = {
      id: "share-1",
      kind: "file",
      url: "http://127.0.0.1:7433/share/tok",
      sharePath: "/share/tok",
      path: "/notes.md",
      expiresIn: 3600,
      expiresAt: "2026-03-19T13:00:00.000Z",
      maxViews: 1,
    };

    const output = captureOutput(() => outputResult("share-create", result, false));
    expect(output.split("\n")[0]).toBe("http://127.0.0.1:7433/share/tok");
    expect(output).toContain("Views:   one-off (1 view)");
    expect(output).not.toContain("Site:");
    expect(output).toContain("share-revoke share-1");
  });

  test("site share prints Site: <url> and no Views line", () => {
    const result = {
      id: "share-2",
      kind: "site",
      url: "http://127.0.0.1:7433/site/tok/",
      sharePath: "/site/tok/",
      path: "/site-e2e",
      expiresIn: 3600,
      expiresAt: "2026-03-19T13:00:00.000Z",
      maxViews: null,
    };

    const output = captureOutput(() => outputResult("share-create", result, false));
    expect(output.split("\n")[0]).toBe("Site: http://127.0.0.1:7433/site/tok/");
    expect(output).not.toContain("Views:");
    expect(output).toContain("Expires:");
    expect(output).toContain("share-revoke share-2");
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

describe("drive-members formatter", () => {
  test("prints a table without roles", () => {
    const result = {
      members: [
        { userId: "user-1", email: "a@example.com", displayName: "Alice", role: "admin" },
        { userId: "user-2", email: "b@example.com", displayName: null },
      ],
    };

    const output = captureOutput(() => outputResult("drive-members", result, false));
    expect(output).toContain("DISPLAY NAME");
    expect(output).toContain("Alice");
    expect(output).toContain("a@example.com");
    expect(output).toContain("user-2");
    expect(output).not.toContain("role");
  });
});

describe("favorite formatters", () => {
  test("list marks folders with a trailing slash", () => {
    const result = {
      favorites: [
        { path: "/docs", kind: "directory", createdAt: "2026-10-10T10:00:00.000Z" },
        { path: "/notes.md", kind: "file", createdAt: "2026-10-10T10:00:00.000Z" },
      ],
    };
    const output = captureOutput(() => outputResult("favorite-list", result, false));
    expect(output).toContain("/docs/");
    expect(output).toContain("/notes.md");
    expect(captureOutput(() => outputResult("favorite-list", { favorites: [] }, false))).toContain("(no favorites)");
  });

  test("remove says when there was no star", () => {
    expect(captureOutput(() => outputResult("favorite-remove", { path: "/a.md", removed: true }, false))).toContain("Unstarred /a.md");
    expect(captureOutput(() => outputResult("favorite-remove", { path: "/a.md", removed: false }, false))).toContain("was not starred");
  });
});

describe("diff source warning", () => {
  test("no warning when the versions were compared", () => {
    expect(diffSourceWarning({ changes: [], source: "content" })).toBeNull();
  });

  test("warns that the versions were not compared for summary and none", () => {
    expect(diffSourceWarning({ changes: [{ type: "add", content: "x" }], source: "summary" })).toContain("not compared");
    expect(diffSourceWarning({ changes: [], source: "none" })).toContain("not compared");
  });

  test("warns on an empty result from a server that omits source", () => {
    expect(diffSourceWarning({ changes: [] })).toContain("may mean they were not");
    expect(diffSourceWarning({ changes: [{ type: "add", content: "x" }] })).toBeNull();
  });
});
