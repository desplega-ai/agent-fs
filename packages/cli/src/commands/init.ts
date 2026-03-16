import { Command } from "commander";
import { onboardCommand } from "./onboard.js";

export function initCommand() {
  // init is an alias for onboard — kept for backwards compatibility
  const onboard = onboardCommand();
  const cmd = new Command("init")
    .description("Set up agent-fs (alias for 'onboard')")
    .allowUnknownOption(true)
    .action(async (_opts, command) => {
      console.log("Note: 'agent-fs init' is now 'agent-fs onboard'.\n");
      // Re-parse with the onboard command to handle all flags
      await onboard.parseAsync(command.args, { from: "user" });
    });

  // Copy options from onboard so --help shows them
  for (const opt of onboard.options) {
    cmd.addOption(opt);
  }

  return cmd;
}
