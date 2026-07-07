import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import "vite-react-ssg"
import { PRERENDER_ROUTES, renderHeadTags } from "./src/seo"

function replaceHeadTags(html: string, route: string) {
  return html
    .replace(/\s*<meta name="description"[\s\S]*?>/, "")
    .replace(/\s*<link rel="canonical"[\s\S]*?>/, "")
    .replace(/\s*<link rel="alternate" type="text\/markdown"[\s\S]*?>/, "")
    .replace(/\s*<meta property="og:[\s\S]*?>/g, "")
    .replace(/\s*<meta name="twitter:[\s\S]*?>/g, "")
    .replace(
      /(<title>[\s\S]*?<\/title>)/,
      renderHeadTags(route),
    )
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  ssgOptions: {
    dirStyle: "nested",
    includedRoutes: () => [...PRERENDER_ROUTES],
    onPageRendered(route, html) {
      return replaceHeadTags(html, route)
    },
  },
})
