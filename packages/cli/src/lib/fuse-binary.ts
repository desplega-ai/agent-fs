// Resolves the FUSE helper binary path.
//
// Resolution order (matches plan §Phase 3.6):
//   1. `$AGENT_FS_FUSE_BIN` if set and points at an existing file.
//   2. The per-platform sub-package `@desplega.ai/agent-fs-fuse-linux-<arch>`
//      installed via `optionalDependencies` (Phase 4 publishes those). The
//      binary lives at `<pkgDir>/bin/agent-fs-fuse`.
//   3. Hard error with install instructions.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const SUPPORTED_ARCHES: Record<string, string> = {
  x64: "@desplega.ai/agent-fs-fuse-linux-x64",
  arm64: "@desplega.ai/agent-fs-fuse-linux-arm64",
};

export interface ResolvedFuseBinary {
  /** Absolute path to the helper binary. */
  binPath: string;
  /** Where we resolved from (for diagnostics). */
  source: "env" | "subpackage";
}

/**
 * Resolve the helper binary path.
 *
 * On Darwin (the macOS dev host) the sub-package is `os: ["linux"]` and won't
 * install, so resolution falls through to the env override + error path. The
 * caller (the `mount` command) decides whether to surface that as a hard
 * error or as a "Linux-only" hint.
 */
export function resolveFuseBinary(): ResolvedFuseBinary {
  // 1. Env override — the local-dev escape hatch.
  const env = process.env.AGENT_FS_FUSE_BIN;
  if (env) {
    if (!existsSync(env)) {
      throw new Error(
        `AGENT_FS_FUSE_BIN is set to '${env}' but no file exists there. ` +
          `Did you build the helper? Run: cd packages/fuse-helper && cargo build --release`
      );
    }
    return { binPath: env, source: "env" };
  }

  // 2. Per-platform sub-package (populated on Linux only).
  const arch = process.arch;
  const pkgName = SUPPORTED_ARCHES[arch];
  if (pkgName) {
    try {
      const require = createRequire(import.meta.url);
      const pkgJson = require.resolve(`${pkgName}/package.json`);
      // package.json sits at <pkgDir>/package.json; bin/ sits next to it.
      const pkgDir = pkgJson.replace(/[\\/]package\.json$/, "");
      const candidate = join(pkgDir, "bin", "agent-fs-fuse");
      if (existsSync(candidate)) {
        return { binPath: candidate, source: "subpackage" };
      }
    } catch {
      /* fall through to error */
    }
  }

  throw new Error(
    "FUSE helper not found.\n" +
      "  • Linux: `npm install -g @desplega.ai/agent-fs` should have installed " +
      `\`${pkgName ?? "agent-fs-fuse-linux-<arch>"}\` automatically.\n` +
      "  • Local dev: build via `cd packages/fuse-helper && cargo build --release` " +
      "and set `AGENT_FS_FUSE_BIN=$(pwd)/packages/fuse-helper/target/release/agent-fs-fuse`."
  );
}

/**
 * Verify the helper binary against the optional manifest at
 * `~/.agent-fs/fuse-bin.manifest.json`. Phase 4 ships the manifest as part of
 * the release; for Phase 3 we tolerate its absence (warning) but enforce it
 * when present.
 *
 * Returns `null` if everything is fine, or an error string describing the
 * mismatch / missing manifest situation.
 */
export async function verifyFuseBinaryHash(
  binPath: string,
  manifestPath: string
): Promise<string | null> {
  if (!existsSync(manifestPath)) {
    return null; // Phase 4 owns the manifest; absence is allowed in v1.
  }
  const arch = process.arch === "x64" ? "linux-x64" : `linux-${process.arch}`;
  try {
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as {
      binaries: Record<string, string>;
    };
    const expected = manifest.binaries?.[arch];
    if (!expected) return null;
    const wantedHex = expected.replace(/^sha256:/, "");
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(await Bun.file(binPath).bytes());
    const actual = hasher.digest("hex");
    if (actual !== wantedHex) {
      return `binary hash mismatch — expected ${wantedHex}, got ${actual}`;
    }
    return null;
  } catch (err: any) {
    return `manifest verification failed: ${String(err?.message ?? err)}`;
  }
}
