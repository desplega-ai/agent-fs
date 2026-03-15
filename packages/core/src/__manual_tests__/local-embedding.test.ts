import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isMinioAvailable } from "../test-utils.js";
import { createDatabase, schema } from "../db/index.js";
import { AgentS3Client } from "../s3/client.js";
import type { OpContext } from "../ops/types.js";
import { write } from "../ops/write.js";
import { search } from "../ops/search.js";
import { LocalEmbeddingProvider } from "../search/embeddings/local.js";
import { indexFileEmbeddings } from "../search/pipeline.js";

const MINIO_AVAILABLE = await isMinioAvailable();
const SKIP = !MINIO_AVAILABLE;

const TEST_DB = join(tmpdir(), `agentfs-local-embed-test-${Date.now()}.db`);
const ORG_ID = "test-org";
const DRIVE_ID = "test-drive";
const USER_ID = "test-user";

let ctx: OpContext;
let provider: LocalEmbeddingProvider;
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
  db.insert(schema.users).values({ id: USER_ID, email: "local-embed@test.com", apiKeyHash: "test", createdAt: now }).run();
  db.insert(schema.orgs).values({ id: ORG_ID, name: "Test Org", createdAt: now }).run();
  db.insert(schema.drives).values({ id: DRIVE_ID, orgId: ORG_ID, name: "default", isDefault: true, createdAt: now }).run();

  ctx = { db, s3, orgId: ORG_ID, driveId: DRIVE_ID, userId: USER_ID };

  console.log("Initializing local embedding provider (may download model ~329MB)...");
  provider = new LocalEmbeddingProvider();
});

afterAll(async () => {
  if (SKIP) return;
  if (provider) await provider.dispose();
  try {
    unlinkSync(TEST_DB);
    unlinkSync(TEST_DB + "-wal");
    unlinkSync(TEST_DB + "-shm");
  } catch {}
});

describe.skipIf(SKIP)("Local Embedding Provider (embeddinggemma-300M)", () => {
  test("embed returns 768-dim vector", async () => {
    const vec = await provider.embed("Hello world, this is a test of local embeddings.");
    expect(vec.length).toBe(768);
    expect(typeof vec[0]).toBe("number");
    // Values should be normalized floats
    expect(Math.abs(vec[0])).toBeLessThan(10);
  }, 120_000); // 2 min timeout for first model load

  test("embedBatch returns multiple vectors", async () => {
    const vecs = await provider.embedBatch([
      "User authentication with passwords",
      "Kubernetes deployment configuration",
    ]);
    expect(vecs.length).toBe(2);
    expect(vecs[0].length).toBe(768);
    expect(vecs[1].length).toBe(768);

    // Vectors should be different
    const diff = vecs[0].reduce((sum, v, i) => sum + Math.abs(v - vecs[1][i]), 0);
    expect(diff).toBeGreaterThan(0);
  });
});

describe.skipIf(SKIP)("Local embedding semantic search", () => {
  test("index files and search semantically with local model", async () => {
    // Write distinct files
    await write(ctx, {
      path: "/local/auth.md",
      content: "# Authentication\n\nThis module handles user login, password hashing, session tokens, and OAuth2 flows. Users authenticate via email and password.",
    });

    await write(ctx, {
      path: "/local/deploy.md",
      content: "# Deployment\n\nDeploy to Kubernetes using Helm charts. Configure ingress, TLS, and horizontal pod autoscaling for production.",
    });

    await write(ctx, {
      path: "/local/billing.md",
      content: "# Billing\n\nStripe integration for subscription management, invoicing, and payment processing. Monthly and annual billing cycles.",
    });

    // Index embeddings
    for (const path of ["/local/auth.md", "/local/deploy.md", "/local/billing.md"]) {
      const s3Key = `${ORG_ID}/drives/${DRIVE_ID}${path}`;
      const result = await ctx.s3.getObject(s3Key);
      const content = new TextDecoder().decode(result.body);
      await indexFileEmbeddings(db, provider, { path, driveId: DRIVE_ID, content });
    }

    // Semantic search
    const authResult = await search(ctx, { query: "how do users sign in", limit: 3 }, provider);
    expect(authResult.results.length).toBeGreaterThan(0);
    console.log("Query: 'how do users sign in' →", authResult.results.map(r => `${r.path} (${r.score.toFixed(3)})`));
    expect(authResult.results[0].path).toBe("/local/auth.md");

    const deployResult = await search(ctx, { query: "kubernetes containers", limit: 3 }, provider);
    expect(deployResult.results.length).toBeGreaterThan(0);
    console.log("Query: 'kubernetes containers' →", deployResult.results.map(r => `${r.path} (${r.score.toFixed(3)})`));
    expect(deployResult.results[0].path).toBe("/local/deploy.md");

    const billingResult = await search(ctx, { query: "payment invoices", limit: 3 }, provider);
    expect(billingResult.results.length).toBeGreaterThan(0);
    console.log("Query: 'payment invoices' →", billingResult.results.map(r => `${r.path} (${r.score.toFixed(3)})`));
    expect(billingResult.results[0].path).toBe("/local/billing.md");
  }, 120_000);
});
