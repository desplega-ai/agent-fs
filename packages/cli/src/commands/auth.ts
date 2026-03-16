import { Command } from "commander";
import type { ApiClient } from "../api-client.js";
import {
  setConfigValue,
  createUser,
  createDatabase,
  listUserOrgs,
} from "@/core";

export function authCommands(client: ApiClient) {
  const cmd = new Command("auth").description("Authentication commands");

  cmd
    .command("register")
    .argument("<email>", "Email address")
    .description("Register a new user")
    .action(async (email: string) => {
      // Try daemon first, fall back to direct DB registration
      try {
        const result = await client.post("/auth/register", { email });
        printRegistration(result, client);
      } catch {
        // Daemon not running — register directly against DB
        try {
          const db = createDatabase();
          const result = createUser(db, { email });
          const orgs = listUserOrgs(db, result.user.id);
          printRegistration(
            {
              apiKey: result.apiKey,
              userId: result.user.id,
              orgId: orgs[0]?.id,
            },
            client
          );
        } catch (err: any) {
          if (err.message?.includes("UNIQUE")) {
            console.error("Error: User with this email already exists.");
          } else {
            console.error(`Error: ${err.message}`);
          }
          process.exit(1);
        }
      }
    });

  cmd
    .command("whoami")
    .description("Show current user info")
    .action(async () => {
      try {
        const result = await client.get("/auth/me");
        console.log(JSON.stringify(result, null, 2));
      } catch {
        // Daemon not running — look up directly from DB
        try {
          const { getConfig, getUserByApiKey, createDatabase, listUserOrgs } = await import("@/core");
          const config = getConfig();
          if (!config.auth.apiKey) {
            console.error("Not logged in. Run: agent-fs auth register <email>");
            process.exit(1);
          }
          const db = createDatabase();
          const user = getUserByApiKey(db, config.auth.apiKey);
          if (!user) {
            console.error("Invalid API key in config.");
            process.exit(1);
          }
          const orgs = listUserOrgs(db, user.id);
          console.log(JSON.stringify({ ...user, orgs }, null, 2));
        } catch (err: any) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
      }
    });

  return cmd;
}

function printRegistration(
  result: { apiKey: string; userId: string; orgId: string },
  client: ApiClient
) {
  console.log(`Registered successfully!`);
  console.log(`API Key: ${result.apiKey}`);
  console.log(`User ID: ${result.userId}`);
  console.log(`Org ID: ${result.orgId}`);

  setConfigValue("auth.apiKey", result.apiKey);
  client.setApiKey(result.apiKey);
  console.log("\nAPI key saved to config.");
}
