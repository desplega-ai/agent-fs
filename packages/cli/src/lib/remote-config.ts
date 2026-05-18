// Resolves the `--remote` mount mode's API URL + API key from a 3-way
// precedence chain: CLI flags > env vars > `~/.agent-fs/config.json`.
//
// Both fields are required to enable remote mode. If neither source provides
// both, the caller surfaces a clear error and the helper falls back to local
// socket mode (or aborts, depending on whether `--remote` was explicit).

import { existsSync, readFileSync } from "node:fs";

/** Subset of `AgentFSConfig` that this resolver touches. */
interface ConfigFileShape {
  apiUrl?: string;
  apiKey?: string;
  auth?: { apiKey?: string };
}

/** CLI-flag overrides. Both optional — flags win when present. */
export interface RemoteFlags {
  apiUrl?: string;
  apiKey?: string;
}

/** Env subset the resolver reads. Pass `process.env` in production. */
export interface RemoteEnv {
  AGENT_FS_API_URL?: string;
  AGENT_FS_API_KEY?: string;
}

export interface ResolvedRemoteCreds {
  apiUrl: string;
  apiKey: string;
  /** Where each field came from — useful for diagnostics + deprecation warnings. */
  source: {
    apiUrl: "flag" | "env" | "config";
    apiKey: "flag" | "env" | "config";
  };
}

function readConfigFile(configPath: string): ConfigFileShape {
  if (!configPath || !existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as ConfigFileShape;
  } catch {
    // Malformed config is treated as missing — the daemon also tolerates this
    // (see `getConfig`'s deep-merge behaviour). The mount path doesn't need
    // to be stricter than the daemon.
    return {};
  }
}

/**
 * Merge CLI flags > env vars > config file in that order. Returns `null` if
 * either field is missing — the caller decides whether to error out (when
 * `--remote` was explicit) or fall back to local mode.
 *
 * Note on `apiKey`: we accept the top-level `config.apiKey` first (used by
 * the dashboard onboarding path), then fall back to `config.auth.apiKey`
 * (used by `agent-fs auth login`). This matches `ApiClient`'s resolution.
 */
export function resolveRemoteCreds(
  flags: RemoteFlags,
  configPath: string,
  env: RemoteEnv
): ResolvedRemoteCreds | null {
  const config = readConfigFile(configPath);
  const configApiKey = config.apiKey ?? config.auth?.apiKey;

  const apiUrl = flags.apiUrl ?? env.AGENT_FS_API_URL ?? config.apiUrl;
  const apiKey = flags.apiKey ?? env.AGENT_FS_API_KEY ?? configApiKey;

  if (!apiUrl || !apiKey) return null;

  const urlSource: "flag" | "env" | "config" = flags.apiUrl
    ? "flag"
    : env.AGENT_FS_API_URL
      ? "env"
      : "config";
  const keySource: "flag" | "env" | "config" = flags.apiKey
    ? "flag"
    : env.AGENT_FS_API_KEY
      ? "env"
      : "config";

  return {
    apiUrl,
    apiKey,
    source: { apiUrl: urlSource, apiKey: keySource },
  };
}
