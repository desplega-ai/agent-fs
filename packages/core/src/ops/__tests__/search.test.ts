import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { isMinioAvailable } from "../../test-utils.js";
const SKIP = !(await isMinioAvailable());
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, schema } from "../../db/index.js";
import { AgentS3Client } from "../../s3/client.js";
import type { OpContext } from "../types.js";
import { write } from "../write.js";
import { rm } from "../rm.js";
import { grep } from "../grep.js";
import { fts } from "../fts.js";

const TEST_DB = join(tmpdir(), `agentfs-search-test-${Date.now()}.db`);
const ORG_ID = "test-org";
const DRIVE_ID = "test-drive";
const USER_ID = "test-user";

let ctx: OpContext;

beforeAll(async () => {
  if (SKIP) return;
  const db = createDatabase(TEST_DB);
  const s3 = new AgentS3Client({
    provider: "minio",
    bucket: "agentfs",
    region: "us-east-1",
    endpoint: "http://localhost:9000",
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin",
  });

  await s3.enableVersioning();

  const now = new Date();
  db.insert(schema.users).values({ id: USER_ID, email: "search@test.com", apiKeyHash: "test", createdAt: now }).run();
  db.insert(schema.orgs).values({ id: ORG_ID, name: "Test Org", createdAt: now }).run();
  db.insert(schema.drives).values({ id: DRIVE_ID, orgId: ORG_ID, name: "default", isDefault: true, createdAt: now }).run();
  db.insert(schema.orgMembers).values({ orgId: ORG_ID, userId: USER_ID, role: "admin" }).run();
  db.insert(schema.driveMembers).values({ driveId: DRIVE_ID, userId: USER_ID, role: "admin" }).run();

  ctx = { db, s3, orgId: ORG_ID, driveId: DRIVE_ID, userId: USER_ID };

  // Seed test files
  await write(ctx, {
    path: "/src/auth.ts",
    content: 'import { hash } from "bcrypt";\n\nexport async function authenticate(email: string, password: string) {\n  const user = await findUser(email);\n  if (!user) throw new Error("User not found");\n  return hash(password) === user.passwordHash;\n}\n',
  });

  await write(ctx, {
    path: "/src/api.ts",
    content: 'import express from "express";\n\nconst app = express();\n\napp.get("/health", (req, res) => res.json({ ok: true }));\napp.post("/login", async (req, res) => {\n  const { email, password } = req.body;\n  // TODO: implement login\n});\n',
  });

  await write(ctx, {
    path: "/docs/readme.md",
    content: "# Authentication Service\n\nThis service handles user authentication and session management.\n\n## Getting Started\n\nInstall dependencies with `bun install`.\n",
  });
});

afterAll(() => {
  if (SKIP) return;
  try {
    unlinkSync(TEST_DB);
    unlinkSync(TEST_DB + "-wal");
    unlinkSync(TEST_DB + "-shm");
  } catch {}
});

describe.skipIf(SKIP)("FTS5 fts", () => {
  test("fts returns matches for keyword query", async () => {
    const result = await fts(ctx, { pattern: "authenticate" });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.some((m) => m.path === "/src/auth.ts")).toBe(true);
  });

  test("fts with path filter", async () => {
    const result = await fts(ctx, { pattern: "express", path: "/src" });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.every((m) => m.path.startsWith("/src"))).toBe(true);
  });

  test("fts returns empty for no matches", async () => {
    const result = await fts(ctx, { pattern: "nonexistentxyzterm" });
    expect(result.matches.length).toBe(0);
  });
});

describe.skipIf(SKIP)("grep", () => {
  test("grep returns regex matches with line numbers", async () => {
    const result = await grep(ctx, {
      pattern: "import.*from",
      path: "/src",
    });

    expect(result.matches.length).toBeGreaterThan(0);
    // Should find imports in both files
    const paths = new Set(result.matches.map((m) => m.path));
    expect(paths.has("/src/auth.ts")).toBe(true);
    expect(paths.has("/src/api.ts")).toBe(true);

    // Each match should have a line number
    for (const match of result.matches) {
      expect(match.lineNumber).toBeGreaterThan(0);
    }
  });

  test("grep returns empty for non-matching pattern", async () => {
    const result = await grep(ctx, {
      pattern: "zzznomatch",
      path: "/src",
    });
    expect(result.matches.length).toBe(0);
  });
});

describe.skipIf(SKIP)("FTS5 indexing integration", () => {
  test("write indexes content for FTS5 search", async () => {
    await write(ctx, {
      path: "/docs/guide.md",
      content: "# Deployment Guide\n\nDeploy the application to Kubernetes using Helm charts.",
    });

    const result = await fts(ctx, { pattern: "Kubernetes" });
    expect(result.matches.some((m) => m.path === "/docs/guide.md")).toBe(true);
  });

  test("rm removes file from FTS5 index", async () => {
    await write(ctx, { path: "/tmp/delete-me.txt", content: "uniqueftstesttoken xyzzy" });

    // Should be findable
    let result = await fts(ctx, { pattern: "uniqueftstesttoken" });
    expect(result.matches.length).toBeGreaterThan(0);

    // Delete it
    await rm(ctx, { path: "/tmp/delete-me.txt" });

    // Should no longer be findable
    result = await fts(ctx, { pattern: "uniqueftstesttoken" });
    expect(result.matches.length).toBe(0);
  });
});
