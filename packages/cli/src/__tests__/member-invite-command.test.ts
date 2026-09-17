import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import type { ApiClient } from "../api-client.js";
import { driveCommands } from "../commands/drive.js";
import { memberCommands } from "../commands/member.js";

function mockClient(calls: Array<{ path: string; body: unknown }>): ApiClient {
  return {
    post: async (path: string, body: unknown) => {
      calls.push({ path, body });
      return { ok: true };
    },
  } as Pick<ApiClient, "post"> as ApiClient;
}

describe("drive-scoped invites", () => {
  test.each([
    ["member", memberCommands],
    ["drive", driveCommands],
  ] as const)("%s invite uses the drive member endpoint", async (name, commands) => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const program = new Command().option("--drive <driveId>");
    program.addCommand(commands(mockClient(calls), () => "org-1"));

    await program.parseAsync(
      ["--drive", "drive-2", name, "invite", "user@example.com", "--role", "editor"],
      { from: "user" }
    );

    expect(calls).toEqual([
      {
        path: "/orgs/org-1/drives/drive-2/members",
        body: { email: "user@example.com", role: "editor" },
      },
    ]);
  });
});
