import type { Command } from "commander";

/** An invite or share token (32 random bytes as base64url, 43 chars) that starts with "-". */
const DASH_TOKEN_RE = /^-[A-Za-z0-9_-]{42}$/;

/**
 * Invite and share tokens are base64url, so about 1 in 64 starts with "-", and
 * commander reads such an argument as an option: `invite accept -DSC3…` fails
 * with "unknown option", and a token starting with "-V" prints the version,
 * because commander splits it into the `-V` flag plus the rest.
 *
 * Rewrite each token-shaped argument so commander reads it as a value:
 * - right after a flag that takes a value, join the two (`--token=<t>`, `-o<t>`);
 * - otherwise it is a positional: move it behind a `--` separator.
 *
 * No flag or command name is 43 characters long, so real options never match.
 * Moving a positional behind `--` keeps it correct because every command that
 * takes a token positional takes it as its only one. `args` excludes the
 * runtime and script entries of `process.argv`.
 */
export function shieldDashTokens(program: Command, args: string[]): string[] {
  // Flags that take a value, for the command the args address and its parents.
  const valueFlags = new Set<string>();
  const addFlags = (cmd: Command) => {
    for (const opt of cmd.options) {
      if (!opt.required && !opt.optional) continue;
      if (opt.long) valueFlags.add(opt.long);
      if (opt.short) valueFlags.add(opt.short);
    }
  };
  let cmd = program;
  addFlags(cmd);

  const end = args.indexOf("--");
  const head = end === -1 ? args : args.slice(0, end);
  const tail = end === -1 ? [] : args.slice(end + 1);
  const out: string[] = [];
  const positionals: string[] = [];
  for (const arg of head) {
    const prev = out.at(-1);
    const isValue = prev !== undefined && valueFlags.has(prev);
    if (!DASH_TOKEN_RE.test(arg)) {
      const sub = isValue ? undefined : cmd.commands.find((c) => c.name() === arg || c.aliases().includes(arg));
      if (sub) addFlags((cmd = sub));
      out.push(arg);
    } else if (isValue) {
      out[out.length - 1] = prev.startsWith("--") ? `${prev}=${arg}` : `${prev}${arg}`;
    } else {
      positionals.push(arg);
    }
  }
  if (out.length === head.length) return args;
  if (positionals.length === 0 && end === -1) return out;
  return [...out, "--", ...positionals, ...tail];
}
