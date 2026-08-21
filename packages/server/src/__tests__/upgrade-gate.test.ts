import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { createTestDb, MockS3Client } from "../../../core/src/test-utils.js";
import { createApp } from "../app.js";
import { clearUpgradeInProgress, setUpgradeInProgress } from "../upgrade-gate.js";

let app: ReturnType<typeof createApp>;
let apiKey: string;
let orgId: string;
let driveId: string;

beforeAll(async () => {
  const db = createTestDb();
  const s3 = new MockS3Client();
  app = createApp(db, s3 as any);

  const reg = await app.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "gate-test@example.com" }),
  });
  const body = await reg.json();
  apiKey = body.apiKey;
  orgId = body.orgId;

  const me = await app.request("/auth/me", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  driveId = (await me.json()).defaultDriveId;
});

afterEach(() => {
  clearUpgradeInProgress();
});

function rawUrl(name: string): string {
  return `/orgs/${orgId}/drives/${driveId}/files/${name}/raw`;
}

function putRaw(name: string) {
  return app.request(rawUrl(name), {
    method: "PUT",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "text/plain" },
    body: "hello",
  });
}

describe("upgrade gate", () => {
  test("writes get 503 + Retry-After while an upgrade is in progress", async () => {
    setUpgradeInProgress("test build");
    const res = await putRaw("gated.txt");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    const body = await res.json();
    expect(body.error).toBe("UPGRADE_IN_PROGRESS");
    expect(body.message).toContain("test build");
  });

  test("/health answers and names the upgrade; reads are not gated", async () => {
    setUpgradeInProgress("test build");
    const health = await app.request("/health");
    expect(health.status).toBe(200);
    expect((await health.json()).upgrade).toBe("test build");

    const read = await app.request(rawUrl("missing.txt"), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(read.status).not.toBe(503);
  });

  test("writes flow again once the upgrade is cleared", async () => {
    setUpgradeInProgress("test build");
    clearUpgradeInProgress();
    const res = await putRaw("open.txt");
    expect(res.status).toBeLessThan(300);
    const health = await app.request("/health");
    expect((await health.json()).upgrade).toBeUndefined();
  });
});
