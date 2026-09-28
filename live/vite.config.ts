import { readFileSync } from "fs"
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

/** Plausible site script id of the hosted UI (live.agent-fs.dev). */
const DEFAULT_PLAUSIBLE_SCRIPT_ID = "4ExgxHDFIoeAnKsDUlJ1U"

/**
 * Inject analytics only when VITE_PLAUSIBLE_ANALYTICS=1 (or true) is set
 * at build time. Self-hosted and local builds ship with no analytics script.
 * VITE_PLAUSIBLE_SCRIPT_ID selects a different Plausible site if needed.
 */
function plausibleAnalytics(): Plugin {
  const flag = (process.env.VITE_PLAUSIBLE_ANALYTICS ?? "").trim().toLowerCase()
  const enabled = flag === "1" || flag === "true"
  const scriptId =
    (process.env.VITE_PLAUSIBLE_SCRIPT_ID ?? "").trim() || DEFAULT_PLAUSIBLE_SCRIPT_ID
  return {
    name: "plausible-analytics",
    transformIndexHtml() {
      if (!enabled) return []
      return [
        {
          tag: "script",
          attrs: { async: true, src: `https://plausible.io/js/pa-${scriptId}.js` },
          injectTo: "head",
        },
        {
          tag: "script",
          children:
            "window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()",
          injectTo: "head",
        },
      ]
    },
  }
}

/** agent-fs release version (root package.json), sent with live telemetry. */
const APP_VERSION: string = JSON.parse(
  readFileSync(path.resolve(__dirname, "../package.json"), "utf-8"),
).version

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  plugins: [react(), tailwindcss(), plausibleAnalytics()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  optimizeDeps: {
    // DuckDB-WASM selects its own worker/wasm bundles via ?url imports —
    // pre-bundling breaks the worker URL resolution.
    exclude: ["@duckdb/duckdb-wasm"],
  },
})
