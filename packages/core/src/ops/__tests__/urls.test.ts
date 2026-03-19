import { describe, test, expect } from "bun:test";
import { buildAppUrl } from "../urls.js";

describe("buildAppUrl", () => {
  test("constructs correct URL from parts", () => {
    const url = buildAppUrl("https://live.agent-fs.dev", "org-1", "drive-1", "src/app.tsx");
    expect(url).toBe("https://live.agent-fs.dev/file/~/org-1/drive-1/src/app.tsx");
  });

  test("strips leading slash from path", () => {
    const url = buildAppUrl("https://live.agent-fs.dev", "org-1", "drive-1", "/src/app.tsx");
    expect(url).toBe("https://live.agent-fs.dev/file/~/org-1/drive-1/src/app.tsx");
  });

  test("handles root path", () => {
    const url = buildAppUrl("https://live.agent-fs.dev", "org-1", "drive-1", "/");
    expect(url).toBe("https://live.agent-fs.dev/file/~/org-1/drive-1/");
  });

  test("handles deeply nested paths", () => {
    const url = buildAppUrl("https://live.agent-fs.dev", "org-1", "drive-1", "a/b/c/d/e.ts");
    expect(url).toBe("https://live.agent-fs.dev/file/~/org-1/drive-1/a/b/c/d/e.ts");
  });

  test("handles paths with spaces and special chars", () => {
    const url = buildAppUrl("https://live.agent-fs.dev", "org-1", "drive-1", "my docs/file (1).txt");
    expect(url).toBe("https://live.agent-fs.dev/file/~/org-1/drive-1/my docs/file (1).txt");
  });

  test("handles base URL without trailing slash", () => {
    const url = buildAppUrl("https://example.com", "o", "d", "file.txt");
    expect(url).toBe("https://example.com/file/~/o/d/file.txt");
  });

  test("handles empty path", () => {
    const url = buildAppUrl("https://live.agent-fs.dev", "org-1", "drive-1", "");
    expect(url).toBe("https://live.agent-fs.dev/file/~/org-1/drive-1/");
  });
});
