import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestContext } from "@/core/test-utils.js";
import { createDatabase } from "@/core/db/index.js";
import { createUser } from "@/core/identity/users.js";
import { listUserOrgs } from "@/core/identity/orgs.js";
import { listDrives } from "@/core/identity/drives.js";
import { LocalStorageAdapter } from "@/core/storage/local-adapter.js";
import { getS3Key } from "@/core/ops/versioning.js";
import { runPathNormalizationAtStartup } from "../startup-migrations.js";

describe("startup path normalization migration", () => {
  test(
    "runs before the real server accepts stat requests",
    async () => {
      const home = join(
        tmpdir(),
        `agent-fs-startup-migration-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      const storageRoot = join(home, "storage");
      mkdirSync(storageRoot, { recursive: true });
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({
          s3: { provider: "local", root: storageRoot },
          embedding: { provider: "openai", model: "", apiKey: "" },
          server: { port: 0, host: "127.0.0.1" },
          auth: { apiKey: "" },
          minio: { containerId: "", managed: false },
        })
      );

      const db = createDatabase(join(home, "agent-fs.db"));
      const { user, apiKey } = createUser(db, { email: "startup@test.local" });
      const orgId = listUserOrgs(db, user.id)[0].id;
      const driveId = listDrives(db, orgId)[0].id;
      const sqlite = (db as any).$client as Database;
      sqlite
        .query(
          `INSERT INTO files (
             path, drive_id, size, content_type, author, current_version_id,
             created_at, modified_at, is_deleted, embedding_status
           ) VALUES ('startup.md', ?, 7, 'text/markdown', ?, '1', 1, 1, 0, 'pending')`
        )
        .run(driveId, user.id);
      sqlite
        .query(
          `INSERT INTO file_versions (
             path, drive_id, version, s3_version_id, author, operation, size, created_at
           ) VALUES ('startup.md', ?, 1, 'v1', ?, 'write', 7, 1)`
        )
        .run(driveId, user.id);
      const storage = new LocalStorageAdapter({ root: storageRoot });
      await storage.putObject(
        getS3Key(orgId, driveId, "/startup.md"),
        "startup",
        undefined,
        "text/markdown"
      );
      sqlite.close();

      const server = Bun.spawn(
        [process.execPath, "run", "packages/cli/src/index.ts", "server"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            AGENT_FS_HOME: home,
            ANONYMIZED_TELEMETRY: "false",
            EMBEDDING_PROVIDER: "openai",
            EMBEDDING_API_KEY: "",
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const stderr = new Response(server.stderr).text();

      try {
        const reader = server.stdout.getReader();
        const decoder = new TextDecoder();
        let output = "";
        let url: string | undefined;
        while (!url) {
          const { value, done } = await reader.read();
          if (done) break;
          output += decoder.decode(value, { stream: true });
          url = output.match(/agent-fs daemon running on (http:\/\/[^\s]+)/)?.[1];
        }

        if (!url) {
          throw new Error(output + (await stderr));
        }
        expect(output).toContain(
          "file path migration: 1 renamed, 0 merged, 0 versions renumbered, 0 comments remapped, 0 skipped"
        );

        let health: Response | undefined;
        const deadline = Date.now() + 5_000;
        while (!health && Date.now() < deadline) {
          try {
            const response = await fetch(`${url}/health`);
            if (response.ok) health = response;
          } catch {}
          if (!health) await Bun.sleep(50);
        }
        expect(health?.ok).toBe(true);

        const stat = await fetch(`${url}/orgs/${orgId}/ops`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ op: "stat", driveId, path: "/startup.md" }),
        });
        expect(stat.ok).toBe(true);
        expect((await stat.json()).currentVersion).toBe(1);
      } finally {
        server.kill();
        await server.exited;
        rmSync(home, { recursive: true, force: true });
      }
    },
    15_000
  );

  test("runs during daemon startup and logs a summary", () => {
    const { db, driveId, userId } = createTestContext();
    const sqlite = (db as any).$client as Database;
    sqlite
      .query(
        `INSERT INTO files (
           path, drive_id, size, content_type, author, current_version_id,
           created_at, modified_at, is_deleted, embedding_status
         ) VALUES ('startup.md', ?, 1, 'text/markdown', ?, '1', 1, 1, 0, 'pending')`
      )
      .run(driveId, userId);
    sqlite
      .query(
        `INSERT INTO file_versions (
           path, drive_id, version, s3_version_id, author, operation, size, created_at
         ) VALUES ('startup.md', ?, 1, 'v1', ?, 'write', 1, 1)`
      )
      .run(driveId, userId);
    const logs: string[] = [];
    const errors: unknown[] = [];

    runPathNormalizationAtStartup(sqlite, {
      log: (message) => logs.push(message),
      error: (message, error) => errors.push([message, error]),
    });

    expect(sqlite.query("SELECT path FROM files").get()).toEqual({
      path: "/startup.md",
    });
    expect(logs).toEqual([
      "file path migration: 1 renamed, 0 merged, 0 versions renumbered, 0 comments remapped, 0 skipped",
    ]);
    expect(errors).toEqual([]);
  });

  test("logs a failure and lets startup continue with unchanged data", () => {
    const { db, driveId, userId } = createTestContext();
    const sqlite = (db as any).$client as Database;
    sqlite
      .query(
        `INSERT INTO files (
           path, drive_id, size, content_type, author, current_version_id,
           created_at, modified_at, is_deleted, embedding_status
         ) VALUES ('blocked.md', ?, 1, 'text/markdown', ?, '1', 1, 1, 0, 'pending')`
      )
      .run(driveId, userId);
    sqlite
      .query(
        `INSERT INTO file_versions (
           path, drive_id, version, s3_version_id, author, operation, size, created_at
         ) VALUES ('blocked.md', ?, 1, 'v1', ?, 'write', 1, 1)`
      )
      .run(driveId, userId);
    sqlite.exec(
      `CREATE TRIGGER fail_startup_migration BEFORE UPDATE ON files
       BEGIN SELECT RAISE(FAIL, 'blocked'); END`
    );
    const errors: unknown[][] = [];

    expect(() =>
      runPathNormalizationAtStartup(sqlite, {
        log: () => {},
        error: (...args) => errors.push(args),
      })
    ).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(sqlite.query("SELECT path FROM files").get()).toEqual({
      path: "blocked.md",
    });
  });
});
