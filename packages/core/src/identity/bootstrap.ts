import { getConfig, setConfigValue } from "../config.js";
import { getUserByApiKey, createUser } from "./users.js";
import type { DB } from "../db/index.js";

/**
 * Ensure a local user exists for embedded/local mode.
 * Reads config's auth.apiKey — if a valid user exists for that key, returns it.
 * Otherwise creates a local@agentfs.local user and persists the key to config.
 */
export function ensureLocalUser(db: DB): { apiKey: string } {
  const config = getConfig();
  if (config.auth.apiKey) {
    const user = getUserByApiKey(db, config.auth.apiKey);
    if (user) return { apiKey: config.auth.apiKey };
  }

  // No valid user — create one automatically
  console.error("[agent-fs] No local user found, creating one...");
  const result = createUser(db, { email: "local@agentfs.local" });
  setConfigValue("auth.apiKey", result.apiKey);
  console.error("[agent-fs] Local user created automatically.");
  return { apiKey: result.apiKey };
}
