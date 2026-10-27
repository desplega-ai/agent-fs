import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import { memberCommands } from "../commands/member.js";
import type { ApiClient } from "../api-client.js";

// Grants only raise a role. The CLI must print the role the server reports
// the person holds now, not the one the admin asked for.
describe("member add and invite print the effective role", () => {
  let lines: string[];
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    lines = [];
    logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
  });
  afterEach(() => logSpy.mockRestore());

  async function run(
    responses: { post: unknown },
    argv: string[]
  ): Promise<Array<{ path: string; body: unknown }>> {
    const posts: Array<{ path: string; body: unknown }> = [];
    const client = {
      get: async (path: string) => {
        if (path.endsWith("scope=manageable")) return { drives: [{ id: "drive-1", name: "ledger" }] };
        if (path === "/health") return { features: ["drive-invites", "pending-invites"] };
        throw new Error(`unexpected GET ${path}`);
      },
      post: async (path: string, body: unknown) => {
        posts.push({ path, body });
        return responses.post;
      },
    } as unknown as ApiClient;

    const program = new Command().option("--drive <driveId>").option("--json");
    program.addCommand(memberCommands(client, () => "org-1"));
    await program.parseAsync(argv, { from: "user" });
    return posts;
  }

  test("member add --role viewer prints admin when the person already is drive admin", async () => {
    const posts = await run(
      { post: { userId: "u1", email: "ana@example.com", driveId: "drive-1", role: "admin", created: false } },
      ["--drive", "ledger", "member", "add", "ana@example.com", "--role", "viewer"]
    );
    expect(posts).toEqual([
      { path: "/orgs/org-1/drives/drive-1/members", body: { email: "ana@example.com", role: "viewer" } },
    ]);
    expect(lines).toEqual(["Updated ana@example.com on drive ledger as admin"]);
  });

  test("member add prints the asked role for a new drive member", async () => {
    await run(
      { post: { userId: "u1", email: "ana@example.com", driveId: "drive-1", role: "viewer", created: true } },
      ["--drive", "ledger", "member", "add", "ana@example.com", "--role", "viewer"]
    );
    expect(lines).toEqual(["Added ana@example.com on drive ledger as viewer"]);
  });

  test("member invite --role viewer prints the org role the member keeps", async () => {
    await run(
      {
        post: {
          status: "added",
          userId: "u1",
          email: "ana@example.com",
          orgRole: "admin",
          drives: [{ driveId: "drive-1", role: "admin" }],
        },
      },
      ["member", "invite", "ana@example.com", "--role", "viewer", "--to", "ledger"]
    );
    expect(lines).toEqual(["Invited ana@example.com as admin", "  drive ledger (drive-1)  [admin]"]);
  });

  test("member invite falls back to the asked role on a server that omits orgRole", async () => {
    await run(
      { post: { status: "added", userId: "u1", email: "ana@example.com", drives: [] } },
      ["member", "invite", "ana@example.com", "--role", "editor", "--to", "ledger"]
    );
    expect(lines[0]).toBe("Invited ana@example.com as editor");
  });
});
