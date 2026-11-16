import { describe, test, expect, spyOn } from "bun:test";
import { getOpDefinition, dispatchOp } from "../index.js";
import { createTestContext } from "../../test-utils.js";
import { getS3Key } from "../versioning.js";

describe("signed-url op", () => {
  const opDef = getOpDefinition("signed-url")!;

  test("checks storage once and refuses a missing object even when its metadata remains", async () => {
    const { ctx, db } = createTestContext();
    await dispatchOp(ctx, "write", { path: "/exists.txt", content: "content" });
    const head = spyOn(ctx.s3, "headObject");
    const presign = spyOn(ctx.s3, "getPresignedUrl");
    try {
      await dispatchOp(ctx, "signed-url", { path: "/exists.txt" });
      expect(head).toHaveBeenCalledTimes(1);
      expect(presign).toHaveBeenCalledTimes(1);
      await ctx.s3.deleteObject(getS3Key(ctx.orgId, ctx.driveId, "/exists.txt"));
      await expect(dispatchOp(ctx, "signed-url", { path: "/exists.txt" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(head).toHaveBeenCalledTimes(2);
      expect(presign).toHaveBeenCalledTimes(1);
    } finally {
      head.mockRestore();
      presign.mockRestore();
      db.$client.close();
    }
  });

  test("is registered in op registry", () => {
    expect(opDef).toBeDefined();
    expect(opDef.handler).toBeInstanceOf(Function);
    expect(opDef.description).toContain("presigned URL");
  });

  test("schema accepts path only (uses default expiry)", () => {
    const result = opDef.schema.parse({ path: "/test.txt" });
    expect(result).toEqual({ path: "/test.txt" });
  });

  test("schema accepts path with expiresIn", () => {
    const result = opDef.schema.parse({ path: "/test.txt", expiresIn: 3600 });
    expect(result).toEqual({ path: "/test.txt", expiresIn: 3600 });
  });

  test("schema rejects expiresIn below 60 seconds", () => {
    expect(() => opDef.schema.parse({ path: "/test.txt", expiresIn: 30 })).toThrow();
  });

  test("schema rejects expiresIn above 7 days (604800s)", () => {
    expect(() => opDef.schema.parse({ path: "/test.txt", expiresIn: 700000 })).toThrow();
  });

  test("schema rejects non-integer expiresIn", () => {
    expect(() => opDef.schema.parse({ path: "/test.txt", expiresIn: 3600.5 })).toThrow();
  });

  test("schema rejects missing path", () => {
    expect(() => opDef.schema.parse({})).toThrow();
    expect(() => opDef.schema.parse({ expiresIn: 3600 })).toThrow();
  });

  test("schema accepts an explicit disposition", () => {
    expect(opDef.schema.parse({ path: "/f", disposition: "inline" }))
      .toEqual({ path: "/f", disposition: "inline" });
    expect(opDef.schema.parse({ path: "/f", disposition: "attachment" }))
      .toEqual({ path: "/f", disposition: "attachment" });
  });

  test("schema rejects an unknown disposition", () => {
    expect(() => opDef.schema.parse({ path: "/f", disposition: "bogus" })).toThrow();
  });

  test("schema accepts boundary values", () => {
    expect(opDef.schema.parse({ path: "/f", expiresIn: 60 })).toEqual({ path: "/f", expiresIn: 60 });
    expect(opDef.schema.parse({ path: "/f", expiresIn: 604800 })).toEqual({ path: "/f", expiresIn: 604800 });
  });

  test("presigned URL carries a charset for a text file", async () => {
    const { ctx } = createTestContext();
    await dispatchOp(ctx, "write", { path: "/notes.md", content: "# t — em dash" });

    const result = (await dispatchOp(ctx, "signed-url", { path: "/notes.md" })) as {
      url: string;
    };

    const ct = new URL(result.url).searchParams.get("ct");
    expect(ct).toBe("text/markdown; charset=utf-8");
    const cd = new URL(result.url).searchParams.get("cd");
    expect(cd).toBe("attachment; filename*=UTF-8''notes.md");
  });

  test("presigned URL RFC 5987-encodes its filename", async () => {
    const { ctx } = createTestContext();
    await dispatchOp(ctx, "write", { path: "/O'Reilly (draft)*.md", content: "# t" });

    const result = (await dispatchOp(ctx, "signed-url", { path: "/O'Reilly (draft)*.md" })) as {
      url: string;
    };

    expect(new URL(result.url).searchParams.get("cd"))
      .toBe("attachment; filename*=UTF-8''O%27Reilly%20%28draft%29%2A.md");
  });

  // The Live PDF viewer loads the URL in an <iframe>; only an inline
  // disposition lets the browser render it instead of downloading.
  test("disposition=inline is forwarded to the presigned URL with the filename", async () => {
    const { ctx } = createTestContext();
    await dispatchOp(ctx, "write", { path: "/deck.pdf", content: "%PDF-1.4" });

    const result = (await dispatchOp(ctx, "signed-url", {
      path: "/deck.pdf",
      disposition: "inline",
    })) as { url: string };

    expect(new URL(result.url).searchParams.get("cd"))
      .toBe("inline; filename*=UTF-8''deck.pdf");
  });

  test("presigned URL for a binary file has no charset", async () => {
    const { ctx } = createTestContext();
    await dispatchOp(ctx, "write", {
      path: "/logo.png",
      content: "not really png bytes",
    });

    const result = (await dispatchOp(ctx, "signed-url", { path: "/logo.png" })) as {
      url: string;
    };

    const ct = new URL(result.url).searchParams.get("ct");
    expect(ct).toBe("image/png");
  });
});
