import { afterEach, expect, test } from "bun:test";
import { ApiClient } from "../api-client.js";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.AGENT_FS_API_URL;
const originalTimeout = process.env.AGENT_FS_HTTP_TIMEOUT_MS;

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv("AGENT_FS_API_URL", originalUrl);
  restoreEnv("AGENT_FS_HTTP_TIMEOUT_MS", originalTimeout);
});

function createClient(): ApiClient {
  process.env.AGENT_FS_API_URL = "http://agent-fs.test";
  process.env.AGENT_FS_HTTP_TIMEOUT_MS = "1";
  return new ApiClient();
}

function timeoutFetch(): typeof fetch {
  return ((_url, opts) => new Promise((_, reject) => {
    const signal = opts?.signal as AbortSignal;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  })) as typeof fetch;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test("uses a 60 second timeout by default", () => {
  delete process.env.AGENT_FS_HTTP_TIMEOUT_MS;
  expect((createClientWithoutTimeout() as unknown as { timeoutMs: number }).timeoutMs).toBe(60_000);
});

function createClientWithoutTimeout(): ApiClient {
  process.env.AGENT_FS_API_URL = "http://agent-fs.test";
  return new ApiClient();
}

test("retries timed-out GET requests and reports the configured timeout", async () => {
  let calls = 0;
  globalThis.fetch = ((_url, opts) => {
    calls++;
    return timeoutFetch()(_url, opts);
  }) as typeof fetch;

  await expect(createClient().get("/health")).rejects.toThrow(
    "agent-fs did not answer within 0.001 s"
  );
  expect(calls).toBe(3);
});

test("does not retry a timed-out write", async () => {
  let calls = 0;
  globalThis.fetch = ((_url, opts) => {
    calls++;
    return timeoutFetch()(_url, opts);
  }) as typeof fetch;

  await expect(createClient().post("/orgs", { name: "test" })).rejects.toThrow(
    "agent-fs did not answer within 0.001 s"
  );
  expect(calls).toBe(1);
});

test("retries a connection error before a write receives a response", async () => {
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return Promise.reject(new TypeError("connection refused"));
  }) as unknown as typeof fetch;

  await expect(createClient().post("/orgs", { name: "test" })).rejects.toThrow(
    "Cannot connect to agent-fs daemon"
  );
  expect(calls).toBe(3);
});

test("retries a timed-out read-only operation", async () => {
  let calls = 0;
  globalThis.fetch = ((_url, opts) => {
    calls++;
    return timeoutFetch()(_url, opts);
  }) as typeof fetch;

  await expect(createClient().callOp("org", "cat", { path: "/test.txt" })).rejects.toThrow(
    "agent-fs did not answer within 0.001 s"
  );
  expect(calls).toBe(3);
});

test("does not add a timeout to the event stream", async () => {
  const suppliedSignal = new AbortController().signal;
  const received = { signal: null as AbortSignal | null };
  globalThis.fetch = ((_url, opts) => {
    received.signal = opts?.signal as AbortSignal;
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as typeof fetch;

  await expect(createClient().getEvents("org", "drive", suppliedSignal)).resolves.toBeInstanceOf(Response);
  expect(received.signal).toBe(suppliedSignal);
});
