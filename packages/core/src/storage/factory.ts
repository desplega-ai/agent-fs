import type { AgentFSConfig } from "../config.js";
import { isLocalStorageConfig } from "../config.js";
import { AgentS3Client } from "../s3/client.js";
import { LocalStorageAdapter } from "./local-adapter.js";
import type { StorageAdapter, StorageCapabilities } from "./adapter.js";

/**
 * TEST-ONLY capability overlay. When `AGENT_FS_CAPABILITY_OVERRIDE` is set to a
 * JSON object (e.g. `{"versioning":false}`), the adapter's advertised
 * `capabilities` are shallow-merged with it. This lets the e2e suite drive the
 * `UNSUPPORTED_OPERATION` path against a real backend that would otherwise have
 * the capability. Not for production use — gated entirely on the env var being
 * present.
 *
 * Folded here from `packages/server/src/index.ts` (step-2 placed it at the
 * construction site; step-4 moves it into the factory so it applies regardless
 * of which adapter is selected).
 */
function applyCapabilityOverride(adapter: StorageAdapter): void {
  const raw = process.env.AGENT_FS_CAPABILITY_OVERRIDE;
  if (!raw) return;
  try {
    const override = JSON.parse(raw) as Partial<StorageCapabilities>;
    const merged = { ...adapter.capabilities, ...override };
    Object.defineProperty(adapter, "capabilities", {
      value: merged,
      configurable: true,
    });
    console.warn("[test-only] AGENT_FS_CAPABILITY_OVERRIDE applied:", merged);
  } catch (err) {
    console.warn("Failed to parse AGENT_FS_CAPABILITY_OVERRIDE:", err);
  }
}

/**
 * Select the process-wide storage backend from the tagged-union storage config.
 *
 *   - `provider: "local"` → {@link LocalStorageAdapter} (filesystem, app-level
 *     versioning, no presigned URLs);
 *   - everything else → {@link AgentS3Client} (S3/MinIO, behavior unchanged).
 *
 * This is the single construction site for the storage adapter (called from the
 * daemon entrypoint and `config validate`). It also applies the test-only
 * capability override (see {@link applyCapabilityOverride}).
 */
export function createStorageAdapter(cfg: AgentFSConfig["s3"]): StorageAdapter {
  let adapter: StorageAdapter;
  if (isLocalStorageConfig(cfg)) {
    adapter = new LocalStorageAdapter({ root: cfg.root });
  } else {
    adapter = new AgentS3Client(cfg);
  }
  applyCapabilityOverride(adapter);
  return adapter;
}
