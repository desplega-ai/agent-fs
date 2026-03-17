#!/usr/bin/env bun
/**
 * Interactive Fly.io deploy script for agent-fs.
 *
 * Usage:
 *   bun run scripts/fly-deploy.ts [options]
 *
 * Options:
 *   -y              Skip prompts, use defaults (autopilot mode)
 *   --app <name>    App name (default: agent-fs)
 *   --region <id>   Region (default: ams)
 *   --org <name>    Fly.io organization
 *   --help          Show help
 */

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
  app: "agent-fs",
  region: "ams", // EU default. Other options: ord (Chicago), iad (Virginia), sjc (San Jose), lhr (London)
  size: "shared-cpu-1x",
  storage: "tigris" as "tigris" | "byok",
};

const SIZES = ["shared-cpu-1x", "shared-cpu-2x", "performance-1x"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
Usage: bun run scripts/fly-deploy.ts [options]

Deploy agent-fs to Fly.io

Options:
  -y              Skip prompts, use defaults (autopilot mode)
  --app <name>    App name (default: ${DEFAULTS.app})
  --region <id>   Region (default: ${DEFAULTS.region})
  --org <name>    Fly.io organization
  --help          Show this help

Defaults (used with -y):
  App name:     ${DEFAULTS.app}
  Region:       ${DEFAULTS.region}
  Storage:      Tigris (auto-provisioned)
  Instance:     ${DEFAULTS.size}
`);
}

/**
 * Read a single line from stdin. Returns the trimmed input or the default.
 */
function ask(question: string, defaultValue: string): string {
  const answer = prompt(`${question} [${defaultValue}]: `);
  return answer?.trim() || defaultValue;
}

/**
 * Prompt user to pick from a numbered list. Returns the selected value.
 */
function askChoice<T extends string>(
  question: string,
  choices: readonly T[],
  defaultValue: T,
): T {
  const defaultIndex = choices.indexOf(defaultValue) + 1;
  console.log(`\n${question}`);
  for (let i = 0; i < choices.length; i++) {
    const marker = choices[i] === defaultValue ? " (default)" : "";
    console.log(`  ${i + 1}) ${choices[i]}${marker}`);
  }
  const answer = ask("Choice", String(defaultIndex));
  const index = parseInt(answer, 10) - 1;
  if (index >= 0 && index < choices.length) return choices[index];
  return defaultValue;
}

/**
 * Run a shell command with inherited stdio. Throws on non-zero exit.
 */
async function run(cmd: string, args: string[]): Promise<void> {
  console.log(`\n→ ${cmd} ${args.join(" ")}`);
  const proc = Bun.spawn([cmd, ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `Command failed with exit code ${exitCode}: ${cmd} ${args.join(" ")}`,
    );
  }
}

/**
 * Run a command and capture its stdout. Throws on non-zero exit.
 */
async function runCapture(cmd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([cmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `Command failed (exit ${exitCode}): ${cmd} ${args.join(" ")}\n${stderr}`,
    );
  }
  return stdout.trim();
}

/**
 * Check that a binary exists in PATH.
 */
async function checkBinary(name: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", name], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

async function checkPrerequisites(): Promise<void> {
  console.log("Checking prerequisites...\n");

  // Check fly CLI
  const hasFly = await checkBinary("fly");
  if (!hasFly) {
    console.error(
      "Error: fly CLI not found. Install it: https://fly.io/docs/flyctl/install/",
    );
    process.exit(1);
  }
  console.log("  fly CLI: found");

  // Check authentication
  try {
    const whoami = await runCapture("fly", ["auth", "whoami"]);
    console.log(`  Authenticated as: ${whoami}`);
  } catch {
    console.error(
      "Error: Not authenticated with Fly.io. Run: fly auth login",
    );
    process.exit(1);
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface Options {
  autopilot: boolean;
  app: string | null;
  region: string | null;
  org: string | null;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { autopilot: false, app: null, region: null, org: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-y") {
      opts.autopilot = true;
    } else if (arg === "--app" && i + 1 < argv.length) {
      opts.app = argv[++i];
    } else if (arg === "--region" && i + 1 < argv.length) {
      opts.region = argv[++i];
    } else if (arg === "--org" && i + 1 < argv.length) {
      opts.org = argv[++i];
    } else if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown option: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  console.log("agent-fs Fly.io Deploy\n");

  await checkPrerequisites();

  // ---- Gather configuration ----

  let appName: string;
  let region: string;
  let org: string | null;
  let storage: "tigris" | "byok";
  let size: string;

  // ---- Resolve org ----

  if (opts.org) {
    org = opts.org;
  } else if (opts.autopilot) {
    org = null; // fly defaults to personal org
  } else {
    // Fetch available orgs for the picker
    const orgsOutput = await runCapture("fly", ["orgs", "list", "--json"]);
    const orgsMap = JSON.parse(orgsOutput) as Record<string, string>; // {slug: name}
    const orgSlugs = Object.keys(orgsMap);
    if (orgSlugs.length === 1) {
      org = orgSlugs[0];
      console.log(`Using org: ${org}\n`);
    } else {
      org = askChoice("Organization:", orgSlugs as readonly string[] & readonly [string, ...string[]], orgSlugs[0]);
    }
  }

  if (opts.autopilot) {
    appName = opts.app ?? DEFAULTS.app;
    region = opts.region ?? DEFAULTS.region;
    storage = DEFAULTS.storage;
    size = DEFAULTS.size;
    console.log("Autopilot mode — using defaults:");
    console.log(`  Org:      ${org ?? "(personal)"}`);
    console.log(`  App:      ${appName}`);
    console.log(`  Region:   ${region}`);
    console.log(`  Storage:  Tigris (auto)`);
    console.log(`  Instance: ${size}`);
    console.log("");
  } else {
    appName = ask("App name", opts.app ?? DEFAULTS.app);
    region = ask("Region", opts.region ?? DEFAULTS.region);

    storage = askChoice(
      "Storage backend:",
      ["tigris", "byok"] as const,
      DEFAULTS.storage,
    );

    size = askChoice("Instance size:", SIZES, DEFAULTS.size);

    console.log(`\nConfiguration:`);
    console.log(`  App:      ${appName}`);
    console.log(`  Region:   ${region}`);
    console.log(`  Storage:  ${storage === "tigris" ? "Tigris (auto)" : "BYOK (manual S3 credentials)"}`);
    console.log(`  Instance: ${size}`);
    console.log("");
  }

  // ---- Step 1: Launch app ----

  console.log("Step 1/5: Creating Fly app...");
  const launchArgs = [
    "launch",
    "--name", appName,
    "--region", region,
    "--no-deploy",
    "--copy-config",
    "--yes",
  ];
  if (org) launchArgs.push("--org", org);
  await run("fly", launchArgs);

  // ---- Step 2: Create volume ----

  console.log("\nStep 2/5: Creating persistent volume...");
  await run("fly", [
    "volumes", "create", "agent_fs_data",
    "--size", "1",
    "--region", region,
    "-y",
  ]);

  // ---- Step 3: Configure storage ----

  if (storage === "tigris") {
    console.log("\nStep 3/5: Provisioning Tigris storage...");
    const bucketName = opts.autopilot
      ? `${appName}-storage`
      : ask("Tigris bucket name", `${appName}-storage`);
    await run("fly", ["storage", "create", "--name", bucketName, "-a", appName, "-y"]);
  } else {
    console.log("\nStep 3/5: Configuring BYOK S3 storage...");
    const endpoint = ask("S3 endpoint URL", "");
    const bucket = ask("S3 bucket name", "agentfs");
    const accessKey = ask("S3 access key ID", "");
    const secretKey = ask("S3 secret access key", "");
    const s3Region = ask("S3 region", "us-east-1");

    if (!endpoint || !accessKey || !secretKey) {
      throw new Error(
        "S3 endpoint, access key, and secret key are all required for BYOK storage.",
      );
    }

    await run("fly", [
      "secrets", "set",
      `S3_ENDPOINT=${endpoint}`,
      `S3_BUCKET=${bucket}`,
      `S3_ACCESS_KEY_ID=${accessKey}`,
      `S3_SECRET_ACCESS_KEY=${secretKey}`,
      `S3_REGION=${s3Region}`,
    ]);
  }

  // ---- Step 4: Set VM size if non-default ----

  if (size !== DEFAULTS.size) {
    console.log(`\nStep 4/5: Setting VM size to ${size}...`);
    await run("fly", ["scale", "vm", size]);
  } else {
    console.log(`\nStep 4/5: VM size is default (${size}), skipping.`);
  }

  // ---- Step 5: Deploy ----

  console.log("\nStep 5/5: Deploying...");
  await run("fly", ["deploy"]);

  // ---- Success ----

  const appUrl = `https://${appName}.fly.dev`;

  console.log(`
========================================
  Deployment complete!
========================================

  App URL: ${appUrl}

  Next steps:

  1. Register your first API key:

     curl -s -X POST ${appUrl}/auth/register \\
       -H "Content-Type: application/json" \\
       -d '{"email": "you@example.com"}' | jq .

  2. Use the returned API key to authenticate:

     agent-fs config set apiUrl ${appUrl}
     agent-fs config set apiKey <your-api-key>

  3. Verify it works:

     agent-fs ls /

  Useful commands:

     fly status -a ${appName}       # Check app status
     fly logs -a ${appName}         # View logs
     fly ssh console -a ${appName}  # SSH into the machine
`);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
