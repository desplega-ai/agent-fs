import { describe, expect, test, spyOn } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestContext } from "../../test-utils.js";
import { NotFoundError } from "../../errors.js";
import { subscribeDrive } from "../../events/bus.js";
import { cp } from "../cp.js";
import { mv } from "../mv.js";

for (const [name, operation] of [["cp", cp], ["mv", mv]] as const) {
  describe(name + " with a missing source", () => {
    for (const shape of [
      { name: "NotFound" },
      { name: "NoSuchKey" },
      { $metadata: { httpStatusCode: 404 } },
    ]) {
      test("maps " + JSON.stringify(shape) + " without side effects", async () => {
        const { ctx, db } = createTestContext({ versioningEnabled: true });
        const raw = (db as unknown as { $client: Database }).$client;
        const head = spyOn(ctx.s3, "headObject").mockRejectedValue(shape);
        const copy = spyOn(ctx.s3, "copyObject");
        const events: string[] = [];
        const off = subscribeDrive(ctx.driveId, event => events.push(event.type));
        try {
          const error = await operation(ctx, { from: "/missing.md", to: "/dest.md" }).catch(e => e);
          expect(error).toBeInstanceOf(NotFoundError);
          expect(error.code).toBe("NOT_FOUND");
          expect(error.path).toBe("/missing.md");
          expect(copy).not.toHaveBeenCalled();
          for (const table of ["files", "file_versions", "webhook_deliveries"]) {
            expect(raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
          }
          expect(events).toEqual([]);
        } finally {
          off();
          head.mockRestore();
          copy.mockRestore();
        }
      });
    }

    test("propagates unrelated storage failures", async () => {
      const { ctx } = createTestContext();
      const failure = new Error("Storage unavailable");
      const head = spyOn(ctx.s3, "headObject").mockRejectedValue(failure);
      try {
        await expect(operation(ctx, { from: "/a", to: "/b" })).rejects.toBe(failure);
      } finally {
        head.mockRestore();
      }
    });
  });
}
