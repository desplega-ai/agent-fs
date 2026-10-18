import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PresenceLimitError, PresenceRegistry } from "../registry.js";
import { presenceStateSchema } from "../schema.js";
import type { PresenceEvent } from "../types.js";

const user = { id: "user-a", email: "a@example.com" };
const state = { path: "/a.md", mode: "view" as const, pointer: { quote: { exact: "word" }, charOffset: 0, lineStart: 1 } };
let now: number;
let registry: PresenceRegistry;
let events: PresenceEvent[];
beforeEach(() => {
  now = 100_000;
  events = [];
  registry = new PresenceRegistry({ now: () => now, getDisplayName: () => "Alice" });
  registry.subscribe("drive", (event) => events.push(event));
});
afterEach(() => registry.dispose());

describe("presence registry", () => {
  test("insert broadcasts updated and equal state refreshes TTL without changing updatedAt", () => {
    const first = registry.upsert("drive", "session-a", user, state);
    expect(first).toMatchObject({ displayName: "Alice", userId: user.id, email: user.email });
    expect(events).toEqual([{ type: "presence.updated", driveId: "drive", session: first, at: first.updatedAt }]);
    now += 40_000;
    const reordered = { mode: "view" as const, pointer: { lineStart: 1, charOffset: 0, quote: { exact: "word" } }, path: "/a.md" };
    expect(registry.upsert("drive", "session-a", user, reordered)).toEqual(first);
    expect(events).toHaveLength(1);
    now += 10_000;
    registry.sweep();
    expect(registry.snapshot("drive").sessions).toHaveLength(1);
    now += 35_001;
    registry.sweep();
    expect(registry.snapshot("drive").sessions).toHaveLength(0);
    expect(events[1]).toMatchObject({ type: "presence.left", sessionId: "session-a", userId: user.id });
  });

  test("changed state broadcasts, snapshots and inputs cannot mutate stored state", () => {
    const input = structuredClone(state);
    registry.upsert("drive", "session-a", user, input);
    input.pointer.quote.exact = "mutated";
    registry.snapshot("drive").sessions[0].pointer!.quote.exact = "mutated";
    expect(registry.snapshot("drive").sessions[0].pointer!.quote.exact).toBe("word");
    now++;
    registry.upsert("drive", "session-a", user, { path: null, mode: "edit" });
    expect(events).toHaveLength(2);
    expect(registry.snapshot("drive").sessions[0].updatedAt).toBe(new Date(now).toISOString());
    expect(registry.snapshot("another-drive").sessions).toEqual([]);
  });

  test("two binds require two unbinds, including a bind before the first PUT", () => {
    const first = registry.bind("drive", "session-a", user.id);
    const second = registry.bind("drive", "session-a", user.id);
    registry.upsert("drive", "session-a", user, state);
    first();
    first();
    expect(registry.snapshot("drive").sessions).toHaveLength(1);
    second();
    expect(registry.snapshot("drive").sessions).toHaveLength(0);
    expect(events.map((event) => event.type)).toEqual(["presence.updated", "presence.left"]);
  });

  test("a TTL sweep skips stream-bound sessions and expires unbound ones", () => {
    const unbind = registry.bind("drive", "session-a", user.id);
    registry.upsert("drive", "session-a", user, state);
    registry.upsert("drive", "session-b", user, state);
    now += 45_001;
    registry.sweep();
    expect(registry.snapshot("drive").sessions.map((s) => s.sessionId)).toEqual(["session-a"]);
    unbind();
    expect(registry.snapshot("drive").sessions).toEqual([]);
    expect(events.map((event) => [event.type, event.type === "presence.left" ? event.sessionId : event.session.sessionId])).toEqual([
      ["presence.updated", "session-a"],
      ["presence.updated", "session-b"],
      ["presence.left", "session-b"],
      ["presence.left", "session-a"],
    ]);
  });

  test("another user cannot replace, delete or bind an owned session", () => {
    const unbind = registry.bind("drive", "session-a", user.id);
    const other = { id: "user-b", email: "b@example.com" };
    expect(() => registry.upsert("drive", "session-a", other, state)).toThrow("belongs to another user");
    registry.upsert("drive", "session-a", user, state);
    expect(() => registry.remove("drive", "session-a", other.id)).toThrow("belongs to another user");
    expect(() => registry.bind("drive", "session-a", other.id)).toThrow("belongs to another user");
    unbind();
  });

  test("cap is 32 sessions per user per drive and permits updates at the cap", () => {
    for (let i = 0; i < 32; i++) registry.upsert("drive", `session-${i}`, user, state);
    expect(() => registry.upsert("drive", "overflow", user, state)).toThrow(PresenceLimitError);
    registry.upsert("drive", "session-0", user, { path: null, mode: "view" });
    registry.upsert("other-drive", "overflow", user, state);
    registry.upsert("drive", "overflow", { id: "user-b", email: "b@example.com" }, state);
    registry.remove("drive", "session-0", user.id);
    registry.upsert("drive", "replacement", user, state);
  });

  test("schema strips unknown keys and enforces nested limits", () => {
    expect(presenceStateSchema.parse({ ...state, userId: "spoof", pointer: { ...state.pointer, quote: { exact: "word", extra: true } } })).toEqual(state);
    for (const input of [
      { ...state, path: "a".repeat(4097) },
      { ...state, pointer: { ...state.pointer, charOffset: -1 } },
      { ...state, pointer: { ...state.pointer, lineStart: 0.5 } },
      { ...state, pointer: { ...state.pointer, quote: { exact: "x".repeat(257) } } },
      { ...state, pointer: { ...state.pointer, quote: { exact: "", prefix: "x".repeat(65) } } },
      { ...state, commentId: "x".repeat(129) },
    ]) expect(presenceStateSchema.safeParse(input).success).toBe(false);
  });
});
