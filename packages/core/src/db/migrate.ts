import { getConfig, getDbPath, getConfigPath } from "../config.js";
import { createDatabase } from "./index.js";

// Initialize config and database — creates all tables if they don't exist.
// Idempotent — safe to run multiple times.
getConfig(); // ensures config.json exists
createDatabase();

console.log("Config initialized at", getConfigPath());
console.log("Database initialized at", getDbPath());
