import { Command } from "commander";
import { spawn, execSync } from "node:child_process";
import {
  getConfig,
  setConfigValue,
  createDatabase,
  createUser,
  getUserByApiKey,
  listUserOrgs,
  ensureLocalUser,
} from "@/core";

export function initCommand() {
  const cmd = new Command("init")
    .description("Set up agent-fs (S3 + database + first user)")
    .option("--local", "Use local MinIO Docker container for S3")
    .option("-y, --yes", "Accept all defaults without prompts")
    .action(async (opts: { local?: boolean; yes?: boolean }) => {
      console.log("Setting up agent-fs...\n");

      const isLocal = opts.local || opts.yes;

      if (isLocal) {
        await setupLocalMinIO();
      } else {
        await setupCustomS3();
      }

      // Initialize database
      console.log("\nInitializing database...");
      const db = createDatabase();
      console.log("Database ready.");

      // Register first user
      if (isLocal) {
        const { apiKey } = ensureLocalUser(db);
        const user = getUserByApiKey(db, apiKey)!;
        const orgs = listUserOrgs(db, user.id);

        console.log(`\nUser registered: ${user.email}`);
        console.log(`API Key: ${apiKey}`);
        console.log(`Org ID: ${orgs[0]?.id}`);
      } else {
        const email = await promptEmail();
        try {
          const result = createUser(db, { email });
          const orgs = listUserOrgs(db, result.user.id);
          setConfigValue("auth.apiKey", result.apiKey);

          console.log(`\nUser registered: ${email}`);
          console.log(`API Key: ${result.apiKey}`);
          console.log(`Org ID: ${orgs[0]?.id}`);
        } catch (err: any) {
          if (err.message?.includes("UNIQUE")) {
            console.log(`User ${email} already exists.`);
          } else {
            throw err;
          }
        }
      }

      console.log("\nSetup complete! Run `agent-fs daemon start` to begin.");
      console.log("Or use MCP directly: agent-fs mcp");
    });

  return cmd;
}

async function setupLocalMinIO() {
  // Docker pre-flight check
  try {
    execSync("which docker", { stdio: "ignore" });
    execSync("docker info", { stdio: "ignore" });
  } catch {
    console.error(
      "Docker is required for local mode (MinIO).\n" +
        "Install Docker: https://docs.docker.com/get-docker/\n" +
        "Or use 'agent-fs init' (without --local) to configure your own S3 bucket."
    );
    process.exit(1);
  }

  console.log("Setting up MinIO (local S3)...");

  // Check if container already exists
  try {
    const existing = execSync("docker ps -a --filter name=agent-fs-minio --format '{{.Names}}'", {
      encoding: "utf-8",
    }).trim();

    if (existing === "agent-fs-minio") {
      // Start if stopped
      execSync("docker start agent-fs-minio", { stdio: "inherit" });
      console.log("MinIO container started.");
    } else {
      // Create new container
      execSync(
        "docker run -d --name agent-fs-minio " +
          "-p 9000:9000 -p 9001:9001 " +
          "-v agent-fs-minio-data:/data " +
          "-e MINIO_ROOT_USER=minioadmin " +
          "-e MINIO_ROOT_PASSWORD=minioadmin " +
          'minio/minio server /data --console-address ":9001"',
        { stdio: "inherit" }
      );
      console.log("MinIO container created.");

      // Wait for startup and create bucket
      console.log("Waiting for MinIO to start...");
      await new Promise((r) => setTimeout(r, 3000));

      try {
        execSync(
          "docker exec agent-fs-minio mc alias set local http://localhost:9000 minioadmin minioadmin && " +
            "docker exec agent-fs-minio mc mb local/agentfs",
          { stdio: "inherit" }
        );
      } catch {
        // Bucket may already exist
      }
    }

    // Save container ID
    const containerId = execSync(
      "docker inspect --format='{{.Id}}' agent-fs-minio",
      { encoding: "utf-8" }
    ).trim();

    setConfigValue("minio.containerId", containerId);
    setConfigValue("minio.managed", true);
  } catch (err: any) {
    console.error(`Failed to set up MinIO: ${err.message}`);
    process.exit(1);
  }

  // Configure S3 for local MinIO
  setConfigValue("s3.provider", "minio");
  setConfigValue("s3.endpoint", "http://localhost:9000");
  setConfigValue("s3.bucket", "agentfs");
  setConfigValue("s3.region", "us-east-1");
  setConfigValue("s3.accessKeyId", "minioadmin");
  setConfigValue("s3.secretAccessKey", "minioadmin");

  console.log("MinIO configured.");
}

async function setupCustomS3() {
  // For non-interactive mode, just use defaults from config
  const config = getConfig();
  console.log("Using S3 configuration from ~/.agent-fs/config.json");
  console.log(`  Provider: ${config.s3.provider}`);
  console.log(`  Endpoint: ${config.s3.endpoint}`);
  console.log(`  Bucket: ${config.s3.bucket}`);
  console.log("\nEdit with: agent-fs config set s3.endpoint <url>");
}

async function promptEmail(): Promise<string> {
  // Simple stdin prompt
  process.stdout.write("Email for first user: ");
  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return new TextDecoder().decode(value).trim() || "local@agent-fs.local";
}
