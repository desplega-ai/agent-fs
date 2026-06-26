import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  getConfig,
  setConfigValue,
  getDbPath,
  getConfigPath,
  createStorageAdapter,
  isLocalStorageConfig,
  createEmbeddingProviderFromEnv,
} from "@/core";

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

  cmd
    .command("validate")
    .description("Check that config, database, S3, and embeddings are healthy")
    .action(async () => {
      const results: { name: string; ok: boolean; message: string }[] = [];
      const config = getConfig();

      // 1. Config file exists
      const configExists = existsSync(getConfigPath());
      results.push({
        name: "Config file",
        ok: configExists,
        message: configExists ? getConfigPath() : "Not found — run `agent-fs onboard`",
      });

      // 2 + 3. Storage config + connectivity (provider-aware)
      if (isLocalStorageConfig(config.s3)) {
        // Local-FS backend: "validate" = root is set and creatable + writable.
        const root = config.s3.root;
        results.push({
          name: "Storage config",
          ok: !!root,
          message: root ? `local → ${root}` : "Missing: root",
        });
        if (root) {
          let ok = true;
          let message = `Writable (${root})`;
          try {
            mkdirSync(root, { recursive: true });
            const probe = join(root, `.agent-fs-probe-${process.pid}`);
            writeFileSync(probe, "ok");
            rmSync(probe);
          } catch (err: any) {
            ok = false;
            message = err.message || `Not writable: ${root}`;
          }
          results.push({ name: "Storage connectivity", ok, message });
        }
      } else {
        // S3 / MinIO backend: required fields + a live list probe. Capture a
        // narrowed local (the guard's narrowing is lost inside the .filter
        // callback since config.s3 is a property access).
        const s3cfg = config.s3;
        const s3Fields = ["endpoint", "bucket", "accessKeyId", "secretAccessKey"] as const;
        const missingS3 = s3Fields.filter((f) => !s3cfg[f]);
        results.push({
          name: "S3 config",
          ok: missingS3.length === 0,
          message:
            missingS3.length === 0
              ? `${s3cfg.provider} → ${s3cfg.endpoint}/${s3cfg.bucket}`
              : `Missing: ${missingS3.join(", ")}`,
        });

        if (missingS3.length === 0) {
          try {
            const s3 = createStorageAdapter(s3cfg);
            await s3.listObjects("");
            results.push({ name: "S3 connectivity", ok: true, message: "Connected" });
          } catch (err: any) {
            results.push({
              name: "S3 connectivity",
              ok: false,
              message: err.message || "Connection failed",
            });
          }
        }
      }

      // 4. Database
      const dbExists = existsSync(getDbPath());
      results.push({
        name: "Database",
        ok: dbExists,
        message: dbExists ? getDbPath() : "Not found — run `agent-fs onboard`",
      });

      // 5. Auth
      results.push({
        name: "Auth",
        ok: !!config.auth.apiKey,
        message: config.auth.apiKey ? "API key configured" : "No API key — run `agent-fs onboard`",
      });

      // 6. Embedding provider
      const embProvider = config.embedding.provider;
      const hasEmbKey = !!config.embedding.apiKey || !!process.env.OPENAI_API_KEY || !!process.env.GEMINI_API_KEY;
      if (embProvider === "openai" || embProvider === "gemini") {
        if (hasEmbKey) {
          try {
            const provider = await createEmbeddingProviderFromEnv(config.embedding);
            results.push({
              name: "Embeddings",
              ok: !!provider,
              message: provider ? `${embProvider} ready` : `${embProvider} configured but failed to init`,
            });
          } catch (err: any) {
            results.push({ name: "Embeddings", ok: false, message: err.message });
          }
        } else {
          results.push({
            name: "Embeddings",
            ok: false,
            message: `${embProvider} selected but no API key`,
          });
        }
      } else {
        results.push({
          name: "Embeddings",
          ok: true,
          message: "local/disabled (semantic search may be unavailable)",
        });
      }

      // Print results
      console.log("\nagent-fs health check\n");
      let allOk = true;
      for (const r of results) {
        const icon = r.ok ? "\u2713" : "\u2717";
        console.log(`  ${icon} ${r.name}: ${r.message}`);
        if (!r.ok) allOk = false;
      }
      console.log();

      if (allOk) {
        console.log("All checks passed.");
      } else {
        console.log("Some checks failed. Fix the issues above and re-run.");
        process.exit(1);
      }
    });

  return cmd;
}
