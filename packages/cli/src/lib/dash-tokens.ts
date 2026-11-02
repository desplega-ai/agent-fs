import type { Command } from "commander";

/** An invite or share token (32 random bytes as base64url, 43 chars) that starts with "-". */
const DASH_TOKEN_RE = /^-[A-Za-z0-9_-]{42}$/;

/**
 * The only places a token is accepted, keyed by command path. `positional`
 * means the command's operands may be a token; `flags` lists the options
 * whose value may be a token. Every other command keeps its argv untouched,
 * so a dash-led path in `mv`, `cp`, `grep` or `config set` is never moved.
 */
const TOKEN_COMMANDS: Record<string, { positional?: boolean; flags?: string[] }> = {
  "invite accept": { positional: true },
  "share-revoke": { flags: ["--token"] },
};

/**
 * Invite and share tokens are base64url, so about 1 in 64 starts with "-", and
 * commander reads such an argument as an option: `invite accept -DSC3…` fails
 * with "unknown option", and a token starting with "-V" prints the version,
 * because commander splits it into the `-V` flag plus the rest.
 *
 * For the commands in TOKEN_COMMANDS only, rewrite each token-shaped argument
 * so commander reads it as a value:
 * - right after a token flag, join the two (`--token=<t>`);
 * - as an operand, move every operand of the command behind a `--` separator,
 *   in its original order, ahead of any operands already after `--`.
 *
 * Options stay in front of `--`, and commander does not care about option
 * order, so the parsed result only differs in that the token is now a value.
 * `args` excludes the runtime and script entries of `process.argv`.
 */
export function shieldDashTokens(program: Command, args: string[]): string[] {
  const end = args.indexOf("--");
  const head = end === -1 ? args : args.slice(0, end);
  const tail = end === -1 ? [] : args.slice(end + 1);
  if (!head.some((arg) => DASH_TOKEN_RE.test(arg))) return args;

  // Flags that take a value, for the command the args address and its parents.
  const valueFlags = new Set<string>();
  const addFlags = (cmd: Command) => {
    for (const opt of cmd.options) {
      if (!opt.required && !opt.optional) continue;
      if (opt.long) valueFlags.add(opt.long);
      if (opt.short) valueFlags.add(opt.short);
    }
  };
  const isValueOf = (prev: string | undefined) => prev !== undefined && valueFlags.has(prev);

  // Resolve the addressed command and the index where its own args begin.
  let cmd = program;
  const path: string[] = [];
  let start = 0;
  addFlags(cmd);
  for (let i = 0; i < head.length; i++) {
    const arg = head[i];
    if (arg.startsWith("-") || isValueOf(head[i - 1])) continue;
    const sub = cmd.commands.find((c) => c.name() === arg || c.aliases().includes(arg));
    if (!sub) break;
    addFlags((cmd = sub));
    path.push(sub.name());
    start = i + 1;
  }

  const spec = TOKEN_COMMANDS[path.join(" ")];
  if (!spec) return args;
  const tokenFlags = new Set(spec.flags ?? []);

  const options: string[] = head.slice(0, start);
  const operands: string[] = [];
  let changed = false;
  for (let i = start; i < head.length; i++) {
    const arg = head[i];
    const prev = head[i - 1];
    if (isValueOf(prev)) {
      if (DASH_TOKEN_RE.test(arg) && tokenFlags.has(prev)) {
        options[options.length - 1] = `${prev}=${arg}`;
        changed = true;
      } else {
        options.push(arg);
      }
    } else if (DASH_TOKEN_RE.test(arg) && spec.positional) {
      operands.push(arg);
      changed = true;
    } else if (arg.length > 1 && arg.startsWith("-")) {
      options.push(arg);
    } else {
      operands.push(arg);
    }
  }
  if (!changed) return args;
  if (operands.length === 0 && end === -1) return options;
  return [...options, "--", ...operands, ...tail];
}
