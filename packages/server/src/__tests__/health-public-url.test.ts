import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestConfigDir, createTestContext } from "../../../core/src/test-utils.js";
import { createApp } from "../app.js";

let cleanup: () => void;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.AGENT_FS_PUBLIC_URL;
  ({ cleanup } = createTestConfigDir());
});
afterEach(() => {
  if (saved === undefined) delete process.env.AGENT_FS_PUBLIC_URL;
  else process.env.AGENT_FS_PUBLIC_URL = saved;
  cleanup();
});

describe("/health publicUrl", () => {
  test("advertises AGENT_FS_PUBLIC_URL without a trailing slash", async () => {
    process.env.AGENT_FS_PUBLIC_URL = "https://files.example.com/";
    const { db, s3 } = createTestContext();
    const health = await (await createApp(db, s3).request("/health")).json();
    expect(health.publicUrl).toBe("https://files.example.com");
  });

  test("omits it when unset, so the app keeps using its own endpoint", async () => {
    delete process.env.AGENT_FS_PUBLIC_URL;
    const { db, s3 } = createTestContext();
    const health = await (await createApp(db, s3).request("/health")).json();
    expect("publicUrl" in health).toBe(false);
  });
});
