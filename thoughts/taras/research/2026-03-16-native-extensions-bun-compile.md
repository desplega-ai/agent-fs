---
date: 2026-03-16T12:00:00Z
topic: "Native Extensions (.dylib/.so/.dll) with bun build --compile"
---

# Research: Native Extensions (.dylib/.so/.dll) with `bun build --compile`

**Date**: 2026-03-16
**Problem**: `sqlite-vec` requires `vec0.dylib` loaded at runtime via `db.loadExtension()`, but `bun build --compile` only bundles JS. The native extension file is left behind, breaking the compiled binary.

---

## 1. Bun's Built-in Mechanisms

### 1.1 Embedding files with `import ... with { type: "file" }`

Since **Bun v1.1.5** (April 2024), `bun build --compile` supports embedding arbitrary files into the binary:

```ts
import myLib from "./path/to/native.dylib" with { type: "file" };
// At dev time: returns "./path/to/native.dylib"
// After compile: returns "$bunfs/native-a1b2c3d4.dylib"
```

The file data is embedded in the binary and accessible via `Bun.file()` or Node.js `fs` APIs. You can also use `Bun.embeddedFiles` to enumerate all embedded files as Blob objects.

**Critical limitation**: The `$bunfs/` path is a virtual filesystem. SQLite's `loadExtension()` calls C-level `sqlite3_load_extension()` which calls `dlopen()` -- this needs a **real filesystem path**. You cannot pass a `$bunfs/` path to `loadExtension()` directly.

### 1.2 NAPI .node addon embedding

Bun has built-in support for embedding `.node` (NAPI) addons in compiled binaries since **v1.0.23** (Jan 2024). The mechanism:
1. At build time, `.node` files are embedded in the binary
2. At runtime, Bun **extracts them to a temp directory**, loads them via `dlopen`, then **deletes the temp file immediately**

This is exactly the pattern we need, but it only works for `.node` NAPI addons -- not for arbitrary `.dylib` files loaded via `loadExtension()`.

### 1.3 FFI dylib embedding (v1.1.5+)

Bun supports embedding `.dylib/.so/.dll` files **specifically for use with `bun:ffi`'s `dlopen()`**. The flow:
1. `import myLib from "./lib.dylib" with { type: "file" }` embeds the file
2. Use `import { dlopen } from "bun:ffi"` to load it
3. Bun handles the extraction-to-temp-and-load internally for FFI

**This does NOT help with `sqlite3_load_extension()`** because SQLite's extension loader is a completely separate code path from `bun:ffi`.

### 1.4 `import.meta.dir` / `import.meta.url` in compiled binaries

Inside a compiled binary, `import.meta.dir` and `import.meta.url` resolve relative to the **current working directory**, not the binary location. This is a known issue (oven-sh/bun#13405). This means you cannot reliably resolve sibling files relative to the binary.

### 1.5 `Database.setCustomSQLite()` consideration

On macOS, we already use `Database.setCustomSQLite()` to load Homebrew's SQLite (which supports extensions). This needs a **real filesystem path** to `libsqlite3.dylib`. In a compiled binary, this dependency on Homebrew SQLite on the target machine remains -- it cannot be embedded.

---

## 2. How Other Projects Solve This

### 2.1 NAPI addons (better-sqlite3, sharp, canvas)

These use `.node` files (NAPI addons), which Bun embeds and auto-extracts. This works because Bun has special handling for `.node` files. **sqlite-vec does NOT use NAPI** -- it's a raw SQLite extension (`.dylib/.so/.dll`).

### 2.2 Prisma's approach

Prisma ships a "query engine" binary alongside the JS code. For compiled Bun binaries, this requires manually ensuring the engine binary is available at the expected path. There's no clean auto-embed solution; Docker/deployment configs must copy the engine from `node_modules/.prisma/`.

### 2.3 Community patterns

No established community pattern exists for shipping SQLite extensions alongside `bun build --compile` binaries. This is a gap in the ecosystem.

---

## 3. sqlite-vec Specifically

### 3.1 How `sqliteVec.load()` works (from source)

The `sqlite-vec` npm package (`index.mjs`) does:

```js
function getLoadablePath() {
  const packageName = platformPackageName(platform, arch);
  // e.g. "sqlite-vec-darwin-arm64"
  const loadablePath = join(
    fileURLToPath(new URL(join("."), import.meta.url)),
    "..",
    packageName,
    `vec0.${extensionSuffix(platform)}`
  );
  return loadablePath;
  // Returns something like: node_modules/sqlite-vec-darwin-arm64/vec0.dylib
}

function load(db) {
  db.loadExtension(getLoadablePath());
}
```

It resolves the platform-specific package directory relative to `import.meta.url`, finds `vec0.dylib` (or `.so`/`.dll`), and calls `db.loadExtension()` with the absolute path. In a compiled binary, `import.meta.url` resolves wrong and the file doesn't exist on disk anyway.

### 3.2 Direct `loadExtension()` with absolute path

Yes, you can bypass the `sqlite-vec` JS wrapper entirely:

```ts
db.loadExtension("/absolute/path/to/vec0.dylib");
```

This works if you know where the `.dylib` is on disk. The JS wrapper is just a convenience for finding the file.

### 3.3 Static compilation into SQLite

sqlite-vec supports static linking via `SQLITE_VEC_STATIC` compile flag. This compiles vec0 directly into the SQLite library itself, eliminating the need for `loadExtension()`. However:
- This requires building a **custom SQLite** with sqlite-vec baked in
- Bun ships its own SQLite internally; you'd need to use `Database.setCustomSQLite()` to point to your custom build
- The custom SQLite+vec0 library would still need to be a `.dylib` on disk
- This trades one native-file-on-disk problem for another (though you'd only have 1 file instead of 2)

### 3.4 WASM version of sqlite-vec

A WASM build of sqlite-vec exists (`sqlite-vec-wasm-demo` npm package), BUT:
- It must be **statically compiled into a WASM build of SQLite** -- you can't dynamically load it
- This means you'd need to use a WASM SQLite engine (like `sql.js`) instead of `bun:sqlite`
- `bun:sqlite` is 3-6x faster than alternatives; switching to WASM SQLite would be a major performance regression
- The WASM demo package is unstable and not semantically versioned
- **Not viable for server-side use with bun:sqlite**

---

## 4. Alternative Approaches

### 4.1 Extract-to-cache-dir at first run (RECOMMENDED)

Pattern:
1. Embed `vec0.dylib` in the binary via `import ... with { type: "file" }`
2. On startup, check if the extension exists in a cache directory (e.g. `~/.cache/agentfs/` or XDG_CACHE_HOME)
3. If not, extract from embedded data using `Bun.file()` + `Bun.write()` to write to disk
4. Call `db.loadExtension()` with the real filesystem path

```ts
import vec0Embedded from "../path/to/vec0.dylib" with { type: "file" };
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function getVec0Path(): string {
  const cacheDir = join(
    process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
    "agentfs"
  );
  const ext = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
  const cachedPath = join(cacheDir, `vec0.${ext}`);

  if (!existsSync(cachedPath)) {
    mkdirSync(cacheDir, { recursive: true });
    // vec0Embedded is a $bunfs path when compiled, real path in dev
    const data = Bun.file(vec0Embedded);
    Bun.write(cachedPath, data);
  }

  return cachedPath;
}
```

**Pros**: Single binary distribution, works cross-platform, fast after first run
**Cons**: First-run extraction step, need to handle cache invalidation on version upgrades, need to embed per-platform dylibs or build per-platform binaries (which we already do)

### 4.2 Ship the dylib alongside the binary (SIMPLEST)

Instead of a single binary, ship a tarball/zip containing:
- `agentfs` (the compiled binary)
- `vec0.dylib` (or `.so`/`.dll`)
- Optionally `libsqlite3.dylib` (for macOS)

Modify the binary to look for the extension relative to its own location (using `process.execPath` or `/proc/self/exe`).

**Pros**: Simple, no extraction needed, no virtual FS issues
**Cons**: Not a single file, install script needs updating, users can lose the dylib

### 4.3 Download on first run (like Prisma)

On first run, download the correct platform-specific extension from GitHub releases:

```ts
const version = "0.1.6";
const url = `https://github.com/asg017/sqlite-vec/releases/download/v${version}/sqlite-vec-${version}-loadable-${triple}.tar.gz`;
```

**Pros**: Single binary, always gets correct platform binary
**Cons**: Requires internet on first run, trust/security concerns, complex error handling

### 4.4 Build a custom SQLite with sqlite-vec statically linked

Build `libsqlite3+vec0.dylib` (a single shared library with both SQLite and vec0):
1. Compile sqlite-vec with `SQLITE_VEC_STATIC`
2. Build a custom SQLite that includes vec0
3. Use `Database.setCustomSQLite()` to load it
4. No `loadExtension()` call needed

**Pros**: Single native file, vec0 is always available, no extension loading issues
**Cons**: Complex build process, must maintain per-platform builds, still need the dylib on disk

### 4.5 Use `bun:ffi` to manually call `sqlite3_load_extension`

Instead of using `db.loadExtension()` (which goes through Bun's wrapper), use `bun:ffi` to:
1. Embed `vec0.dylib` with `import ... with { type: "file" }`
2. Use Bun's FFI `dlopen()` which handles embedded files natively
3. Manually call `sqlite3_load_extension` via FFI

**Pros**: Would leverage Bun's built-in embed+extract for FFI
**Cons**: Extremely fragile, need to handle SQLite's internal API via FFI, would need the db handle pointer, high complexity for uncertain gain

---

## 5. Our Current Codebase Context

### Current setup:
- **`packages/core/src/db/setup-sqlite.ts`**: Calls `Database.setCustomSQLite()` to use Homebrew's SQLite on macOS (Apple's SQLite disables extensions)
- **`packages/core/src/db/index.ts`**: Calls `sqliteVec.load(sqlite)` which resolves `vec0.dylib` from `node_modules/sqlite-vec-darwin-arm64/`
- **Build script**: `bun build --compile packages/cli/src/index.ts --outfile dist/agentfs` -- no special handling for native files
- **Release workflow**: Builds per-platform binaries (linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64) using `--target` flag
- **Install script**: Downloads a single binary, makes it executable, puts it in `/usr/local/bin`

### The vec0.dylib location at build time:
```
node_modules/.bun/sqlite-vec-darwin-arm64@0.1.6/node_modules/sqlite-vec-darwin-arm64/vec0.dylib
```
It's a Mach-O 64-bit dynamically linked shared library (arm64), ~158KB.

### Two native dependencies to solve:
1. **`vec0.dylib`** (or `.so`/`.dll`) -- the sqlite-vec extension
2. **`libsqlite3.dylib`** (macOS only) -- a vanilla SQLite build that supports extensions (because Apple's SQLite disables `sqlite3_load_extension`)

---

## Recommendations (ranked by practicality)

### Rank 1: Extract-to-cache-dir (Approach 4.1)

**Best balance of UX and engineering effort.**

- Embed `vec0.dylib` per platform using `import ... with { type: "file" }`
- On startup, extract to `~/.cache/agentfs/vec0-<version>.<ext>` if not already cached
- Version the cached file to handle upgrades cleanly
- For macOS, also need to handle the `libsqlite3.dylib` dependency (could embed Homebrew's or require `brew install sqlite`)
- The release workflow already builds per-platform, so each binary gets its platform's native file
- Install script stays as-is (single binary download)

**Open question**: Does `Bun.file()` on a `$bunfs/` path actually return the binary data? This needs empirical testing. If it does, this approach works cleanly. If not, we'd need to use `Bun.embeddedFiles` to find the blob by name.

### Rank 2: Ship alongside the binary (Approach 4.2)

**Simplest to implement, slightly worse UX.**

- Release artifacts become `.tar.gz` files instead of bare binaries
- Each contains `agentfs` + `vec0.dylib` (+ `libsqlite3.dylib` on macOS)
- Binary resolves extensions relative to `dirname(process.execPath)`
- Update install script to extract tarball instead of downloading single file
- Straightforward, no virtual FS complexity

### Rank 3: Custom SQLite with static sqlite-vec (Approach 4.4)

**Best long-term solution if we want zero runtime dependencies, but highest build complexity.**

- Build custom `libsqlite3.dylib` with vec0 statically linked for each platform
- Single native dependency to distribute
- Eliminates `loadExtension()` call entirely
- Could be shipped alongside binary (Rank 2 style) or extracted from cache (Rank 1 style)
- Significant CI/CD work to set up the cross-compilation build matrix

### Not recommended:
- **WASM sqlite-vec**: Performance regression, unstable package, incompatible with `bun:sqlite`
- **Download on first run**: Bad offline UX, security concerns
- **FFI hack**: Too fragile, too complex, too much C-level SQLite API surface

---

## Next Steps

1. **Empirically test**: Can we `Bun.file()` a `$bunfs/` path and `Bun.write()` it to disk? Build a minimal test.
2. **Decide**: Single binary (Rank 1) vs tarball (Rank 2)?
3. **Prototype**: Implement the chosen approach for one platform (darwin-arm64)
4. **macOS libsqlite3**: Decide whether to embed it or require Homebrew (current approach)

---

## Sources

- [Bun Single-file Executable Docs](https://bun.com/docs/bundler/executables)
- [Bun v1.1.5 Blog - FFI dylib embedding](https://bun.com/blog/bun-v1.1.5)
- [Bun v1.0.23 Blog - NAPI addon embedding](https://bun.sh/blog/bun-v1.0.23)
- [Bun SQLite Docs](https://bun.com/docs/runtime/sqlite)
- [Bun.embeddedFiles API](https://bun.com/reference/bun/embeddedFiles)
- [Bun FFI Docs](https://bun.com/docs/runtime/ffi)
- [sqlite-vec GitHub](https://github.com/asg017/sqlite-vec)
- [sqlite-vec JS usage](https://alexgarcia.xyz/sqlite-vec/js.html)
- [sqlite-vec WASM](https://alexgarcia.xyz/sqlite-vec/wasm.html)
- [sqlite-vec Compiling](https://alexgarcia.xyz/sqlite-vec/compiling.html)
- [Bun issue #13405 - import.meta.url in compiled binary](https://github.com/oven-sh/bun/issues/13405)
- [Bun issue #5445 - Embed directory in executable](https://github.com/oven-sh/bun/issues/5445)
- [Bun issue #14676 - Compiled binary depends on external files](https://github.com/oven-sh/bun/issues/14676)
- [Bun FFI + dylib tutorial](https://dev.to/calumk/bun-ffi-getting-started-with-c-and-bun-47ea)
