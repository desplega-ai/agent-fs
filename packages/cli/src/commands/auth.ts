import { Command } from "commander";
import type { ApiClient } from "../api-client.js";
import { setConfigValue } from "@agentfs/core";

export function authCommands(client: ApiClient) {
  const cmd = new Command("auth").description("Authentication commands");

  cmd
    .command("register")
    .argument("<email>", "Email address")
    .description("Register a new user")
    .action(async (email: string) => {
      try {
        const result = await client.post("/auth/register", { email });
        console.log(`Registered successfully!`);
        console.log(`API Key: ${result.apiKey}`);
        console.log(`User ID: ${result.userId}`);
        console.log(`Org ID: ${result.orgId}`);

        // Save API key and org to config
        setConfigValue("auth.apiKey", result.apiKey);
        client.setApiKey(result.apiKey);
        console.log("\nAPI key saved to config.");
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command("whoami")
    .description("Show current user info")
    .action(async () => {
      try {
        const result = await client.get("/auth/me");
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  return cmd;
}
