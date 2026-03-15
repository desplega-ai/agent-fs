import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, schema } from "../db/index.js";
import { AgentS3Client } from "../s3/client.js";
import type { OpContext } from "../ops/types.js";
import { write } from "../ops/write.js";
import { search } from "../ops/search.js";
import { OpenAIEmbeddingProvider } from "../search/embeddings/openai.js";
import { indexFileEmbeddings } from "../search/pipeline.js";
import { chunkContent } from "../search/chunker.js";

// Skip entire file if required env vars are missing
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const MINIO_AVAILABLE = await (async () => {
  try {
    const res = await fetch("http://localhost:9000/minio/health/live");
    return res.ok;
  } catch { return false; }
})();

const SKIP = !OPENAI_KEY || !MINIO_AVAILABLE;

const TEST_DB = join(tmpdir(), `agentfs-embedding-test-${Date.now()}.db`);
const ORG_ID = "test-org";
const DRIVE_ID = "test-drive";
const USER_ID = "test-user";

let ctx: OpContext;
let provider: OpenAIEmbeddingProvider;
let db: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  if (SKIP) return;

  db = createDatabase(TEST_DB);
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
  db.insert(schema.users).values({ id: USER_ID, email: "embed@test.com", apiKeyHash: "test", createdAt: now }).run();
  db.insert(schema.orgs).values({ id: ORG_ID, name: "Test Org", createdAt: now }).run();
  db.insert(schema.drives).values({ id: DRIVE_ID, orgId: ORG_ID, name: "default", isDefault: true, createdAt: now }).run();
  db.insert(schema.orgMembers).values({ orgId: ORG_ID, userId: USER_ID, role: "admin" }).run();
  db.insert(schema.driveMembers).values({ driveId: DRIVE_ID, userId: USER_ID, role: "admin" }).run();

  provider = new OpenAIEmbeddingProvider(OPENAI_KEY!);
  ctx = { db, s3, orgId: ORG_ID, driveId: DRIVE_ID, userId: USER_ID, embeddingProvider: provider };
});

afterAll(() => {
  if (SKIP) return;
  try {
    unlinkSync(TEST_DB);
    unlinkSync(TEST_DB + "-wal");
    unlinkSync(TEST_DB + "-shm");
  } catch {}
});

describe.skipIf(SKIP)("OpenAI Embedding Provider", () => {
  test("embed returns 768-dim vector", async () => {
    const vec = await provider.embed("Hello world, this is a test.");
    expect(vec.length).toBe(768);
    expect(typeof vec[0]).toBe("number");
  });

  test("embedBatch returns multiple vectors", async () => {
    const vecs = await provider.embedBatch([
      "Authentication and login systems",
      "Database migration strategies",
    ]);
    expect(vecs.length).toBe(2);
    expect(vecs[0].length).toBe(768);
    expect(vecs[1].length).toBe(768);
  });
});

describe.skipIf(SKIP)("Chunker", () => {
  test("chunks content into pieces", async () => {
    const content = Array.from({ length: 100 }, (_, i) =>
      `Paragraph ${i}: ${"Lorem ipsum dolor sit amet. ".repeat(10)}`
    ).join("\n\n");

    const chunks = await chunkContent(content);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeGreaterThan(0);
      expect(chunk.charOffset).toBeGreaterThanOrEqual(0);
      expect(chunk.tokenCount).toBeGreaterThan(0);
    }
  });

  test("small content stays as single chunk", async () => {
    const chunks = await chunkContent("Short text.");
    expect(chunks.length).toBe(1);
  });
});

describe.skipIf(SKIP)("Full embedding pipeline + semantic search", () => {
  test("index files and search semantically", async () => {
    // Write distinct files
    await write(ctx, {
      path: "/docs/auth.md",
      content: "# Authentication\n\nThis module handles user login, password hashing, session tokens, and OAuth2 flows. Users authenticate via email and password or social login providers.",
    });

    await write(ctx, {
      path: "/docs/deploy.md",
      content: "# Deployment\n\nDeploy the application to Kubernetes using Helm charts. Configure ingress, TLS certificates, and horizontal pod autoscaling for production environments.",
    });

    await write(ctx, {
      path: "/docs/billing.md",
      content: "# Billing\n\nStripe integration for subscription management, invoicing, and payment processing. Supports monthly and annual billing cycles with prorated upgrades.",
    });

    // Index embeddings for all files
    for (const path of ["/docs/auth.md", "/docs/deploy.md", "/docs/billing.md"]) {
      const catResult = await ctx.s3.getObject(
        `${ORG_ID}/drives/${DRIVE_ID}${path}`
      );
      const content = new TextDecoder().decode(catResult.body);
      await indexFileEmbeddings(db, provider, {
        path,
        driveId: DRIVE_ID,
        content,
      });
    }

    // Semantic search: "how do users sign in" → should match auth doc
    const result = await search(ctx, { query: "how do users sign in", limit: 3 });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].path).toBe("/docs/auth.md");
    expect(result.results[0].score).toBeGreaterThan(0);

    // "kubernetes containers" → should match deploy doc
    const deployResult = await search(ctx, { query: "kubernetes containers infrastructure", limit: 3 });
    expect(deployResult.results.length).toBeGreaterThan(0);
    expect(deployResult.results[0].path).toBe("/docs/deploy.md");

    // "subscription payments" → should match billing doc
    const billingResult = await search(ctx, { query: "subscription payments invoices", limit: 3 });
    expect(billingResult.results.length).toBeGreaterThan(0);
    expect(billingResult.results[0].path).toBe("/docs/billing.md");
  });
});
