// Pure function that builds the argv + env pair the CLI passes to `spawn`
// when launching the FUSE helper child process.
//
// Two modes:
//   - `local` — talks to the daemon over a Unix socket. `socket` is required;
//               `apiUrl` + `apiKey` must NOT be set.
//   - `remote` — talks to a remote agent-fs HTTP API directly. `apiUrl` +
//               `apiKey` are required; `socket` must NOT be set (the helper
//               infers transport from absence of `--socket`).
//
// The API key never appears on argv (would show up in `ps`); it always travels
// through child-process env as `AGENT_FS_API_KEY`. The helper reads it via
// clap's `env = "AGENT_FS_API_KEY"` attribute (Phase 3).

export type FuseMode = "local" | "remote";

export interface BuildHelperSpawnArgsInput {
  mode: FuseMode;
  mountpoint: string;
  /** Path to the daemon's Unix socket. Required in `local` mode. */
  socket?: string;
  /** Remote API base URL. Required in `remote` mode. */
  apiUrl?: string;
  /** Remote API key. Required in `remote` mode. Forwarded via env, never argv. */
  apiKey?: string;
  /** Pass-through helper flag. */
  allowOther?: boolean;
  /** Pass-through helper flag. */
  foreground?: boolean;
  /** Path the helper writes its log to (--log-file). */
  logFile?: string;
}

export interface HelperSpawnArgs {
  argv: string[];
  env: Record<string, string>;
}

/**
 * Build the argv + env pair the CLI passes to `spawn`.
 *
 * Throws clear errors for mutually-exclusive / missing arguments — the CLI's
 * action handler catches and surfaces them.
 */
export function buildHelperSpawnArgs(input: BuildHelperSpawnArgsInput): HelperSpawnArgs {
  const { mode, mountpoint, socket, apiUrl, apiKey, allowOther, logFile } = input;

  if (!mountpoint) {
    throw new Error("buildHelperSpawnArgs: mountpoint is required");
  }

  // Validate mode-specific invariants up front. We reject mutually-exclusive
  // flag combos here (rather than in the CLI handler) so the tests catch them.
  if (mode === "remote") {
    if (socket) {
      throw new Error(
        "Cannot combine --remote with --socket — they select different transports. " +
          "Drop --socket to use remote HTTP transport."
      );
    }
    if (!apiUrl || !apiKey) {
      throw new Error(
        "--remote requires both an API URL and an API key. " +
          "Set via --api-url + --api-key, env vars AGENT_FS_API_URL + AGENT_FS_API_KEY, " +
          "or `apiUrl` + `apiKey` in ~/.agent-fs/config.json."
      );
    }
  } else {
    if (apiUrl || apiKey) {
      throw new Error(
        "--api-url / --api-key require --remote. " +
          "Pass --remote to enable HTTP transport, or drop the API flags for local socket mode."
      );
    }
    if (!socket) {
      throw new Error("buildHelperSpawnArgs: socket is required in local mode");
    }
  }

  const argv: string[] = ["--mountpoint", mountpoint];

  if (mode === "remote") {
    // The helper reads --api-url via clap, --api-key via env. Keeping the URL
    // on argv keeps `ps` output useful for debugging without leaking secrets.
    argv.push("--api-url", apiUrl!);
  } else {
    argv.push("--socket", socket!);
  }

  if (logFile) argv.push("--log-file", logFile);
  if (allowOther) argv.push("--allow-other");

  const env: Record<string, string> = {};
  if (mode === "remote") {
    env.AGENT_FS_API_KEY = apiKey!;
  }

  return { argv, env };
}
