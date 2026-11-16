import { afterEach, describe, expect, test } from "bun:test";
import { desc } from "drizzle-orm";
import { schema } from "../../db/index.js";
import { StorageUnavailableError } from "../../errors.js";
import { createTestContext } from "../../test-utils.js";
import { dispatchOp } from "../index.js";
import { setWriteDeadlineMsForTests } from "../answer-within.js";

afterEach(() => setWriteDeadlineMsForTests(15_000));

describe("a write slower than the deadline", () => {
  test("answers 503 on time and still records what storage did", async () => {
    const { ctx, db, s3 } = createTestContext();
    setWriteDeadlineMsForTests(50);
    const put = s3.putObject.bind(s3);
    s3.putObject = async (...args) => {
      await Bun.sleep(200);
      return put(...args);
    };
    const started = Date.now();
    const err = await dispatchOp(ctx, "write", { path: "/a.txt", content: "late" }).catch((e) => e);
    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect(Date.now() - started).toBeLessThan(150);

    await Bun.sleep(300);
    const head = db.select().from(schema.fileVersions).orderBy(desc(schema.fileVersions.version)).get();
    expect(head?.version).toBe(1);
    expect(head?.size).toBe(4);
  });

  test("a fast write is unaffected", async () => {
    const { ctx } = createTestContext();
    setWriteDeadlineMsForTests(50);
    expect(await dispatchOp(ctx, "write", { path: "/b.txt", content: "b" })).toMatchObject({ version: 1 });
  });
});
