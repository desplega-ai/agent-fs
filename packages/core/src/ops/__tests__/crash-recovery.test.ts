import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { createDatabase, schema } from "../../db/index.js";
import { LocalStorageAdapter } from "../../storage/local-adapter.js";
import { indexedContent } from "../../search/fts.js";
import { reconcileStorageIntents } from "../storage-intent.js";
import { write } from "../write.js";
import { createTestContext } from "../../test-utils.js";

const CHILD = join(import.meta.dir, "fixtures", "crash-child.ts");

/** Run the child until its storage call has landed, then SIGKILL it. */
async function killMidOp(dbPath: string, root: string, scenario: string) {
  const child = Bun.spawn(["bun", CHILD, dbPath, root, scenario], { stdout: "pipe", stderr: "inherit" });
  let out = "";
  const reader = child.stdout.getReader();
  const dec = new TextDecoder();
  while (!out.includes("STORED")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`child exited before its storage call: ${out}`);
    out += dec.decode(value);
  }
  child.kill("SIGKILL");
  await child.exited;
  return JSON.parse(out.split("\n")[0]) as { orgId: string; driveId: string };
}

function head(db: ReturnType<typeof createDatabase>, driveId: string) {
  return db
    .select()
    .from(schema.fileVersions)
    .where(and(eq(schema.fileVersions.path, "/f.txt"), eq(schema.fileVersions.driveId, driveId)))
    .orderBy(desc(schema.fileVersions.version))
    .limit(1)
    .get();
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("crash between the storage call and the database commit", () => {
  for (const scenario of ["new", "overwrite"]) {
    test(`${scenario} file: boot reconcile records the stored bytes`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "afs-crash-"));
      try {
        const dbPath = join(dir, "db.sqlite");
        const root = join(dir, "store");
        const { orgId, driveId } = await killMidOp(dbPath, root, scenario);
        const db = createDatabase(dbPath);
        const s3 = new LocalStorageAdapter({ root });
        const key = `${orgId}/drives/${driveId}/f.txt`;
        expect(new TextDecoder().decode((await s3.getObject(key)).body)).toBe("new content, longer");
        // The crash window: the version row does not describe the bytes readers get.
        expect(head(db, driveId)?.contentHash ?? null).toBe(scenario === "new" ? null : sha("old content"));

        expect(await reconcileStorageIntents({ db, s3 })).toBe(1);

        const h = head(db, driveId)!;
        expect(h.operation).toBe("write");
        expect(h.contentHash).toBe(sha("new content, longer"));
        expect(h.size).toBe("new content, longer".length);
        expect(h.version).toBe(scenario === "new" ? 1 : 2);
        // The local backend can revert to it: the handle is the content hash.
        expect(h.s3VersionId).toBe(sha("new content, longer"));
        expect(indexedContent(db, { path: "/f.txt", driveId })).toBe("new content, longer");
        expect(db.select().from(schema.storageIntents).all()).toHaveLength(0);
        // A second pass has nothing left to do.
        expect(await reconcileStorageIntents({ db, s3 })).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20_000);
  }

  test("rm: boot reconcile records the delete and drops the search entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afs-crash-"));
    try {
      const dbPath = join(dir, "db.sqlite");
      const root = join(dir, "store");
      const { driveId } = await killMidOp(dbPath, root, "rm");
      const db = createDatabase(dbPath);
      const s3 = new LocalStorageAdapter({ root });
      expect(head(db, driveId)?.operation).toBe("write");
      expect(indexedContent(db, { path: "/f.txt", driveId })).toBe("old content");

      expect(await reconcileStorageIntents({ db, s3 })).toBe(1);

      expect(head(db, driveId)?.operation).toBe("delete");
      expect(indexedContent(db, { path: "/f.txt", driveId })).toBeNull();
      const file = db.select().from(schema.files).where(eq(schema.files.driveId, driveId)).get();
      expect(file?.isDeleted).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("storage intents in a live process", () => {
  test("a committed write leaves no intent; a failed one leaves its intent for the sweep", async () => {
    const { ctx, db, s3 } = createTestContext();
    await write(ctx, { path: "/a.txt", content: "a" });
    expect(db.select().from(schema.storageIntents).all()).toHaveLength(0);

    const put = s3.putObject.bind(s3);
    s3.putObject = async (...args) => {
      await put(...args);
      throw new Error("timeout after the store applied it");
    };
    await expect(write(ctx, { path: "/a.txt", content: "b" })).rejects.toThrow("timeout");
    expect(db.select().from(schema.storageIntents).all()).toHaveLength(1);
    // Too young for the timed sweep.
    expect(await reconcileStorageIntents({ db, s3 }, { olderThanMs: 60_000 })).toBe(0);
    expect(await reconcileStorageIntents({ db, s3 })).toBe(1);
    const h = db.select().from(schema.fileVersions).orderBy(desc(schema.fileVersions.version)).limit(1).get()!;
    expect(h.version).toBe(2);
    expect(h.contentHash).toBe(sha("b"));
  });
});
