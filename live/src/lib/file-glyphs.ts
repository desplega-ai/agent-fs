import {
  Braces,
  File,
  FileCode,
  FileText,
  Image,
  Lightbulb,
  ListChecks,
  Microscope,
  Palette,
  type LucideIcon,
} from "lucide-react"

export interface Glyph {
  Icon: LucideIcon
  className: string
}

const DEFAULT: Glyph = { Icon: File, className: "text-muted-foreground" }

/**
 * Resolve the lucide glyph + Tailwind tint for a file. Accepts the **full
 * path** so parent-dir context (`/research/`, `/plans/`, `/brainstorms/`) can
 * be honored.
 */
export function glyphFor(fullPath: string): Glyph {
  const path = fullPath.toLowerCase()
  const filename = path.split("/").pop() ?? ""
  const ext = filename.includes(".") ? filename.split(".").pop() ?? "" : ""

  // Markdown family — context-aware variants take priority over generic `.md`.
  if (filename.endsWith(".md") || filename.endsWith(".mdx")) {
    if (
      path.includes("/research/") ||
      filename.startsWith("research-")
    ) {
      return { Icon: Microscope, className: "text-violet-500" }
    }
    if (path.includes("/plans/") || filename.endsWith("-plan.md")) {
      return { Icon: ListChecks, className: "text-emerald-500" }
    }
    if (
      path.includes("/brainstorms/") ||
      filename.endsWith("-brainstorm.md")
    ) {
      return { Icon: Lightbulb, className: "text-amber-500" }
    }
    return { Icon: FileText, className: "text-emerald-500" }
  }

  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
      return { Icon: FileCode, className: "text-blue-500" }
    case "json":
    case "yaml":
    case "yml":
    case "toml":
      return { Icon: Braces, className: "text-amber-500" }
    case "css":
    case "scss":
      return { Icon: Palette, className: "text-purple-500" }
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "svg":
    case "webp":
      return { Icon: Image, className: "text-pink-500" }
    case "pdf":
      return { Icon: FileText, className: "text-rose-500" }
    default:
      return DEFAULT
  }
}
