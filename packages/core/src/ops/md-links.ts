import { and, eq, gte, lt, or } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { OpContext, WriteLinkWarning } from "./types.js";

/**
 * Upper bound on distinct drive targets checked per write. Each costs one
 * indexed lookup; past this the rest go unchecked rather than slow the write.
 */
export const MAX_LINK_TARGETS = 50;

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Raw link and image destinations in a markdown document: inline
 * `[text](dest)` / `![alt](dest)`, reference definitions `[label]: dest`, and
 * HTML `<img src>`. Fenced code blocks and inline code spans are skipped, so
 * documented example syntax is not mistaken for a real link.
 */
export function extractMarkdownLinkTargets(markdown: string): string[] {
  const text = stripCode(markdown);
  const targets: string[] = [];
  const patterns = [
    /\]\(\s*(?:<([^>\n]*)>|([^\s()<>]+(?:\([^\s()]*\)[^\s()<>]*)*))/g,
    /^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*(?:<([^>\n]*)>|(\S+))/gm,
    /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const target = (match[1] ?? match[2] ?? "").trim();
      if (target) targets.push(target);
    }
  }
  return targets;
}

/**
 * The drive path a link target points at, resolved the way the live viewer
 * does: against the markdown file's own folder, with a leading `/` meaning the
 * drive root. Null for targets that never name a drive file: any URL scheme
 * (`https:`, `mailto:`, `data:`), protocol-relative `//host`, and pure
 * `#anchor` links.
 */
export function resolveLinkTarget(docPath: string, target: string): string | null {
  if (target.startsWith("#") || target.startsWith("//") || SCHEME.test(target)) {
    return null;
  }
  const bare = safeDecode(target.split("#")[0].split("?")[0]);
  if (bare === "") return null;
  const base = bare.startsWith("/") ? [] : docPath.split("/").slice(0, -1);
  const resolved: string[] = [];
  for (const segment of [...base, ...bare.split("/")]) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return "/" + resolved.join("/");
}

/**
 * Links in a markdown document whose target is not in the drive at write
 * time. A target counts as present when a live file sits at the path or under
 * it as a folder. Never throws: a failed check only drops the warning.
 */
export function findMissingLinkTargets(
  ctx: OpContext,
  docPath: string,
  markdown: string
): WriteLinkWarning[] {
  const byPath = new Map<string, string>();
  for (const link of extractMarkdownLinkTargets(markdown)) {
    const resolvedPath = resolveLinkTarget(docPath, link);
    if (resolvedPath === null || resolvedPath === "/" || byPath.has(resolvedPath)) continue;
    if (byPath.size >= MAX_LINK_TARGETS) break;
    byPath.set(resolvedPath, link);
  }

  const warnings: WriteLinkWarning[] = [];
  for (const [resolvedPath, link] of byPath) {
    try {
      if (!pathExists(ctx, resolvedPath)) {
        warnings.push({
          link,
          resolvedPath,
          message: `Link target not found at write time: ${link} resolves to ${resolvedPath}`,
        });
      }
    } catch {
      // Best effort: the write already succeeded.
    }
  }
  return warnings;
}

function pathExists(ctx: OpContext, path: string): boolean {
  const { files } = schema;
  const row = ctx.db
    .select({ path: files.path })
    .from(files)
    .where(
      and(
        eq(files.driveId, ctx.driveId),
        eq(files.isDeleted, false),
        // Exact file, or any file under `path/` (`0` sorts right after `/`).
        or(eq(files.path, path), and(gte(files.path, path + "/"), lt(files.path, path + "0")))
      )
    )
    .limit(1)
    .get();
  return row !== undefined;
}

function stripCode(markdown: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (open) {
        fence = open[1];
        continue;
      }
      kept.push(line);
    } else if (open && open[1][0] === fence[0] && open[1].length >= fence.length && line.trim() === open[1]) {
      fence = null;
    }
  }
  return kept.join("\n").replace(/(`+)[\s\S]*?\1/g, "");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
