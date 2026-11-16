import { expect, test } from "bun:test";
import { createTestContext } from "../../test-utils.js";
import { FILE_VERSIONS_RECENT_INDEX_SQL } from "../../db/raw.js";
import { recent } from "../recent.js";

test("the recent index preserves drive isolation, filters, limits, and tied timestamps", async () => {
  const { ctx, db } = createTestContext();
  const insert = db.$client.prepare("INSERT INTO file_versions (path, drive_id, version, s3_version_id, author, operation, created_at) VALUES (?, ?, ?, 'v', 'u', ?, ?)");
  try {
    db.$client.transaction(() => {
      for (let i = 0; i < 20_000; i++) {
        insert.run(`/old/${i}.txt`, ctx.driveId, 1, "write", i);
        insert.run(`/other/${i}.txt`, "another-drive", 1, "write", i + 100_000);
      }
      insert.run("/docs/a.txt", ctx.driveId, 1, "write", 25_000);
      insert.run("/docs/a.txt", ctx.driveId, 2, "delete", 25_001);
      insert.run("/docs/b.txt", ctx.driveId, 1, "write", 25_001);
    })();
    db.$client.exec("DROP INDEX idx_file_versions_drive_created");
    const requests = [{ limit: 5 }, { path: "/docs", limit: 2 }, { since: new Date(25_000_000), limit: 5 }];
    const before = await Promise.all(requests.map((params) => recent(ctx, params)));
    db.$client.exec(FILE_VERSIONS_RECENT_INDEX_SQL);
    expect(await Promise.all(requests.map((params) => recent(ctx, params)))).toEqual(before);
    expect(before[2].entries.map(({ path, operation }) => [path, operation])).toEqual([
      ["/docs/a.txt", "delete"], ["/docs/b.txt", "write"], ["/docs/a.txt", "write"],
    ]);
  } finally {
    db.$client.close();
  }
});
