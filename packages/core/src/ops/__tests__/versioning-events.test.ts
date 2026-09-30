import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestContext } from "../../test-utils.js";
import { schema } from "../../db/index.js";
import { EditConflictError } from "../../errors.js";
import { subscribeDrive, type DriveEvent } from "../../events/bus.js";
import { write } from "../write.js";
import { edit } from "../edit.js";
import { append } from "../append.js";
import { rm } from "../rm.js";
import { mv } from "../mv.js";
import { cp } from "../cp.js";
import { revert } from "../revert.js";
import { createVersion, getHeadVersionRow } from "../versioning.js";

describe("file change events", () => {
  test("publishes each committed version from write, edit, append, cp, mv, revert, and rm", async () => {
    const { ctx, db } = createTestContext({ versioningEnabled: true });
    const received: DriveEvent[] = [];
    const committed: boolean[] = [];
    const raw = (db as unknown as { $client: Database }).$client;
    const unsubscribe = subscribeDrive(ctx.driveId, (event) => {
      received.push(event);
      committed.push(event.type === "file.changed" && !raw.inTransaction
        && getHeadVersionRow(ctx, event.path)?.version === event.version);
    });
    try {
      await write(ctx, { path: "/a.md", content: "first" });
      await edit(ctx, { path: "/a.md", old_string: "first", new_string: "second" });
      await append(ctx, { path: "/a.md", content: " tail" });
      await cp(ctx, { from: "/a.md", to: "/copy.md" });
      await mv(ctx, { from: "/copy.md", to: "/moved.md" });
      await revert(ctx, { path: "/a.md", version: 1 });
      await rm(ctx, { path: "/a.md" });

      const expected = [
        ["/a.md", 1, "write"],
        ["/a.md", 2, "edit"],
        ["/a.md", 3, "append"],
        ["/copy.md", 1, "write"],
        ["/moved.md", 1, "write"],
        ["/copy.md", 2, "delete"],
        ["/a.md", 4, "revert"],
        ["/a.md", 5, "delete"],
      ] as const;
      expect(received).toEqual(expected.map(([path, version, operation]) => ({
        type: "file.changed", driveId: ctx.driveId, path, version, operation,
        actor: ctx.userId, at: expect.any(String),
      })));
      expect(committed).toEqual(expected.map(() => true));
      for (const event of received) expect(new Date(event.at).toISOString()).toBe(event.at);
    } finally {
      unsubscribe();
    }
  });

  test("deduplicated writes and expected-version conflicts publish nothing", async () => {
    const { ctx } = createTestContext();
    await write(ctx, { path: "/a.md", content: "first" });
    const received: DriveEvent[] = [];
    const unsubscribe = subscribeDrive(ctx.driveId, (event) => received.push(event));
    try {
      const result = await write(ctx, { path: "/a.md", content: "first", expectedVersion: 1 });
      expect(result.deduped).toBe(true);
      await expect(write(ctx, { path: "/a.md", content: "changed", expectedVersion: 0 })).rejects.toThrow(EditConflictError);
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  test("a concurrent version conflict publishes only the winning commit", async () => {
    const { ctx } = createTestContext();
    await write(ctx, { path: "/race.md", content: "first" });
    const received: DriveEvent[] = [];
    const unsubscribe = subscribeDrive(ctx.driveId, (event) => received.push(event));
    try {
      const results = await Promise.allSettled([
        write(ctx, { path: "/race.md", content: "a", expectedVersion: 1 }),
        write(ctx, { path: "/race.md", content: "b", expectedVersion: 1 }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(EditConflictError);
      expect(received).toEqual([expect.objectContaining({ path: "/race.md", version: 2 })]);
    } finally {
      unsubscribe();
    }
  });

  test("a transaction rollback publishes nothing", async () => {
    const { ctx, db } = createTestContext();
    const raw = (db as unknown as { $client: Database }).$client;
    raw.exec("CREATE TRIGGER fail_file_insert BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
    const received: DriveEvent[] = [];
    const unsubscribe = subscribeDrive(ctx.driveId, (event) => received.push(event));
    try {
      await expect(createVersion(ctx, { path: "/failed.md", operation: "write", s3VersionId: "v1" })).rejects.toThrow("test rollback");
      expect(db.select().from(schema.fileVersions).all()).toEqual([]);
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });
});
