import { Command } from "commander";
import { execSync } from "node:child_process";
import {
  getConfig,
  setConfigValue,
  createDatabase,
  getUserByApiKey,
  listUserOrgs,
  ensureLocalUser,
  createUser,
  getConfigPath,
  getDbPath,
} from "@/core";
import { existsSync } from "node:fs";

export function onboardCommand() {
  const cmd = new Command("onboard")
    .description("Set up agent-fs (storage, embeddings, database, first user)")
    .option("--local", "Use local MinIO Docker container for S3")
    .option("--remote <url>", "Connect to a remote agent-fs server")
    .option("-y, --yes", "Accept all defaults without prompts")
    .option("--s3-endpoint <url>", "S3 endpoint URL")
    .option("--s3-bucket <name>", "S3 bucket name")
    .option("--s3-access-key <key>", "S3 access key ID")
    .option("--s3-secret-key <key>", "S3 secret access key")
    .option("--s3-region <region>", "S3 region")
    .option("--embeddings <provider>", "Embedding provider: openai, gemini, local, none")
    .option("--openai-key <key>", "OpenAI API key for embeddings")
    .option("--gemini-key <key>", "Gemini API key for embeddings")
    .option("--no-daemon", "Skip starting the daemon")
    .action(async (opts) => {
      // Step 0: API mode
      if (opts.remote) {
        console.error(
          "Remote mode is not yet supported in the onboard wizard.\n" +
            "To connect to a remote server, configure manually:\n" +
            '  agent-fs config set api.url "' + opts.remote + '"\n' +
            '  agent-fs config set api.key "<your-api-key>"'
        );
        process.exit(1);
      }

      // Check for existing config
      const configPath = getConfigPath();
      if (existsSync(configPath)) {
        const config = getConfig();
        if (config.auth.apiKey && !opts.yes) {
          console.log("Existing configuration found at " + configPath);
          console.log("Re-running onboard will update settings. Use -y to accept defaults.\n");
        }
      }

      console.log("Setting up agent-fs...\n");

      // Default to local mode unless explicit S3 flags or --remote provided
      const hasCustomS3 = opts.s3Endpoint || opts.s3Bucket || opts.s3AccessKey || opts.s3SecretKey;
      const isLocal = !hasCustomS3;

      // Step 1: Storage backend
      if (opts.s3Endpoint) {
        // Custom S3 from flags
        setConfigValue("s3.endpoint", opts.s3Endpoint);
        if (opts.s3Bucket) setConfigValue("s3.bucket", opts.s3Bucket);
        if (opts.s3AccessKey) setConfigValue("s3.accessKeyId", opts.s3AccessKey);
        if (opts.s3SecretKey) setConfigValue("s3.secretAccessKey", opts.s3SecretKey);
        if (opts.s3Region) setConfigValue("s3.region", opts.s3Region);
        setConfigValue("s3.provider", "s3");
        console.log("S3 configured from flags.");
      } else if (isLocal) {
        await setupLocalMinIO(!!opts.yes);
      } else {
        await setupCustomS3();
      }

      // Step 2: Embedding provider
      const embeddingProvider = opts.embeddings ?? (opts.yes ? "none" : undefined);
      if (embeddingProvider) {
        configureEmbeddings(embeddingProvider, opts);
      } else if (!opts.yes) {
        console.log("\nEmbedding provider not specified. Skipping (semantic search disabled).");
        console.log("Configure later: agent-fs config set embedding.provider openai");
      }

      // Step 3: Initialize database + user
      console.log("\nInitializing database...");
      const db = createDatabase();
      console.log("Database ready.");

      if (isLocal || opts.yes) {
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

      console.log("\nSetup complete! Run `agent-fs start` to begin.");
      console.log("Or use MCP directly: agent-fs mcp");
    });

  return cmd;
}

function configureEmbeddings(
  provider: string,
  opts: { openaiKey?: string; geminiKey?: string }
) {
  switch (provider) {
    case "openai":
      setConfigValue("embedding.provider", "openai");
      setConfigValue("embedding.model", "text-embedding-3-small");
      if (opts.openaiKey) {
        setConfigValue("embedding.apiKey", opts.openaiKey);
      }
      console.log("Embeddings: OpenAI (text-embedding-3-small)");
      break;
    case "gemini":
      setConfigValue("embedding.provider", "gemini");
      setConfigValue("embedding.model", "text-embedding-004");
      if (opts.geminiKey) {
        setConfigValue("embedding.apiKey", opts.geminiKey);
      }
      console.log("Embeddings: Google Gemini (text-embedding-004)");
      break;
    case "local":
      setConfigValue("embedding.provider", "local");
      console.log("Embeddings: local llama.cpp");
      break;
    case "none":
      setConfigValue("embedding.provider", "local");
      setConfigValue("embedding.model", "");
      setConfigValue("embedding.apiKey", "");
      console.log("Embeddings: disabled (semantic search unavailable)");
      break;
    default:
      console.error(`Unknown embedding provider: ${provider}`);
      console.error("Valid options: openai, gemini, local, none");
      process.exit(1);
  }
}

async function setupLocalMinIO(autoYes: boolean) {
  // Docker pre-flight check
  try {
    execSync("which docker", { stdio: "ignore" });
    execSync("docker info", { stdio: "ignore" });
  } catch {
    console.error(
      "Docker is required for local mode (MinIO).\n" +
        "Install Docker: https://docs.docker.com/get-docker/\n" +
        "Or use 'agent-fs onboard --s3-endpoint <url>' to configure your own S3 bucket."
    );
    process.exit(1);
  }

  // Check for existing container
  const existing = execSync(
    "docker ps -a --filter name=agent-fs-minio --format '{{.Names}}'",
    { encoding: "utf-8" }
  ).trim();

  if (existing === "agent-fs-minio") {
    console.log("Found existing MinIO container (agent-fs-minio).");
  }

  // Confirm before Docker operations (unless -y)
  if (!autoYes) {
    const action = existing === "agent-fs-minio" ? "start the existing" : "create a new";
    process.stdout.write(`This will ${action} MinIO Docker container. Continue? [Y/n] `);
    const reader = Bun.stdin.stream().getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    const answer = new TextDecoder().decode(value).trim().toLowerCase();
    if (answer === "n" || answer === "no") {
      console.log("Skipped MinIO setup. Configure S3 manually:");
      console.log("  agent-fs config set s3.endpoint <url>");
      return;
    }
  }

  console.log("Setting up MinIO (local S3)...");

  try {
    if (existing === "agent-fs-minio") {
      execSync("docker start agent-fs-minio", { stdio: "inherit" });
      console.log("MinIO container started.");
    } else {
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
    }

    // Always wait briefly and ensure bucket exists
    console.log("Waiting for MinIO to be ready...");
    await new Promise((r) => setTimeout(r, 2000));

    try {
      execSync(
        "docker exec agent-fs-minio mc alias set local http://localhost:9000 minioadmin minioadmin && " +
          "docker exec agent-fs-minio mc mb --ignore-existing local/agentfs",
        { stdio: "inherit" }
      );
    } catch {
      // Bucket creation best-effort
    }

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

  setConfigValue("s3.provider", "minio");
  setConfigValue("s3.endpoint", "http://localhost:9000");
  setConfigValue("s3.bucket", "agentfs");
  setConfigValue("s3.region", "us-east-1");
  setConfigValue("s3.accessKeyId", "minioadmin");
  setConfigValue("s3.secretAccessKey", "minioadmin");

  console.log("MinIO configured.");
}

async function setupCustomS3() {
  const config = getConfig();
  console.log("Using S3 configuration from ~/.agent-fs/config.json");
  console.log(`  Provider: ${config.s3.provider}`);
  console.log(`  Endpoint: ${config.s3.endpoint}`);
  console.log(`  Bucket: ${config.s3.bucket}`);
  console.log("\nEdit with: agent-fs config set s3.endpoint <url>");
}

async function promptEmail(): Promise<string> {
  process.stdout.write("Email for first user: ");
  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return new TextDecoder().decode(value).trim() || "local@agent-fs.local";
}
