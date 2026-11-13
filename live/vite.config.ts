import { readFileSync } from "fs"
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"
import { ROUTE_TEMPLATES } from "./src/lib/route-template"

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
  // Page URLs carry API keys (query), invite tokens (fragment) and org, drive
  // and file names (path). Send the origin plus the route template instead,
  // and only the origin of other-origin URLs (outbound links, referrers).
  const routes = JSON.stringify(ROUTE_TEMPLATES.map(([re, template]) => [re.source, template]))
  const transformRequest = `function(p){var T=${routes};function t(s){var u;try{u=new URL(s,location.href)}catch(e){return location.origin}if(u.origin!==location.origin)return u.origin;for(var i=0;i<T.length;i++)if(new RegExp(T[i][0]).test(u.pathname))return u.origin+T[i][1];return u.origin+"/other"}p.u=t(p.u);if(p.r)p.r=t(p.r);if(p.p&&typeof p.p.url==="string")p.p.url=t(p.p.url);return p}`
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
            "window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};" +
            `plausible.init({transformRequest:${transformRequest}})`,
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
