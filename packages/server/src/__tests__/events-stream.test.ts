import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@/core";
import { createTestContext } from "../../../core/src/test-utils.js";
import { createApp } from "../app.js";
import { SSEStreamingApi } from "hono/streaming";

function trackSubscriptions() {
  const subscribe = core.subscribeDrive;
  const listeners = new Set<symbol>();
  const spy = spyOn(core, "subscribeDrive").mockImplementation((driveId, listener) => {
    const id = Symbol();
    listeners.add(id);
    const unsubscribe = subscribe(driveId, listener);
    return () => {
      listeners.delete(id);
      unsubscribe();
    };
  });
  return { listeners, restore: () => spy.mockRestore() };
}

function frames(response: Response) {
  if (!response.body) throw new Error("Event stream has no response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    reader,
    async next() {
      while (true) {
        const end = buffer.indexOf("\n\n");
        if (end !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          return frame;
        }
        const { done, value } = await reader.read();
        if (done) throw new Error("Event stream closed before the next frame");
        buffer += decoder.decode(value, { stream: true });
      }
    },
  };
}

function payload(frame: string) {
  return JSON.parse(frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6));
}

async function waitForCleanup(listeners: Set<symbol>, expected = 0) {
  const deadline = Date.now() + 2000;
  while (listeners.size !== expected && Date.now() < deadline) await Bun.sleep(10);
  expect(listeners.size).toBe(expected);
}

describe("drive stream over HTTP", () => {
  let fixture: ReturnType<typeof createTestContext>;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let url: string;
  let subscriptions: ReturnType<typeof trackSubscriptions>;
  let controllers: AbortController[];

  beforeEach(() => {
    fixture = createTestContext();
    subscriptions = trackSubscriptions();
    controllers = [];
    const app = createApp(fixture.db, fixture.s3);
    server = Bun.serve({ port: 0, fetch: app.fetch });
    url = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    for (const controller of controllers ?? []) controller.abort();
    if (subscriptions) {
      await waitForCleanup(subscriptions.listeners);
      subscriptions.restore();
    }
    server?.stop(true);
    server = undefined;
  });

  function open(key = fixture.apiKey) {
    const controller = new AbortController();
    controllers.push(controller);
    return fetch(`${url}/orgs/${fixture.orgId}/drives/${fixture.driveId}/events`, {
      headers: { Authorization: `Bearer ${key}`, Origin: "http://other-origin.test" },
      signal: controller.signal,
    });
  }

  test("a member receives ready and committed file and comment changes", async () => {
    const response = await open();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const stream = frames(response);
    const ready = await stream.next();
    expect(ready).toStartWith("event: ready\n");
    expect(payload(ready)).toEqual({ driveId: fixture.driveId, at: expect.any(String) });

    const op = (body: object) => fetch(`${url}/orgs/${fixture.orgId}/ops`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, driveId: fixture.driveId }),
    });
    expect((await op({ op: "write", path: "/stream.md", content: "stream" })).status).toBe(200);
    const change = await stream.next();
    expect(change).toStartWith("event: file.changed\n");
    expect(payload(change)).toEqual({
      type: "file.changed", driveId: fixture.driveId, path: "/stream.md", version: 1,
      operation: "write", actor: fixture.userId, at: expect.any(String),
    });
    const commentResponse = await op({ op: "comment-add", path: "/stream.md", body: "Review" });
    expect(commentResponse.status).toBe(200);
    const comment = await commentResponse.json();
    const commentChange = await stream.next();
    expect(commentChange).toStartWith("event: comment.changed\n");
    expect(payload(commentChange)).toMatchObject({ commentId: comment.id, parentId: null, action: "created", path: "/stream.md" });
    controllers[0].abort();
    await waitForCleanup(subscriptions.listeners);
  });

  test("non-members receive the same 404 as raw files", async () => {
    const outsider = core.createUser(fixture.db, { email: "outsider@example.com" });
    const streamResponse = await open(outsider.apiKey);
    const rawResponse = await fetch(`${url}/orgs/${fixture.orgId}/drives/${fixture.driveId}/files/a.md/raw`, {
      headers: { Authorization: `Bearer ${outsider.apiKey}` },
    });
    expect(streamResponse.status).toBe(404);
    expect(await streamResponse.json()).toEqual(await rawResponse.json());
    expect(subscriptions.listeners.size).toBe(0);
  });

  test("missing Bearer key receives 401", async () => {
    const response = await fetch(`${url}/orgs/${fixture.orgId}/drives/${fixture.driveId}/events`);
    expect(response.status).toBe(401);
    expect(subscriptions.listeners.size).toBe(0);
  });

  test("heartbeats keep the stream open across 12 seconds without mutations", async () => {
    const response = await open();
    const stream = frames(response);
    expect(await stream.next()).toStartWith("event: ready\n");
    const started = Date.now();
    await Bun.sleep(12_000);
    expect(await stream.next()).toBe(": ping");
    expect(await stream.next()).toBe(": ping");
    expect(Date.now() - started).toBeGreaterThanOrEqual(12_000);
    const writeResponse = await fetch(`${url}/orgs/${fixture.orgId}/ops`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ op: "write", path: "/after-silence.md", content: "still open" }),
    });
    expect(writeResponse.status).toBe(200);
    let change = await stream.next();
    while (change === ": ping") change = await stream.next();
    expect(change).toStartWith("event: file.changed\n");
  }, 20_000);

  test("the ninth stream receives 429 and client close releases its slot", async () => {
    for (let i = 0; i < 8; i++) {
      const response = await open();
      expect(response.status).toBe(200);
      await frames(response).next();
    }
    expect(subscriptions.listeners.size).toBe(8);
    expect((await open()).status).toBe(429);
    controllers[0].abort();
    await waitForCleanup(subscriptions.listeners, 7);
    const replacement = await open();
    expect(replacement.status).toBe(200);
    expect(await frames(replacement).next()).toStartWith("event: ready\n");
    expect(subscriptions.listeners.size).toBe(8);
  });
});

describe("drive stream cleanup without sockets", () => {
  test("body cancellation and request abort both remove listeners and release slots", async () => {
    const fixture = createTestContext();
    const app = createApp(fixture.db, fixture.s3);
    const subscriptions = trackSubscriptions();
    const path = `/orgs/${fixture.orgId}/drives/${fixture.driveId}/events`;
    const controllers: AbortController[] = [];
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    try {
      for (let i = 0; i < 10; i++) {
        const controller = new AbortController();
        controllers.push(controller);
        const response = await app.request(path, {
          headers: { Authorization: `Bearer ${fixture.apiKey}` },
          signal: controller.signal,
        });
        expect(response.status).toBe(200);
        const stream = frames(response);
        readers.push(stream.reader);
        expect(await stream.next()).toStartWith("event: ready\n");
        expect(subscriptions.listeners.size).toBe(1);
        if (i % 2 === 0) await stream.reader.cancel();
        else controller.abort();
        await waitForCleanup(subscriptions.listeners);
      }
    } finally {
      for (const controller of controllers) controller.abort();
      for (const reader of readers) await reader.cancel().catch(() => {});
      subscriptions.restore();
    }
  });

  test("the cap applies per user across drives and releases after cancellation", async () => {
    const fixture = createTestContext();
    const otherDrive = core.createDrive(fixture.db, { orgId: fixture.orgId, name: "Other", creatorUserId: fixture.userId });
    const app = createApp(fixture.db, fixture.s3);
    const subscriptions = trackSubscriptions();
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    const open = (driveId: string, key = fixture.apiKey) => app.request(`/orgs/${fixture.orgId}/drives/${driveId}/events`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    try {
      for (let i = 0; i < 8; i++) {
        const response = await open(i % 2 === 0 ? fixture.driveId : otherDrive.id);
        expect(response.status).toBe(200);
        const stream = frames(response);
        readers.push(stream.reader);
        await stream.next();
      }
      expect((await open(otherDrive.id)).status).toBe(429);
      const outsider = core.createUser(fixture.db, { email: "outsider@example.com" });
      expect((await open(fixture.driveId, outsider.apiKey)).status).toBe(404);
      const missingKey = await app.request(`/orgs/${fixture.orgId}/drives/${fixture.driveId}/events`);
      expect(missingKey.status).toBe(401);
      await readers[0].cancel();
      await waitForCleanup(subscriptions.listeners, 7);
      const replacement = frames(await open(fixture.driveId));
      readers.push(replacement.reader);
      expect(await replacement.next()).toStartWith("event: ready\n");
    } finally {
      for (const reader of readers) await reader.cancel().catch(() => {});
      await waitForCleanup(subscriptions.listeners);
      subscriptions.restore();
    }
  });

  test("an event write error removes the listener and releases its slot", async () => {
    const fixture = createTestContext();
    const app = createApp(fixture.db, fixture.s3);
    const subscriptions = trackSubscriptions();
    const path = `/orgs/${fixture.orgId}/drives/${fixture.driveId}/events`;
    const headers = { Authorization: `Bearer ${fixture.apiKey}` };
    const response = await app.request(path, { headers });
    const stream = frames(response);
    await stream.next();
    const write = spyOn(SSEStreamingApi.prototype, "writeSSE").mockRejectedValue(new Error("Test stream error"));
    try {
      core.publishDriveEvent({
        type: "file.changed", driveId: fixture.driveId, path: "/a.md", version: 1,
        operation: "write", actor: fixture.userId, at: new Date().toISOString(),
      });
      await waitForCleanup(subscriptions.listeners);
    } finally {
      write.mockRestore();
      await stream.reader.cancel().catch(() => {});
      subscriptions.restore();
    }
  });
});
