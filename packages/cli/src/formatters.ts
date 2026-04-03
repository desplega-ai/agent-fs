/**
 * Pretty-print formatters for CLI output.
 * Each op has a formatter that takes the result object and returns a human-friendly string.
 * MCP always returns JSON — these formatters are CLI-only.
 */

// --- Helpers ---

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(d: string | Date | undefined): string {
  if (!d) return "-";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return String(d);
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function padRight(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function padLeft(s: string, len: number): string {
  return s.length >= len ? s : " ".repeat(len - s.length) + s;
}

// --- Per-op formatters ---

function formatLs(result: any): string {
  const entries: any[] = result.entries ?? [];
  if (entries.length === 0) return "(empty directory)";

  // Compute column widths
  const nameW = Math.max(4, ...entries.map((e: any) => String(e.name).length));
  const typeW = Math.max(4, ...entries.map((e: any) => String(e.type).length));
  const sizeW = Math.max(4, ...entries.map((e: any) => formatSize(e.size ?? 0).length));

  const header =
    padRight("NAME", nameW) +
    "  " +
    padRight("TYPE", typeW) +
    "  " +
    padLeft("SIZE", sizeW) +
    "  " +
    "MODIFIED";

  const lines = entries.map((e: any) =>
    padRight(e.name, nameW) +
    "  " +
    padRight(e.type, typeW) +
    "  " +
    padLeft(formatSize(e.size ?? 0), sizeW) +
    "  " +
    formatDate(e.modifiedAt)
  );

  return [header, ...lines].join("\n");
}

function formatCat(result: any): string {
  const content: string = result.content ?? "";
  const lines = content.split("\n");
  // Remove trailing empty line from split if content ends with newline
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const offset = result.offset ?? 1;
  const width = String(offset + lines.length - 1).length;
  return lines
    .map((line: string, i: number) => `${padLeft(String(offset + i), width)}  ${line}`)
    .join("\n");
}

function formatStat(result: any): string {
  const pairs: [string, string][] = [
    ["Path", result.path ?? "-"],
    ["Size", formatSize(result.size ?? 0)],
    ["Content-Type", result.contentType ?? "-"],
    ["Author", result.author ?? "-"],
    ["Version", result.currentVersion != null ? String(result.currentVersion) : "-"],
    ["Created", formatDate(result.createdAt)],
    ["Modified", formatDate(result.modifiedAt)],
    ["Deleted", result.isDeleted ? "yes" : "no"],
  ];
  if (result.embeddingStatus) {
    pairs.push(["Embedding", result.embeddingStatus]);
  }
  if (result.appUrl) {
    pairs.push(["App URL", result.appUrl]);
  }
  const labelW = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${padRight(k + ":", labelW + 1)}  ${v}`).join("\n");
}

function formatLog(result: any): string {
  const versions: any[] = result.versions ?? [];
  if (versions.length === 0) return "(no version history)";

  return versions
    .map((v: any) => {
      const parts = [`v${v.version}  ${formatDate(v.createdAt)}  ${v.author ?? "-"}  [${v.operation}]`];
      if (v.message) parts.push(`  ${v.message}`);
      if (v.diffSummary) parts.push(`  ${v.diffSummary}`);
      return parts.join("\n");
    })
    .join("\n\n");
}

function formatWrite(result: any): string {
  return `\u2713 wrote ${result.path} (v${result.version}, ${formatSize(result.size ?? 0)})`;
}

function formatEdit(result: any): string {
  return `\u2713 edited ${result.path} (v${result.version}, ${result.changes} change${result.changes !== 1 ? "s" : ""})`;
}

function formatAppend(result: any): string {
  return `\u2713 appended (v${result.version}, ${formatSize(result.size ?? 0)})`;
}

function formatRm(result: any): string {
  return result.deleted
    ? `\u2713 deleted ${result.path}`
    : `(not found: ${result.path})`;
}

function formatMv(result: any): string {
  return `\u2713 moved ${result.from} -> ${result.to} (v${result.version})`;
}

function formatCp(result: any): string {
  return `\u2713 copied ${result.from} -> ${result.to} (v${result.version})`;
}

function formatTree(result: any): string {
  const tree: any[] = result.tree ?? [];
  if (tree.length === 0) return "(empty)";

  const lines: string[] = [];

  function walk(entries: any[], prefix: string) {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 ";
      const suffix = entry.type === "directory" ? "/" : "";
      lines.push(`${prefix}${connector}${entry.name}${suffix}`);
      if (entry.children && entry.children.length > 0) {
        const childPrefix = prefix + (isLast ? "    " : "\u2502   ");
        walk(entry.children, childPrefix);
      }
    }
  }

  walk(tree, "");
  return lines.join("\n");
}

function formatGrep(result: any): string {
  const matches: any[] = result.matches ?? [];
  if (matches.length === 0) return "(no matches)";

  return matches
    .map((m: any) => `${m.path}:${m.lineNumber}: ${m.content}`)
    .join("\n");
}

function formatFts(result: any): string {
  const matches: any[] = result.matches ?? [];
  if (matches.length === 0) {
    return result.hint ? `(no matches) ${result.hint}` : "(no matches)";
  }

  const lines = matches.map(
    (m: any) => `${m.path} (rank: ${typeof m.rank === "number" ? m.rank.toFixed(2) : m.rank})\n  ${m.snippet}`
  );
  if (result.hint) lines.push(`\nhint: ${result.hint}`);
  return lines.join("\n\n");
}

function formatSearch(result: any): string {
  const results: any[] = result.results ?? [];
  if (results.length === 0) return "(no results)";

  return results
    .map(
      (r: any) =>
        `${r.path} (score: ${typeof r.score === "number" ? r.score.toFixed(3) : r.score})` +
        (r.author ? `  by ${r.author}` : "") +
        `\n  ${r.snippet}`
    )
    .join("\n\n");
}

function formatGlob(result: any): string {
  const matches: any[] = result.matches ?? [];
  if (matches.length === 0) return "(no matches)";

  return matches
    .map((m: any) => `${m.path}  ${formatSize(m.size ?? 0)}  ${formatDate(m.modifiedAt)}`)
    .join("\n");
}

function formatDiff(result: any): string {
  const changes: any[] = result.changes ?? [];
  if (changes.length === 0) return "(no changes)";

  return changes
    .map((c: any) => {
      const prefix = c.type === "add" ? "+" : c.type === "remove" ? "-" : " ";
      const lineNum = c.lineNumber != null ? `${c.lineNumber}: ` : "";
      return `${prefix} ${lineNum}${c.content}`;
    })
    .join("\n");
}

function formatTail(result: any): string {
  // tail returns CatResult, same format as cat
  return formatCat(result);
}

function formatRevert(result: any): string {
  return `\u2713 reverted to v${result.revertedTo} (new version: v${result.version})`;
}

function formatRecent(result: any): string {
  const entries: any[] = result.entries ?? [];
  if (entries.length === 0) return "(no recent activity)";

  return entries
    .map(
      (e: any) =>
        `${e.path}  v${e.version}  ${formatDate(e.createdAt)}  ${e.author ?? "-"}  [${e.operation}]` +
        (e.message ? `\n  ${e.message}` : "")
    )
    .join("\n\n");
}

function formatReindex(result: any): string {
  const parts: string[] = [];
  parts.push(`reindexed: ${result.reindexed ?? 0}`);
  if (result.failed) parts.push(`failed: ${result.failed}`);
  if (result.skipped) parts.push(`skipped: ${result.skipped}`);
  return parts.join(", ");
}

function formatSignedUrl(result: any): string {
  let out = `${result.url}\n\nExpires: ${formatDate(result.expiresAt)} (${result.expiresIn}s)`;
  if (result.appUrl) out += `\nApp:     ${result.appUrl}`;
  return out;
}

// --- Formatter registry ---

const formatters: Record<string, (result: any) => string> = {
  ls: formatLs,
  cat: formatCat,
  stat: formatStat,
  log: formatLog,
  write: formatWrite,
  edit: formatEdit,
  append: formatAppend,
  rm: formatRm,
  mv: formatMv,
  cp: formatCp,
  tree: formatTree,
  grep: formatGrep,
  fts: formatFts,
  search: formatSearch,
  "vec-search": formatSearch,
  glob: formatGlob,
  diff: formatDiff,
  tail: formatTail,
  revert: formatRevert,
  recent: formatRecent,
  reindex: formatReindex,
  "signed-url": formatSignedUrl,
};

function formatResult(opName: string, result: any): string {
  const formatter = formatters[opName];
  if (formatter) {
    return formatter(result);
  }
  // Fallback: JSON for unknown ops
  return JSON.stringify(result, null, 2);
}

/**
 * Single entry point for all CLI output.
 * If json is true, outputs raw JSON. Otherwise, uses the pretty-print formatter.
 */
export function outputResult(opName: string, result: any, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatResult(opName, result));
  }
}
