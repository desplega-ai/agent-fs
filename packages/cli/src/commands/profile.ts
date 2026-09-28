import { Command } from "commander";
import type { ApiClient } from "../api-client.js";

export function profileCommands(client: ApiClient) {
  const cmd = new Command("profile").description("View or edit your own profile");
  cmd.command("get").description("Get your profile").action(async () => {
    console.log(JSON.stringify(await client.get("/auth/profile"), null, 2));
  });
  cmd.command("set").description("Set your display name")
    .requiredOption("--name <name>", "Display name (1–100 characters)")
    .action(async (opts: { name: string }) => {
      console.log(JSON.stringify(await client.patch("/auth/profile", { displayName: opts.name }), null, 2));
    });
  return cmd;
}
