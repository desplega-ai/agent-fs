import { describe, test, expect } from "bun:test";
import { buildAppUrl } from "../urls.js";

/**
 * Tests for the appUrl enrichment logic used in dispatchOp.
 * We test the enrichment pattern directly rather than through dispatchOp
 * (which requires DB/S3 integration) to verify the conditional logic.
 */

function enrichWithAppUrl(
  ctx: { appUrl?: string; orgId: string; driveId: string },
  result: unknown
): unknown {
  if (ctx.appUrl && result && typeof result === "object") {
    if ("path" in result) {
      (result as any).appUrl = buildAppUrl(ctx.appUrl, ctx.orgId, ctx.driveId, (result as any).path);
    } else if ("to" in result) {
      (result as any).appUrl = buildAppUrl(ctx.appUrl, ctx.orgId, ctx.driveId, (result as any).to);
    }
  }
  return result;
}

describe("appUrl enrichment", () => {
  const ctx = { appUrl: "https://live.agent-fs.dev", orgId: "org-1", driveId: "drive-1" };

  test("adds appUrl when result has path field", () => {
    const result = enrichWithAppUrl(ctx, { path: "/test.txt", size: 100 });
    expect((result as any).appUrl).toBe("https://live.agent-fs.dev/file/~/org-1/drive-1/test.txt");
  });

  test("adds appUrl when result has to field (mv/cp)", () => {
    const result = enrichWithAppUrl(ctx, { from: "/a.txt", to: "/b.txt", version: 2 });
    expect((result as any).appUrl).toBe("https://live.agent-fs.dev/file/~/org-1/drive-1/b.txt");
  });

  test("does not add appUrl when ctx.appUrl is undefined", () => {
    const result = enrichWithAppUrl({ orgId: "org-1", driveId: "drive-1" }, { path: "/test.txt" });
    expect((result as any).appUrl).toBeUndefined();
  });

  test("does not add appUrl when result has neither path nor to", () => {
    const result = enrichWithAppUrl(ctx, { content: "hello", totalLines: 1 });
    expect((result as any).appUrl).toBeUndefined();
  });

  test("does not add appUrl when result is null", () => {
    const result = enrichWithAppUrl(ctx, null);
    expect(result).toBeNull();
  });

  test("does not add appUrl when result is a primitive", () => {
    const result = enrichWithAppUrl(ctx, "string-result");
    expect(result).toBe("string-result");
  });

  test("prefers path over to when both exist", () => {
    const result = enrichWithAppUrl(ctx, { path: "/main.txt", to: "/other.txt" });
    expect((result as any).appUrl).toBe("https://live.agent-fs.dev/file/~/org-1/drive-1/main.txt");
  });

  test("enriches stat result correctly", () => {
    const result = enrichWithAppUrl(ctx, {
      path: "/docs/readme.md",
      size: 1024,
      contentType: "text/markdown",
      author: "user@test.com",
    });
    expect((result as any).appUrl).toBe("https://live.agent-fs.dev/file/~/org-1/drive-1/docs/readme.md");
    // Original fields preserved
    expect((result as any).size).toBe(1024);
    expect((result as any).author).toBe("user@test.com");
  });

  test("enriches signed-url result correctly", () => {
    const result = enrichWithAppUrl(ctx, {
      url: "https://s3.example.com/presigned?...",
      path: "/docs/report.pdf",
      expiresIn: 86400,
      expiresAt: "2026-03-20T12:00:00.000Z",
    });
    expect((result as any).appUrl).toBe("https://live.agent-fs.dev/file/~/org-1/drive-1/docs/report.pdf");
    expect((result as any).url).toBe("https://s3.example.com/presigned?...");
  });
});
