import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { shieldDashTokens } from "../dash-tokens.js";

// Real tokens are 32 random bytes as base64url: 43 chars, about 1 in 64 starting with "-".
const DASH = "-DSC3ZFdCnOK_q0aXk2W8sY1vJm4tR7uPbN9eLhGcIo";
const VERSION_LIKE = "-VSC3ZFdCnOK_q0aXk2W8sY1vJm4tR7uPbN9eLhGcIo";
const HELP_LIKE = "-hSC3ZFdCnOK_q0aXk2W8sY1vJm4tR7uPbN9eLhGcIo";
const DOUBLE_DASH = "--SC3ZFdCnOK_q0aXk2W8sY1vJm4tR7uPbN9eLhGcIo";
const PLAIN = "aDSC3ZFdCnOK_q0aXk2W8sY1vJm4tR7uPbN9eLhGcIo";

/** A program shaped like the real CLI: a version flag, global options, and the token-taking commands. */
function parse(args: string[]): Record<string, any> {
  const seen: Record<string, any> = {};
  const program = new Command()
    .exitOverride()
    .version("1.2.3")
    .option("--org <orgId>")
    .option("--json")
    .configureOutput({
      writeOut: (s) => {
        seen.out = s;
      },
      writeErr: (s) => {
        seen.err = s;
      },
    });
  const invite = new Command("invite").exitOverride();
  invite
    .command("accept")
    .exitOverride()
    .argument("<token-or-url>")
    .action((token: string) => {
      seen.accept = token;
    });
  program.addCommand(invite);
  program
    .command("share-revoke")
    .exitOverride()
    .argument("[id]")
    .option("--token <token-or-url>")
    .action((id: string | undefined, opts: { token?: string }) => {
      seen.revoke = { id, token: opts.token };
    });
  program
    .command("mount")
    .exitOverride()
    .argument("<mountpoint>")
    .option("--remote")
    .action((mountpoint: string, opts: { remote?: boolean }) => {
      seen.mount = { mountpoint, remote: opts.remote };
    });

  try {
    program.parse(shieldDashTokens(program, args), { from: "user" });
  } catch (err: any) {
    seen.error = err.code;
  }
  return { ...seen, opts: program.opts() };
}

describe("shieldDashTokens", () => {
  test("invite accept takes a token that starts with '-'", () => {
    for (const token of [DASH, VERSION_LIKE, HELP_LIKE, DOUBLE_DASH]) {
      const result = parse(["invite", "accept", token]);
      expect(result.error).toBeUndefined();
      expect(result.accept).toBe(token);
    }
  });

  test("global options still apply before or after a dash token", () => {
    expect(parse(["invite", "accept", VERSION_LIKE, "--json", "--org", "o1"])).toMatchObject({
      accept: VERSION_LIKE,
      opts: { json: true, org: "o1" },
    });
    expect(parse(["--json", "invite", "accept", DASH])).toMatchObject({ accept: DASH, opts: { json: true } });
  });

  test("share-revoke --token takes a token that starts with '-V'", () => {
    expect(parse(["share-revoke", "--token", VERSION_LIKE]).revoke).toEqual({ id: undefined, token: VERSION_LIKE });
    expect(parse(["share-revoke", "--token", DASH, "--json"])).toMatchObject({
      revoke: { id: undefined, token: DASH },
      opts: { json: true },
    });
  });

  test("a boolean flag before a dash token leaves the token positional", () => {
    expect(parse(["mount", "--remote", DASH]).mount).toEqual({ mountpoint: DASH, remote: true });
  });

  test("an existing '--' separator is kept", () => {
    expect(parse(["invite", "accept", "--", DASH]).accept).toBe(DASH);
  });

  test("leaves args without a dash token unchanged", () => {
    const args = ["invite", "accept", PLAIN, "--json"];
    expect(shieldDashTokens(new Command(), args)).toBe(args);
    expect(parse(["-V"]).out).toBe("1.2.3\n");
    expect(parse(["invite", "accept", "--bogus"]).error).toBe("commander.unknownOption");
  });
});
