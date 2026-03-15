import { Command } from "commander";

export function daemonCommands() {
  const cmd = new Command("daemon").description("Daemon lifecycle management");

  cmd
    .command("start")
    .description("Start the agentfs daemon")
    .action(async () => {
      const { startDaemon } = await import("@agentfs/server/src/daemon.js");
      startDaemon();
    });

  cmd
    .command("stop")
    .description("Stop the agentfs daemon")
    .action(async () => {
      const { stopDaemon } = await import("@agentfs/server/src/daemon.js");
      stopDaemon();
    });

  cmd
    .command("status")
    .description("Check daemon status")
    .action(async () => {
      const { daemonStatus } = await import("@agentfs/server/src/daemon.js");
      const status = daemonStatus();
      if (status.running) {
        console.log(`Daemon running (PID: ${status.pid})`);
      } else {
        console.log("Daemon is not running");
      }
    });

  return cmd;
}
