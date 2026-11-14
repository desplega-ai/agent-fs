import { Database } from "bun:sqlite";
import type { OpContext } from "./types.js";
import { normalizePrefix } from "./paths.js";
import { hasLegacyFts, LEGACY_FTS_TABLE } from "../db/fts-migration.js";
import { legacyRowIsCurrent } from "../search/fts.js";
import { ValidationError } from "../errors.js";

export interface GrepParams {
  pattern: string;
  path: string;
}

export interface GrepMatch {
  path: string;
  lineNumber: number;
  content: string;
}

export interface GrepResult {
  matches: GrepMatch[];
}

const GREP_TIMEOUT_MS = 10_000;

// Matching runs on a worker thread: some patterns backtrack for seconds on a
// short line, and on the main thread that blocks every other request. Plain
// JavaScript in a string so it survives bundling into the single-file CLI.
const WORKER_SOURCE = `
self.onmessage = (event) => {
  const { pattern, files } = event.data;
  const regex = new RegExp(pattern);
  const matches = [];
  for (const file of files) {
    const lines = file.content.split("\\n");
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matches.push({ path: file.path, lineNumber: i + 1, content: lines[i] });
      }
    }
  }
  postMessage(matches);
};
`;

let workerUrl: string | undefined;

function matchInWorker(
  pattern: string,
  files: Array<{ path: string; content: string }>,
  timeoutMs: number
): Promise<GrepMatch[]> {
  workerUrl ??= URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "application/javascript" }));
  const worker = new Worker(workerUrl);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<GrepMatch[]>((resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ValidationError(`grep pattern did not finish within ${timeoutMs / 1000}s`, {
            field: "pattern",
            suggestion: "Simplify the pattern (avoid nested quantifiers) or narrow the path",
          })
        ),
      timeoutMs
    );
    worker.onmessage = (event: MessageEvent) => resolve(event.data);
    worker.onerror = (event: ErrorEvent) => reject(new Error(event.message || "grep worker failed"));
    worker.postMessage({ pattern, files });
  }).finally(() => {
    clearTimeout(timer);
    // Also stops a pattern that is still running after the timeout.
    worker.terminate();
  });
}

export async function grep(
  ctx: OpContext,
  params: GrepParams,
  timeoutMs = GREP_TIMEOUT_MS
): Promise<GrepResult> {
  // Compile here so an invalid pattern throws the same SyntaxError as before.
  new RegExp(params.pattern);
  const prefix = normalizePrefix(params.path);
  const raw = (ctx.db as any).$client as Database;

  // Read content from the local search index instead of fetching each file
  // from S3. files_fts_docs holds the full text and is indexed by (drive, path).
  const files = raw
    .prepare(
      "SELECT path, content FROM files_fts_docs WHERE drive_id = ? AND path LIKE ?"
    )
    .all(ctx.driveId, prefix + "%") as Array<{ path: string; content: string }>;

  // During the one-time index migration, rows not yet copied still live in
  // the legacy table, minus the ones the new layout has superseded.
  if (hasLegacyFts(raw)) {
    const legacy = raw
      .prepare(
        `SELECT path, content FROM ${LEGACY_FTS_TABLE}
         WHERE drive_id = ? AND path LIKE ?${legacyRowIsCurrent(LEGACY_FTS_TABLE)}`
      )
      .all(ctx.driveId, prefix + "%") as Array<{ path: string; content: string }>;
    files.push(...legacy);
  }

  if (files.length === 0) return { matches: [] };
  return { matches: await matchInWorker(params.pattern, files, timeoutMs) };
}
