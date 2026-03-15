import { Command } from "commander";
import { getConfig, setConfigValue } from "@agentfs/core";

export function configCommands() {
  const cmd = new Command("config").description("Configuration management");

  cmd
    .command("get")
    .argument("<key>", "Config key (dot notation, e.g., s3.bucket)")
    .description("Get a config value")
    .action((key: string) => {
      const config = getConfig();
      const keys = key.split(".");
      let value: any = config;
      for (const k of keys) {
        value = value?.[k];
      }
      if (value === undefined) {
        console.error(`Key not found: ${key}`);
        process.exit(1);
      }
      console.log(typeof value === "object" ? JSON.stringify(value, null, 2) : String(value));
    });

  cmd
    .command("set")
    .argument("<key>", "Config key")
    .argument("<value>", "Config value")
    .description("Set a config value")
    .action((key: string, value: string) => {
      // Try to parse as JSON for objects/numbers/booleans
      let parsed: any = value;
      try {
        parsed = JSON.parse(value);
      } catch {}
      setConfigValue(key, parsed);
      console.log(`Set ${key} = ${JSON.stringify(parsed)}`);
    });

  cmd
    .command("list")
    .description("Show all config")
    .action(() => {
      console.log(JSON.stringify(getConfig(), null, 2));
    });

  return cmd;
}
