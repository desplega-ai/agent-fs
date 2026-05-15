---
date: 2026-05-15
author: Claude (bg research)
topic: "Distributing native FUSE helper binary via npm"
tags: [research, agent-fs, npm, distribution, native-binary]
parent_brainstorm: thoughts/taras/brainstorms/2026-05-15-agent-fs-as-linux-filesystem.md
status: complete
---

# Distributing the agent-fs FUSE helper binary via npm

## Summary — recommendation

Use **`optionalDependencies` per-platform** (Pattern 1). It's the convergent
2026 best practice across esbuild, swc, napi-rs, turbo, rolldown, lightningcss,
biome, and openai/codex. The pattern is:

- Main package (`@desplega.ai/agent-fs`) declares each platform variant as an
  `optionalDependency`.
- Each variant (`@desplega.ai/agent-fs-fuse-linux-x64`, etc.) is its own npm
  package with `os` + `cpu` (+ `libc` where supported) constraints. The
  registry/resolver silently skips variants that don't match the install host.
- A tiny JS shim in the main package does
  `require('@desplega.ai/agent-fs-fuse-' + process.platform + '-' + process.arch)`
  at runtime to locate the binary.
- **No `postinstall` script needed** — works with `--ignore-scripts`, offline
  mirrors, corporate proxies, `npx`/`bunx` cold caches.
- Keep a minimal install-time fallback that downloads the matching tarball from
  the npm registry with SHA-256 verification (esbuild-style) only as a
  safety net when the optional-deps resolver mis-fires (a real npm bug class
  on `npm ci` and Windows). Do not rely on it.

Reject Pattern 2 (postinstall download from CDN/Releases): incompatible with
`--ignore-scripts`, hostile to enterprise proxies, no automatic caching across
projects, breaks under `npx`/`bunx`, requires a separate signing/hosting story.

## Pattern comparison

### Pattern 1 — `optionalDependencies` per platform

| Dimension | Behavior |
|---|---|
| `npm install` / `bun install` (cold) | Registry returns full lockfile; npm/bun resolves manifests for every optional dep but only fetches+extracts the one matching `process.platform`/`process.arch` (and `libc` for pnpm/bun). |
| `npm install` / `bun install` (warm) | Hit on the npm/bun global cache — same as any tarball. No special path. |
| `npx <pkg>` / `bunx <pkg>` | Same flow. `bunx` caches in `~/.bun/install/cache` and reuses on next invocation. ~100× faster than `npx` after first run. |
| Global install (`npm i -g`, `bun add -g`) | Identical resolution; binary lives under the global `node_modules` matching the host. |
| CI cache hit (Actions / Vercel) | The cache key includes the lockfile, and `package-lock.json` / `bun.lock` records the matching optional dep — so warm CI restores the host-matching tarball without re-resolving. |
| `--ignore-scripts` | **Works.** No postinstall is run; binary is just a file inside the platform package. This is the headline benefit. |
| Offline mirror / Verdaccio / Sonatype | Works as long as the mirror has the platform sub-packages. Cached the same way as JS packages. |
| Blocked egress to GitHub Releases / CDN | Doesn't matter — only talks to the npm registry. |
| Failure mode | Resolver bugs (`npm ci` re-install, Windows `package-lock.json` born on Linux, `--no-optional`, `yarn --ignore-optional`). Fallback path needed. |
| Signed binary verification | Inherits npm registry tarball integrity (SHA-512 in lockfile). Add npm provenance + SLSA attestation per sub-package. |
| Lockfile size | Grows with #platforms. Each variant gets a `packages` entry. ~20–80 lines per platform in `package-lock.json` / `bun.lock`. For 2 platforms (linux-x64, linux-arm64) this is trivial; for 14 (esbuild) it's still <1 MB. |
| Main install size | **No binary in main package.** Only the matching platform tarball is downloaded — the user pays for one ~10 MB binary, not all of them. |

### Pattern 2 — Postinstall download

| Dimension | Behavior |
|---|---|
| `npm install` | Main package extracts; postinstall script fetches binary from CDN/Releases at install time. |
| `npx`/`bunx` | Each cold cache miss redownloads from CDN — slow and burns CI bandwidth. |
| Global install | Same as local; postinstall runs once. |
| CI cache hit | The downloaded binary lives in `node_modules` so it caches with `node_modules`. But many CI jobs don't cache `node_modules` (they cache `~/.npm`/`~/.bun/install/cache` only) → cold download every CI run. |
| `--ignore-scripts` | **Broken.** Main package installs without a binary; the CLI crashes at runtime. Documented in esbuild #2519, Cypress/Playwright, claude-code #50270. |
| Offline mirror | Broken unless you proxy the binary host too. |
| Blocked egress to CDN | Broken. Common in enterprise/air-gapped envs. |
| Failure mode | Network flakes, signed-binary verification you must implement yourself, kernel-level AV blocking (esp. Windows), proxy auth. |
| Signed binary verification | DIY (download + verify hash + check signature). Often skipped — recent Playwright/Cypress incidents. |
| Lockfile size | Minimal — single dependency. |
| Main install size | Always downloads exactly the right binary, but the main tarball is bigger if you bundle a shell script + JS. |

### Concrete adopter list (2026)

| Tool | Pattern | Layout |
|---|---|---|
| esbuild | `optionalDependencies` + postinstall fallback (registry-side, with hash) | `@esbuild/{aix-ppc64, android-arm, android-arm64, android-x64, darwin-arm64, darwin-x64, freebsd-arm64, freebsd-x64, linux-arm, linux-arm64, linux-ia32, linux-loong64, linux-mips64el, linux-ppc64, linux-riscv64, linux-s390x, linux-x64, netbsd-arm64, netbsd-x64, openbsd-arm64, openbsd-x64, openharmony-arm64, sunos-x64, win32-arm64, win32-x64, win32-ia32}` |
| swc | `optionalDependencies` only | `@swc/core-{android-arm-eabi, android-arm64, darwin-arm64, darwin-x64, freebsd-x64, linux-arm-gnueabihf, linux-arm64-gnu, linux-arm64-musl, linux-x64-gnu, linux-x64-musl, win32-arm64-msvc, win32-ia32-msvc, win32-x64-msvc}` |
| turbo (vercel/turborepo) | `optionalDependencies` | `turbo-{linux-64, linux-arm64, darwin-64, darwin-arm64, windows-64, windows-arm64}` |
| rolldown | `optionalDependencies` (napi-rs template) | `@rolldown/binding-{linux-x64-gnu, linux-x64-musl, linux-arm64-gnu, linux-arm64-musl, darwin-x64, darwin-arm64, win32-x64-msvc, …, wasm32-wasi}` |
| lightningcss | `optionalDependencies` | `lightningcss-{darwin-arm64, darwin-x64, freebsd-x64, linux-arm-gnueabihf, linux-arm64-gnu, linux-arm64-musl, linux-x64-gnu, linux-x64-musl, win32-arm64-msvc, win32-ia32-msvc, win32-x64-msvc}` |
| napi-rs (framework, not a tool) | `optionalDependencies` — the template generates this layout by default | `<pkg>-<triple>` |
| openai/codex CLI | `optionalDependencies` (migrated 2025 in PR #11318) | `@openai/codex-{darwin-arm64, linux-x64-musl, linux-arm64-musl, …}` |
| Playwright / Cypress | Postinstall download (legacy) | single tarball, downloads browsers/binaries from CDN. Both have well-known `--ignore-scripts` and offline pain. |

Everyone with a meaningful native-binary distribution problem migrated to
Pattern 1 between 2021 (esbuild PR #1621) and 2025. New projects start there.

## Concrete `package.json` for agent-fs

### `packages/cli/package.json` (the main `@desplega.ai/agent-fs`)

```json
{
  "name": "@desplega.ai/agent-fs",
  "version": "0.6.0",
  "bin": { "agent-fs": "dist/cli.js" },
  "files": ["dist/cli.js", "README.md"],
  "optionalDependencies": {
    "@desplega.ai/agent-fs-fuse-linux-x64":   "0.6.0",
    "@desplega.ai/agent-fs-fuse-linux-arm64": "0.6.0",
    "sqlite-vec-darwin-arm64":  "^0.1.9",
    "sqlite-vec-darwin-x64":    "^0.1.9",
    "sqlite-vec-linux-arm64":   "^0.1.9",
    "sqlite-vec-linux-x64":     "^0.1.9",
    "sqlite-vec-windows-x64":   "^0.1.9"
  }
}
```

Pin the FUSE sub-packages to the **exact** main-package version (no caret).
The binary's CLI protocol is internal; matching the wrapper avoids skew when a
user has multiple agent-fs versions cached.

### `packages/fuse-linux-x64/package.json`

```json
{
  "name": "@desplega.ai/agent-fs-fuse-linux-x64",
  "version": "0.6.0",
  "description": "FUSE helper binary for agent-fs (linux x64)",
  "license": "MIT",
  "os": ["linux"],
  "cpu": ["x64"],
  "libc": ["glibc", "musl"],
  "files": ["bin/agent-fs-fuse"]
}
```

`libc` is honored by pnpm and bun but ignored by npm; ship a statically linked
or musl-compatible binary so a single linux-x64 package covers both glibc and
musl distros. Same for arm64. Alternative: split into `-linux-x64-gnu` and
`-linux-x64-musl` like swc/napi-rs — defer until you have musl users
complaining.

### Runtime resolver (JS, lives inside `dist/cli.js`)

```js
// in the main CLI before invoking the mount command
function resolveFuseBinary() {
  const triple = `${process.platform}-${process.arch}`;
  // statically enumerable so esbuild/bun build can keep the require()s
  const candidates = {
    "linux-x64":   "@desplega.ai/agent-fs-fuse-linux-x64",
    "linux-arm64": "@desplega.ai/agent-fs-fuse-linux-arm64",
  };
  const pkg = candidates[triple];
  if (!pkg) throw new Error(`agent-fs fuse: unsupported platform ${triple}`);
  try {
    const pkgJson = require.resolve(`${pkg}/package.json`);
    return path.join(path.dirname(pkgJson), "bin", "agent-fs-fuse");
  } catch (e) {
    throw new Error(
      `agent-fs fuse: ${pkg} is not installed. ` +
      `If you installed with --no-optional or --ignore-scripts, reinstall ` +
      `without those flags, or set AGENT_FS_FUSE_BIN to a local binary.`
    );
  }
}
```

Allow `AGENT_FS_FUSE_BIN` env override — invaluable for developing the helper
without `bun link` dances.

### Optional fallback (only if you hit the npm resolver bugs)

esbuild does this; it's not required on day one. Vendor a copy of esbuild's
`node-install.ts` logic: when the resolver-selected package is missing, fetch
the tarball directly from `registry.npmjs.org` with a SHA-256 hash baked into
the main package at publish time. This stays compatible with `--ignore-scripts`
(the fallback runs at *first CLI invocation*, not postinstall) and keeps
installs working when the lockfile lies.

## Bun-specific notes

- **`bun publish` supports platform sub-packages identically to `npm publish`**
  — same registry protocol, same `os`/`cpu` honored by `bun install`. Bun v1.2+
  also supports `--cpu` and `--os` flags on `bun install` for cross-platform
  install (Docker, lambdas).
- **`bun publish` does not yet support `--provenance`** (oven-sh/bun #15601 is
  still open as of 2026-05). Workaround:
  - Publish the **main** package with `bun publish` (matches your current
    workflow).
  - Publish the **platform sub-packages** with
    `bunx npm publish --provenance --access public` from the GitHub Actions
    release workflow. They're small, infrequent, and benefit most from
    provenance because they carry the actual native code.
- **`bunx`** caches platform-resolved tarballs in `~/.bun/install/cache`; cold
  hit is one HTTP request per platform sub-package per version, same as `npx`.
  Warm hit is near-instant.
- **`engines.bun`**: keep `bun >= 1.2.0` on the main package, omit `engines`
  from the sub-packages (they're consumed by anything that can install npm
  tarballs, including Node when someone uses agent-fs as a dependency for
  testing — keep the door open).
- **Build the FUSE helper outside Bun.** Bun-only is a *runtime* decision for
  agent-fs; the FUSE binary is a separate native artifact built in Rust or Go
  on its own GitHub Actions matrix and uploaded to the platform sub-package
  on release. Don't try to `bun build --compile` it.
- **`bun install --omit=optional`** breaks the resolver-selected variant just
  like `npm --no-optional` / `yarn --ignore-optional`. Document this; the
  fallback path is the safety net.

## Failure modes — checklist

| Failure | Pattern 1 | Pattern 2 |
|---|---|---|
| `--ignore-scripts` | OK | Broken |
| Offline / airgap mirror has all tarballs | OK | Broken (no CDN access) |
| Corporate proxy on registry only | OK | Broken |
| `npm ci` with lockfile from another platform (npm/cli #4828, #7961) | **Broken** — needs fallback or `npm install` re-resolve | OK |
| `--no-optional` / `--ignore-optional` | **Broken** — needs fallback | OK |
| User on glibc when only musl variant installed | Broken (split packages or static linking required) | Broken (same) |
| GitHub Releases / CDN down at install time | OK | Broken |
| npm registry down | Broken | Broken (also can't install JS) |
| Binary tampered in transit | Caught by registry SHA-512 + lockfile integrity | DIY — usually unchecked |

## Supply-chain hardening (post-TanStack-worm, May 2026)

The May 11, 2026 TanStack incident showed that **SLSA provenance alone isn't
sufficient** — the worm published 84 malicious tarballs with *valid* SLSA
attestations by hijacking the legitimate build pipeline. Mitigations that
actually help for native-binary publishing:

1. **Trusted Publishing (OIDC) from a tag-gated GitHub Actions workflow.**
   Remove long-lived npm tokens. The workflow only fires on `v*` tag push,
   and the tag must match `package.json` version (you already do this in
   `scripts/release.sh`).
2. **Publish from a single workflow that builds *and* publishes in one job.**
   Splitting build → cache → publish across jobs is exactly the surface the
   TanStack attack exploited (poisoned `actions/cache` restore).
3. **Embed SHA-256 of every platform binary into the main package at build
   time.** Verify at first run before exec'ing. This is what esbuild does and
   it's a real defense against a compromised sub-package even if the main
   package is signed.
4. **`bunx npm publish --provenance`** for the platform sub-packages (until
   `bun publish --provenance` lands). Provenance still has value — it tells a
   *human auditor* whether the artifact came from your tag, even if it can't
   stop a pipeline-hijack worm.
5. **Pin GitHub Actions by SHA, not by tag.** Earlier attacks abused moving
   action tags.
6. **No `postinstall` script.** Anything you don't run can't be hijacked.
   This is the second-order security win of Pattern 1 that the security
   community (Snyk, StepSecurity) has been pushing since 2024.
7. **Optional: sigstore-sign the binary itself** with `cosign` and ship the
   `.sig` next to it in the platform package. Verify at first run. Cost is
   ~50 lines of release-workflow YAML.

## Sources

- esbuild PR #1621 (switch to optionalDependencies): https://github.com/evanw/esbuild/pull/1621
- esbuild `node-platform.ts`: https://github.com/evanw/esbuild/blob/main/lib/npm/node-platform.ts
- esbuild platform-specific binaries (DeepWiki): https://deepwiki.com/evanw/esbuild/6.2-platform-specific-binaries
- esbuild `npm/esbuild/package.json`: https://github.com/evanw/esbuild/blob/main/npm/esbuild/package.json
- swc package.json: https://github.com/swc-project/swc/blob/main/package.json
- swc discussion #5268 (reduce native targets): https://github.com/swc-project/swc/discussions/5268
- napi-rs release docs: https://napi.rs/docs/deep-dive/release
- napi-rs package template: https://github.com/napi-rs/package-template
- turbo (Vercel) packaging: https://turborepo.dev/docs/getting-started/installation
- rolldown getting started: https://rolldown.rs/guide/getting-started
- lightningcss package.json: https://app.unpkg.com/lightningcss-cli@1.27.0/files/package.json
- openai/codex split npm packages PR #11318: https://github.com/openai/codex/pull/11318
- Sentry: How to publish binaries on npm: https://sentry.engineering/blog/publishing-binaries-on-npm
- MagicBell: Distributing platform-specific binaries with npm: https://www.magicbell.com/blog/distributing-platform-specific-binaries-with-npm
- Bun v1.2.23 (`--cpu`/`--os` install flags): https://bun.com/blog/bun-v1.2.23
- Bun `bun publish` docs: https://bun.com/docs/pm/cli/publish
- Bun #15601 (provenance support): https://github.com/oven-sh/bun/issues/15601
- Bun #1205 (optional deps OS-incompat): https://github.com/oven-sh/bun/issues/1205
- npm/cli #4828 (lock file omits platform-specific optional deps): https://github.com/npm/cli/issues/4828
- npm/cli #7961 (optional dep variants pruned): https://github.com/npm/cli/issues/7961
- npm/cli #5152 (`--cpu`/`--os` request): https://github.com/npm/cli/issues/5152
- npm trusted publishing docs: https://docs.npmjs.com/trusted-publishers/
- npm provenance docs: https://docs.npmjs.com/generating-provenance-statements/
- Sigstore on npm provenance GA: https://blog.sigstore.dev/npm-provenance-ga/
- Snyk TanStack incident analysis (May 2026): https://snyk.io/blog/tanstack-npm-packages-compromised/
- StepSecurity "Mini Shai-Hulud is Back": https://www.stepsecurity.io/blog/mini-shai-hulud-is-back-a-self-spreading-supply-chain-attack-hits-the-npm-ecosystem
- DEV: Rust Binary Distribution via npm (caching solutions): https://dev.to/pavkode/rust-binary-distribution-via-npm-addressing-security-risks-and-installation-failures-with-native-4809
