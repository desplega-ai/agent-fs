import { Command } from "commander";

export function daemonCommands() {
  const cmd = new Command("daemon").description("Daemon lifecycle management");

  cmd
    .command("start")
    .description("Start the agent-fs daemon")
    .action(async () => {
      const { startDaemon } = await import("@/server/daemon.js");
      startDaemon();
    });

  cmd
    .command("stop")
    .description("Stop the agent-fs daemon")
    .action(async () => {
      const { stopDaemon } = await import("@/server/daemon.js");
      stopDaemon();
    });

  cmd
    .command("status")
    .description("Check daemon status")
    .action(async () => {
      const { daemonStatus } = await import("@/server/daemon.js");
      const status = daemonStatus();
      if (status.running) {
        console.log(`Daemon running (PID: ${status.pid})`);
      } else {
        console.log("Daemon is not running");
      }
    });

  return cmd;
}
