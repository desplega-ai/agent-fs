import { test, expect, spyOn } from "bun:test";
import { profileCommands } from "../commands/profile.js";
import type { ApiClient } from "../api-client.js";

test("profile commands use own-profile endpoints and preserve names", async () => {
  const calls: unknown[] = [];
  const client = {
    get: async (path: string) => { calls.push(["GET", path]); return {}; },
    patch: async (path: string, body: unknown) => { calls.push(["PATCH", path, body]); return {}; },
  } as ApiClient;
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await profileCommands(client).parseAsync(["get"], { from: "user" });
    await profileCommands(client).parseAsync(["set", "--name", "Taras Yarema"], { from: "user" });
    expect(calls).toEqual([["GET", "/auth/profile"], ["PATCH", "/auth/profile", { displayName: "Taras Yarema" }]]);
  } finally { log.mockRestore(); }
});
