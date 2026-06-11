import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
