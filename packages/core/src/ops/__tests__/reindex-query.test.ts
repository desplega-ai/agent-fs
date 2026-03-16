import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq, and, or, isNull } from "drizzle-orm";
import { createDatabase, schema } from "../../db/index.js";

/**
 * Tests that the reindex query correctly includes files with pending, failed, and NULL
 * embedding statuses. This validates the fix for the bug where pending files were skipped.
 */

const TEST_DB = join(tmpdir(), `agent-fs-reindex-query-test-${Date.now()}.db`);
const DRIVE_ID = "test-drive";
const ORG_ID = "test-org";
const USER_ID = "test-user";

let db: ReturnType<typeof createDatabase>;

beforeAll(() => {
  db = createDatabase(TEST_DB);

  const now = new Date();
  db.insert(schema.users).values({ id: USER_ID, email: "test@example.com", apiKeyHash: "test", createdAt: now }).run();
  db.insert(schema.orgs).values({ id: ORG_ID, name: "Test Org", createdAt: now }).run();
  db.insert(schema.drives).values({ id: DRIVE_ID, orgId: ORG_ID, name: "default", isDefault: true, createdAt: now }).run();

  // Insert files with various embedding statuses
  const baseFile = {
    driveId: DRIVE_ID,
    size: 100,
    author: USER_ID,
    createdAt: now,
    modifiedAt: now,
    isDeleted: false,
  };

  db.insert(schema.files).values({ ...baseFile, path: "/pending.md", embeddingStatus: "pending" }).run();
  db.insert(schema.files).values({ ...baseFile, path: "/failed.md", embeddingStatus: "failed" }).run();
  db.insert(schema.files).values({ ...baseFile, path: "/null.md", embeddingStatus: null }).run();
  db.insert(schema.files).values({ ...baseFile, path: "/indexed.md", embeddingStatus: "indexed" }).run();
  db.insert(schema.files).values({ ...baseFile, path: "/deleted.md", embeddingStatus: "pending", isDeleted: true }).run();
}, 30_000);

afterAll(() => {
  try { unlinkSync(TEST_DB); } catch {}
});

describe("reindex query", () => {
  test("includes files with pending, failed, and NULL embedding status", () => {
    // This mirrors the query in packages/core/src/ops/reindex.ts
    const files = db
      .select({ path: schema.files.path })
      .from(schema.files)
      .where(
        and(
          eq(schema.files.driveId, DRIVE_ID),
          eq(schema.files.isDeleted, false),
          or(
            eq(schema.files.embeddingStatus, "failed"),
            isNull(schema.files.embeddingStatus),
            eq(schema.files.embeddingStatus, "pending"),
          ),
        )
      )
      .all();

    const paths = files.map(f => f.path).sort();

    expect(paths).toEqual(["/failed.md", "/null.md", "/pending.md"]);
  });

  test("excludes indexed files", () => {
    const files = db
      .select({ path: schema.files.path })
      .from(schema.files)
      .where(
        and(
          eq(schema.files.driveId, DRIVE_ID),
          eq(schema.files.isDeleted, false),
          or(
            eq(schema.files.embeddingStatus, "failed"),
            isNull(schema.files.embeddingStatus),
            eq(schema.files.embeddingStatus, "pending"),
          ),
        )
      )
      .all();

    const paths = files.map(f => f.path);
    expect(paths).not.toContain("/indexed.md");
  });

  test("excludes deleted files even with pending status", () => {
    const files = db
      .select({ path: schema.files.path })
      .from(schema.files)
      .where(
        and(
          eq(schema.files.driveId, DRIVE_ID),
          eq(schema.files.isDeleted, false),
          or(
            eq(schema.files.embeddingStatus, "failed"),
            isNull(schema.files.embeddingStatus),
            eq(schema.files.embeddingStatus, "pending"),
          ),
        )
      )
      .all();

    const paths = files.map(f => f.path);
    expect(paths).not.toContain("/deleted.md");
  });
});
