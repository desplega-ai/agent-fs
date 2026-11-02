import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { shieldDashTokens } from "../dash-tokens.js";

// Real tokens are 32 random bytes as base64url: 43 chars, about 1 in 64 starting with "-".
const DASH = "-DSC3ZFdCnOK_q0aXk2W8sY1vJm4tR7uPbN9eLhGcIo";
const VERSION_LIKE = "-VSC3ZFdCnOK_q0aXk2W8sY1vJm4tR7uPbN9eLhGcIo";
const HELP_LIKE = "-hSC3ZFdCnOK_q0aXk2W8sY1vJm4tR7uPbN9eLhGcIo";
const DOUBLE_DASH = "--SC3ZFdCnOK_q0aXk2W8sY1vJm4tR7uPbN9eLhGcIo";
const PLAIN = "aDSC3ZFdCnOK_q0aXk2W8sY1vJm4tR7uPbN9eLhGcIo";

/** A program shaped like the real CLI: a version flag, global options, the token-taking commands and a few others. */
function buildProgram(seen: Record<string, any>): Command {
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
  program
    .command("mv")
    .exitOverride()
    .argument("<from>")
    .argument("<to>")
    .option("-m, --message <msg>")
    .action((from: string, to: string, opts: { message?: string }) => {
      seen.mv = { from, to, message: opts.message };
    });
  program
    .command("cp")
    .exitOverride()
    .argument("<from>")
    .argument("<to>")
    .action((from: string, to: string) => {
      seen.cp = { from, to };
    });
  program
    .command("grep")
    .exitOverride()
    .argument("<pattern>")
    .argument("<path>")
    .action((pattern: string, path: string) => {
      seen.grep = { pattern, path };
    });
  const config = new Command("config").exitOverride();
  config
    .command("set")
    .exitOverride()
    .argument("<key>")
    .argument("<value>")
    .action((key: string, value: string) => {
      seen.configSet = { key, value };
    });
  program.addCommand(config);
  program
    .command("ack")
    .exitOverride()
    .argument("[ids...]")
    .action((ids: string[]) => {
      seen.ack = ids;
    });
  return program;
}

function parse(args: string[]): Record<string, any> {
  const seen: Record<string, any> = {};
  const program = buildProgram(seen);
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
    expect(parse(["invite", "accept", "--json", DASH])).toMatchObject({ accept: DASH, opts: { json: true } });
  });

  test("invite accept keeps its operands in their original order", () => {
    expect(shieldDashTokens(buildProgram({}), ["invite", "accept", DASH, "extra", "--json"])).toEqual([
      "invite",
      "accept",
      "--json",
      "--",
      DASH,
      "extra",
    ]);
    expect(shieldDashTokens(buildProgram({}), ["invite", "accept", "x", DASH, "--", "y"])).toEqual([
      "invite",
      "accept",
      "--",
      "x",
      DASH,
      "y",
    ]);
  });

  test("commands that take no token keep their argv untouched", () => {
    const program = buildProgram({});
    const cases = [
      ["mv", DASH, "report.md"],
      ["mv", "-m", "msg", DASH, "report.md"],
      ["mv", "report.md", DASH],
      ["--json", "mv", DASH, "report.md", "--org", "o1"],
      ["cp", DASH, "report.md"],
      ["grep", DASH, "docs/"],
      ["grep", "pattern", DASH],
      ["config", "set", DASH, "value"],
      ["config", "set", "key", DASH],
      ["ack", "a", DASH, "b"],
      ["mount", "--remote", DASH],
      ["share-revoke", DASH],
    ];
    for (const args of cases) {
      expect(shieldDashTokens(program, args)).toBe(args);
    }
  });

  test("mv never swaps source and destination around a dash-led operand", () => {
    // Moving the operand behind "--" used to dispatch mv(report.md, <token>),
    // overwriting the destination and deleting report.md.
    const result = parse(["mv", DASH, "report.md"]);
    expect(result.mv).toBeUndefined();
    expect(result.error).toBe("commander.unknownOption");
    expect(parse(["cp", DASH, "report.md"]).cp).toBeUndefined();
    expect(parse(["config", "set", DASH, "value"]).configSet).toBeUndefined();
    expect(parse(["ack", "a", DASH, "b"]).ack).toBeUndefined();
    expect(parse(["mv", "a.md", "b.md", "-m", "note"]).mv).toEqual({ from: "a.md", to: "b.md", message: "note" });
  });

  test("a dash token only joins a token flag", () => {
    // share-revoke takes no token operand; --org is not a token flag.
    expect(parse(["share-revoke", DASH]).error).toBe("commander.unknownOption");
    expect(shieldDashTokens(buildProgram({}), ["share-revoke", "--org", DASH, "--token", DASH])).toEqual([
      "share-revoke",
      "--org",
      DASH,
      `--token=${DASH}`,
    ]);
    expect(parse(["--org", "o1", "share-revoke", "abc", "--token", DOUBLE_DASH])).toMatchObject({
      revoke: { id: "abc", token: DOUBLE_DASH },
      opts: { org: "o1" },
    });
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
