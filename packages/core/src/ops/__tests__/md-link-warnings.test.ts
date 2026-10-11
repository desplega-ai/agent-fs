import { describe, test, expect } from "bun:test";
import { write, writeRaw } from "../write.js";
import { rm } from "../rm.js";
import { extractMarkdownLinkTargets, resolveLinkTarget, MAX_LINK_TARGETS } from "../md-links.js";
import { createTestContext } from "../../test-utils.js";

const REPORT = "/reports/2026-10-11-check.md";

describe("write: markdown link warnings", () => {
  test("a correct relative link gives no warning and no field", async () => {
    const { ctx } = createTestContext();
    await write(ctx, { path: "/reports/check/shot.png", content: "png" });

    const result = await write(ctx, { path: REPORT, content: "![shot](check/shot.png)\n" });

    expect(result.version).toBe(1);
    expect("warnings" in result).toBe(false);
  });

  test("the incident's wrong-prefix link warns with the resolved path", async () => {
    const { ctx } = createTestContext();
    await write(ctx, { path: "/reports/check/shot.png", content: "png" });

    const result = await write(ctx, { path: REPORT, content: "![shot](reports/check/shot.png)\n" });

    expect(result.version).toBe(1);
    expect(result.warnings).toEqual([
      {
        link: "reports/check/shot.png",
        resolvedPath: "/reports/reports/check/shot.png",
        message: "Link target not found at write time: reports/check/shot.png resolves to /reports/reports/check/shot.png",
      },
    ]);
  });

  test("a leading slash resolves from the drive root", async () => {
    const { ctx } = createTestContext();
    await write(ctx, { path: "/reports/check/shot.png", content: "png" });

    const result = await write(ctx, {
      path: REPORT,
      content: "![a](/reports/check/shot.png) ![b](/check/shot.png)\n",
    });

    expect(result.warnings?.map((w) => w.resolvedPath)).toEqual(["/check/shot.png"]);
  });

  test("external URLs, anchors, and code are ignored", async () => {
    const { ctx } = createTestContext();
    const content = [
      "[site](https://example.com/a.md) [mail](mailto:x@example.com) [cdn](//cdn.example.com/x.png)",
      "![inline](data:image/png;base64,AAAA) [top](#heading)",
      "`[code](missing-inline.md)`",
      "```",
      "![fenced](missing-fenced.png)",
      "```",
    ].join("\n");

    const result = await write(ctx, { path: REPORT, content });

    expect(result.warnings).toBeUndefined();
  });

  test("a link to the file itself, a folder, or with query and fragment resolves", async () => {
    const { ctx } = createTestContext();
    await write(ctx, { path: "/reports/check/my shot.png", content: "png" });

    const result = await write(ctx, {
      path: REPORT,
      content: "[self](./2026-10-11-check.md#x) [dir](check/) ![s](check/my%20shot.png?v=2#frag) [up](../reports/check)\n",
    });

    expect(result.warnings).toBeUndefined();
  });

  test("a deleted target warns", async () => {
    const { ctx } = createTestContext();
    await write(ctx, { path: "/reports/gone.png", content: "png" });
    await rm(ctx, { path: "/reports/gone.png" });

    const result = await write(ctx, { path: REPORT, content: "![g](gone.png)\n" });

    expect(result.warnings?.map((w) => w.resolvedPath)).toEqual(["/reports/gone.png"]);
  });

  test("non-markdown files are not scanned", async () => {
    const { ctx } = createTestContext();

    const result = await write(ctx, { path: "/reports/notes.txt", content: "![x](missing.png)\n" });

    expect(result.warnings).toBeUndefined();
  });

  test("the raw byte path warns too", async () => {
    const { ctx } = createTestContext();

    const result = await writeRaw(ctx, {
      path: REPORT,
      bytes: new TextEncoder().encode("![x](missing.png)\n"),
    });

    expect(result.warnings?.map((w) => w.resolvedPath)).toEqual(["/reports/missing.png"]);
  });

  test("each unique target is checked once, capped", async () => {
    const { ctx } = createTestContext();
    const links = Array.from({ length: MAX_LINK_TARGETS + 10 }, (_, i) => `[l](m${i}.md) [again](m${i}.md)`);

    const result = await write(ctx, { path: REPORT, content: links.join("\n") });

    expect(result.warnings).toHaveLength(MAX_LINK_TARGETS);
  });
});

describe("markdown link extraction", () => {
  test("finds inline, image, reference and html img targets", () => {
    const md = [
      "[a](a.md \"title\") ![b](<b c.png>) [![badge](badge.svg)](link.md)",
      "[ref]: ref.md",
      "[^note]: not a link",
      '<img alt="x" src="img.png">',
    ].join("\n");

    expect(extractMarkdownLinkTargets(md)).toEqual(["a.md", "b c.png", "badge.svg", "link.md", "ref.md", "img.png"]);
  });

  test("resolves relative, rooted and dot segments, skips external", () => {
    expect(resolveLinkTarget("/a/b/doc.md", "../x.md")).toBe("/a/x.md");
    expect(resolveLinkTarget("/a/b/doc.md", "./x.md")).toBe("/a/b/x.md");
    expect(resolveLinkTarget("/a/b/doc.md", "/x.md")).toBe("/x.md");
    expect(resolveLinkTarget("/doc.md", "../../x.md")).toBe("/x.md");
    expect(resolveLinkTarget("/doc.md", "HTTPS://x.com")).toBeNull();
    expect(resolveLinkTarget("/doc.md", "#top")).toBeNull();
    expect(resolveLinkTarget("/doc.md", "?q=1")).toBeNull();
  });
});
