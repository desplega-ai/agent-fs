import type { PrismTheme } from "prism-react-renderer"

// Brand-matched Prism themes. Colors derived from the site palette:
//   --neon:     oklch(0.866 0.295 142.5)  — bright green
//   --electric: oklch(0.452 0.313 264.05) — deep purple-blue
// Tokens lean on neon for code-as-language (keywords, tags) and electric for
// values (strings, numbers) so highlighted source feels native to the theme.

export const agentFsDark: PrismTheme = {
  plain: {
    color: "oklch(0.92 0 0)",
    backgroundColor: "transparent",
  },
  styles: [
    {
      types: ["comment", "prolog", "doctype", "cdata"],
      style: { color: "oklch(0.55 0 0)", fontStyle: "italic" },
    },
    {
      types: ["punctuation"],
      style: { color: "oklch(0.65 0 0)" },
    },
    {
      types: ["namespace"],
      style: { opacity: 0.7 },
    },
    {
      types: ["keyword", "operator", "tag", "selector", "atrule"],
      style: { color: "oklch(0.866 0.295 142.5)" }, // neon
    },
    {
      types: ["builtin", "class-name", "function", "attr-name", "property"],
      style: { color: "oklch(0.78 0.18 195)" }, // teal-cyan
    },
    {
      types: ["string", "char", "url", "attr-value", "regex"],
      style: { color: "oklch(0.78 0.22 290)" }, // light electric
    },
    {
      types: ["number", "boolean", "constant", "symbol"],
      style: { color: "oklch(0.80 0.18 60)" }, // amber
    },
    {
      types: ["variable", "parameter"],
      style: { color: "oklch(0.92 0 0)" },
    },
    {
      types: ["deleted"],
      style: { color: "oklch(0.65 0.20 25)" },
    },
    {
      types: ["inserted"],
      style: { color: "oklch(0.866 0.295 142.5)" },
    },
  ],
}

export const agentFsLight: PrismTheme = {
  plain: {
    color: "oklch(0.18 0 0)",
    backgroundColor: "transparent",
  },
  styles: [
    {
      types: ["comment", "prolog", "doctype", "cdata"],
      style: { color: "oklch(0.50 0 0)", fontStyle: "italic" },
    },
    {
      types: ["punctuation"],
      style: { color: "oklch(0.45 0 0)" },
    },
    {
      types: ["namespace"],
      style: { opacity: 0.7 },
    },
    {
      types: ["keyword", "operator", "tag", "selector", "atrule"],
      style: { color: "oklch(0.48 0.18 142.5)" }, // dark neon
    },
    {
      types: ["builtin", "class-name", "function", "attr-name", "property"],
      style: { color: "oklch(0.45 0.18 220)" }, // dark cyan
    },
    {
      types: ["string", "char", "url", "attr-value", "regex"],
      style: { color: "oklch(0.40 0.25 290)" }, // dark electric
    },
    {
      types: ["number", "boolean", "constant", "symbol"],
      style: { color: "oklch(0.50 0.18 50)" }, // dark amber
    },
    {
      types: ["variable", "parameter"],
      style: { color: "oklch(0.18 0 0)" },
    },
    {
      types: ["deleted"],
      style: { color: "oklch(0.45 0.22 25)" },
    },
    {
      types: ["inserted"],
      style: { color: "oklch(0.40 0.20 142.5)" },
    },
  ],
}
