import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createUser, inviteToOrg, updateProfile } from "@/core";
import { createTestContext } from "../../../core/src/test-utils.js";
import { createApp } from "../app.js";
import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";
import { eventRoutes } from "../routes/events.js";
import type { AppEnv } from "../types.js";

let fixture: ReturnType<typeof createTestContext>;
let app: ReturnType<typeof createApp>;
let path: string;
const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
beforeEach(() => {
  fixture = createTestContext();
  app = createApp(fixture.db, fixture.s3);
  path = `/orgs/${fixture.orgId}/drives/${fixture.driveId}`;
});
afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.cancel().catch(() => {});
});
function req(suffix: string, method = "GET", body?: unknown, key = fixture.apiKey) {
  return app.request(`${path}${suffix}`, {
    method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const state = { path: "/a.md", mode: "view" };
function frames(response: Response) {
  const reader = response.body!.getReader();
  readers.push(reader);
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    reader,
    async next(): Promise<string> {
      while (true) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (frame.startsWith(": ping")) continue;
          return frame;
        }
        const { done, value } = await reader.read();
        if (done) throw new Error("Stream ended before the expected frame");
        buffer += decoder.decode(value, { stream: true });
      }
    },
  };
}
const payload = (frame: string) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6));

describe("presence routes", () => {
  test("PUT GET DELETE, profile identity, stripped keys and idempotent DELETE", async () => {
    updateProfile(fixture.db, fixture.userId, { displayName: "Alice" });
    const put = await req("/presence/session-a", "PUT", { ...state, userId: "spoof", displayName: "spoof" });
    expect(put.status).toBe(200);
    const { session } = await put.json();
    expect(session).toEqual({ ...state, sessionId: "session-a", userId: fixture.userId, email: "test@example.com", displayName: "Alice", updatedAt: expect.any(String) });
    expect((await (await req("/presence")).json()).sessions).toEqual([session]);
    expect(await (await req("/presence/session-a", "DELETE")).json()).toEqual({ ok: true });
    expect(await (await req("/presence/session-a", "DELETE")).json()).toEqual({ ok: true });
    expect((await (await req("/presence")).json()).sessions).toEqual([]);
  });

  test("bad sessionId, invalid JSON and oversized quote return VALIDATION_ERROR", async () => {
    for (const [id, body] of [["bad", state], ["session-a", { ...state, pointer: { quote: { exact: "x".repeat(257) }, charOffset: 0, lineStart: 0 } }]] as const) {
      const res = await req(`/presence/${id}`, "PUT", body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("VALIDATION_ERROR");
    }
    const invalid = await app.request(`${path}/presence/session-a`, { method: "PUT", headers: { Authorization: `Bearer ${fixture.apiKey}`, "Content-Type": "application/json" }, body: "{" });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toBe("VALIDATION_ERROR");
  });

  test("non-members receive the same 404 as other drive routes", async () => {
    const outsider = createUser(fixture.db, { email: "outsider@example.com" });
    const raw = await (await req("/files/a.md/raw", "GET", undefined, outsider.apiKey)).json();
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await req(method === "GET" ? "/presence" : "/presence/session-a", method, method === "PUT" ? state : undefined, outsider.apiKey);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(raw);
    }
  });

  test("a viewer can publish but cannot replace, delete or bind another user's session", async () => {
    const other = createUser(fixture.db, { email: "viewer@example.com" });
    inviteToOrg(fixture.db, { orgId: fixture.orgId, email: other.user.email, role: "viewer" });
    expect((await req("/presence/session-b", "PUT", state, other.apiKey)).status).toBe(200);
    await req("/presence/session-a", "PUT", state);
    for (const method of ["PUT", "DELETE"]) {
      const res = await req("/presence/session-a", method, method === "PUT" ? state : undefined, other.apiKey);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("EDIT_CONFLICT");
    }
    expect((await req("/events?presence=1&sessionId=session-a", "GET", undefined, other.apiKey)).status).toBe(409);
  });

  test("the 33rd session returns RATE_LIMITED", async () => {
    for (let i = 0; i < 32; i++) expect((await req(`/presence/session-${i}`, "PUT", state)).status).toBe(200);
    const res = await req("/presence/overflow", "PUT", state);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("RATE_LIMITED");
  });

  test("presence and general limiters have independent budgets, and zero disables presence limiting", async () => {
    const saved = process.env.AGENT_FS_PRESENCE_RATE_LIMIT;
    const general = process.env.AGENT_FS_RATE_LIMIT;
    try {
      process.env.AGENT_FS_PRESENCE_RATE_LIMIT = "2";
      process.env.AGENT_FS_RATE_LIMIT = "2";
      app = createApp(fixture.db, fixture.s3);
      for (let i = 0; i < 2; i++) expect((await req("/presence")).status).toBe(200);
      const limited = await req("/presence");
      expect(limited.status).toBe(429);
      expect((await limited.json()).error).toBe("RATE_LIMITED");
      expect(limited.headers.get("Retry-After")).toBeTruthy();
      for (let i = 0; i < 2; i++) expect((await req("/files/absent/raw")).status).toBe(404);
      expect((await req("/files/absent/raw")).status).toBe(429);
      process.env.AGENT_FS_PRESENCE_RATE_LIMIT = "0";
      app = createApp(fixture.db, fixture.s3);
      for (let i = 0; i < 5; i++) expect((await req("/presence")).status).toBe(200);
    } finally {
      if (saved === undefined) delete process.env.AGENT_FS_PRESENCE_RATE_LIMIT;
      else process.env.AGENT_FS_PRESENCE_RATE_LIMIT = saved;
      if (general === undefined) delete process.env.AGENT_FS_RATE_LIMIT;
      else process.env.AGENT_FS_RATE_LIMIT = general;
    }
  });
});

describe("presence streams", () => {
  test("eventRoutes without a registry ignores presence=1", async () => {
    const legacy = new Hono<AppEnv>();
    legacy.use("*", authMiddleware(fixture.db));
    legacy.route("/orgs", eventRoutes(fixture.db));
    const plain = frames(await legacy.request(`${path}/events?presence=1&sessionId=session-a`, {
      headers: { Authorization: `Bearer ${fixture.apiKey}` },
    }));
    expect(await plain.next()).toStartWith("event: ready\n");
    await req("/presence/session-a", "PUT", state);
    await app.request(`/orgs/${fixture.orgId}/ops`, {
      method: "POST", headers: { Authorization: `Bearer ${fixture.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ op: "write", driveId: fixture.driveId, path: "/legacy.md", content: "a" }),
    });
    expect(await plain.next()).toStartWith("event: file.changed\n");
  });

  test("invalid stream sessionId opts in without binding", async () => {
    const stream = frames(await req("/events?presence=1&sessionId=bad"));
    expect(await stream.next()).toStartWith("event: ready\n");
    expect(await stream.next()).toStartWith("event: presence.snapshot\n");
  });

  test("snapshot follows ready, PUT emits updated, and last bound stream close emits left", async () => {
    const observer = frames(await req("/events?presence=1"));
    expect(await observer.next()).toStartWith("event: ready\n");
    const snapshot = await observer.next();
    expect(snapshot).toStartWith("event: presence.snapshot\n");
    expect(payload(snapshot).sessions).toEqual([]);
    const bound = frames(await req("/events?presence=1&sessionId=session-a"));
    await bound.next();
    await bound.next();
    const overlap = frames(await req("/events?presence=1&sessionId=session-a"));
    await overlap.next();
    await overlap.next();
    expect((await req("/presence/session-a", "PUT", state)).status).toBe(200);
    const updated = await observer.next();
    expect(updated).toStartWith("event: presence.updated\n");
    expect(payload(updated).session.sessionId).toBe("session-a");
    await bound.reader.cancel();
    expect((await (await req("/presence")).json()).sessions).toHaveLength(1);
    await overlap.reader.cancel();
    const left = await observer.next();
    expect(left).toStartWith("event: presence.left\n");
    expect(payload(left)).toMatchObject({ sessionId: "session-a", userId: fixture.userId });
  });

  test("a plain stream receives file.changed after ready despite presence updates", async () => {
    const plain = frames(await req("/events?sessionId=session-a"));
    expect(await plain.next()).toStartWith("event: ready\n");
    await req("/presence/session-a", "PUT", state);
    const write = await app.request(`/orgs/${fixture.orgId}/ops`, {
      method: "POST", headers: { Authorization: `Bearer ${fixture.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ op: "write", driveId: fixture.driveId, path: "/a.md", content: "a" }),
    });
    expect(write.status).toBe(200);
    expect(await plain.next()).toStartWith("event: file.changed\n");
    await plain.reader.cancel();
    expect((await (await req("/presence")).json()).sessions).toHaveLength(1);
  });
});
