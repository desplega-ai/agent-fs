import type { Database } from "bun:sqlite";
import { getEmbeddingExcludeDrives } from "../config.js";
import type { OpContext } from "../ops/types.js";
import type { DB } from "../db/index.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getS3Key } from "../ops/versioning.js";
import { EmbeddingInitializationError, type EmbeddingProvider } from "./embeddings/provider.js";
import { DEFAULT_CPU_SHARE, embeddingFormat, storedFormat, migrationCpuShare, pauseForCpuShare, processCpuMs } from "./embedding-migration.js";
import { deleteChunks, readCurrentVersion, withEmbeddingMigrationSlot, withEmbeddingSlot } from "./pipeline.js";
import { PDF_PAGE_IMAGES, canRenderPdfPages, renderPdfPages } from "./pdf.js";
import { toUnitVector } from "./vectors.js";

const CURRENT_KEY = "image_job_current";

export function imageEligible(provider: EmbeddingProvider | null | undefined, mime: string, pdfPageImages: boolean, driveId: string): boolean {
  if (getEmbeddingExcludeDrives().includes(driveId)) return false;
  return mime === "application/pdf" ? pdfPageImages : !!provider?.supportsMime?.(mime);
}

export function queueImageEmbeddings(ctx: OpContext): void {
  if (!ctx.embeddingProvider) return;
  void scheduleImageEmbeddings(ctx.db, ctx.s3, ctx.embeddingProvider, {
    cpuShare: migrationCpuShare(process.env.AGENT_FS_EMBEDDING_MIGRATION_CPU_SHARE),
    log: (msg) => console.log(msg),
  });
}

export interface ImageEmbeddingOptions {
  cpuShare?: number;
  log?: (msg: string) => void;
  batchSize?: number;
  cpuMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PendingImageEmbeddingsResult {
  indexed: number;
  failed: number;
  superseded: number;
}

/** Recover an interrupted file and queue supported files that have no image status. */
export async function prepareImageEmbeddings(
  sqlite: Database,
  provider: EmbeddingProvider
): Promise<boolean> {
  const pdfPageImages = await canRenderPdfPages(provider);
  if (storedFormat(sqlite) !== embeddingFormat(provider)) return false;
  const excludedDrives = getEmbeddingExcludeDrives();
  const current = sqlite.prepare("SELECT value FROM meta WHERE key = ?").get(CURRENT_KEY) as { value: string } | null;
  sqlite.transaction(() => {
    if (current) {
      try {
        const file = JSON.parse(current.value) as { driveId: string; path: string; version: string | null };
        sqlite.prepare(
          "UPDATE files SET image_embedding_status = ? WHERE drive_id = ? AND path = ? AND current_version_id IS ? AND is_deleted = 0"
        ).run(excludedDrives.includes(file.driveId) ? null : "failed", file.driveId, file.path, file.version);
      } catch {
        // A malformed marker must not prevent startup.
      }
      sqlite.prepare("DELETE FROM meta WHERE key = ?").run(CURRENT_KEY);
    }
    const mimes = (sqlite.prepare("SELECT DISTINCT content_type AS mime FROM files WHERE is_deleted = 0").all() as { mime: string | null }[])
      .map((row) => row.mime ?? "")
      .filter((mime) => mime === "application/pdf" ? pdfPageImages : !!provider.supportsMime?.(mime));
    if (mimes.length > 0) {
      sqlite.prepare(
        `UPDATE files SET image_embedding_status = 'pending' WHERE image_embedding_status IS NULL AND is_deleted = 0 AND content_type IN (${mimes.map(() => "?").join(",")}) AND drive_id NOT IN (SELECT value FROM json_each(?))`
      ).run(...mimes, JSON.stringify(excludedDrives));
    }
  })();
  return !!sqlite.prepare(
    "SELECT 1 FROM files WHERE image_embedding_status = 'pending' AND is_deleted = 0 AND drive_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1"
  ).get(JSON.stringify(excludedDrives));
}

export function runPendingImageEmbeddings(
  db: DB,
  s3: StorageAdapter,
  provider: EmbeddingProvider,
  opts: ImageEmbeddingOptions = {}
): Promise<PendingImageEmbeddingsResult> {
  return withEmbeddingMigrationSlot(db, async () => {
    const result: PendingImageEmbeddingsResult = { indexed: 0, failed: 0, superseded: 0 };
    if (!provider.supportsMime?.("image/png") || !provider.embedParts) return result;
    const pdfPageImages = await canRenderPdfPages(provider);
    const sqlite = (db as any).$client as Database;
    const log = opts.log ?? (() => {});
    if (storedFormat(sqlite) !== embeddingFormat(provider)) {
      log("Image embedding deferred because the provider format migration did not complete.");
      return result;
    }
    const cpuMs = opts.cpuMs ?? processCpuMs;
    const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
    const selectBatch = sqlite.prepare(
      `SELECT drives.org_id AS orgId, files.drive_id AS driveId, files.path AS path,
              files.current_version_id AS version, files.content_type AS mime
       FROM files INNER JOIN drives ON drives.id = files.drive_id
       WHERE files.image_embedding_status = 'pending' AND files.is_deleted = 0
         AND (files.drive_id, files.path) > (?, ?)
         AND files.drive_id NOT IN (SELECT value FROM json_each(?))
       ORDER BY files.drive_id, files.path LIMIT ?`
    );
    const setStatus = sqlite.prepare(
      "UPDATE files SET image_embedding_status = ? WHERE drive_id = ? AND path = ? AND current_version_id IS ? AND is_deleted = 0"
    );
    const setCurrent = sqlite.prepare(
      "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
    const clearCurrent = sqlite.prepare("DELETE FROM meta WHERE key = ?");
    const insertChunk = sqlite.prepare(
      "INSERT INTO content_chunks(file_path, drive_id, chunk_index, content, char_offset, token_count, page, kind) VALUES (?, ?, ?, '', 0, 0, ?, 'image') RETURNING id"
    );
    const insertVector = sqlite.prepare("INSERT INTO chunk_vectors(chunk_id, embedding) VALUES (?, ?)");
    let cursor = ["", ""];
    for (;;) {
      const rows = selectBatch.all(cursor[0], cursor[1], JSON.stringify(getEmbeddingExcludeDrives()), opts.batchSize ?? 50) as ImageRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        cursor = [row.driveId, row.path];
        const version = readCurrentVersion(db, row);
        if (version !== row.version) {
          result.superseded++;
          continue;
        }
        if (!imageEligible(provider, row.mime ?? "", pdfPageImages, row.driveId)) {
          setStatus.run(null, row.driveId, row.path, version);
          continue;
        }
        setCurrent.run(CURRENT_KEY, JSON.stringify({ driveId: row.driveId, path: row.path, version }));
        try {
          const { parts, vectors } = await embedImageFile(s3, provider, row, { ...opts, cpuMs, sleep });
          const replaced = sqlite.transaction(() => {
            if (readCurrentVersion(db, row) !== version) return false;
            deleteChunks(db, row, "image");
            for (let i = 0; i < parts.length; i++) {
              const chunk = insertChunk.get(row.path, row.driveId, i, parts[i].page) as { id: number };
              insertVector.run(chunk.id, vectors[i]);
            }
            setStatus.run("indexed", row.driveId, row.path, version);
            return true;
          })();
          if (replaced) result.indexed++;
          else result.superseded++;
        } catch (err) {
          if (err instanceof EmbeddingInitializationError) throw err;
          if (readCurrentVersion(db, row) === version) {
            setStatus.run("failed", row.driveId, row.path, version);
            result.failed++;
          } else {
            result.superseded++;
          }
          log(`image embedding failed for ${row.path}: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          clearCurrent.run(CURRENT_KEY);
        }
      }
      log(`image embedding: ${result.indexed} embedded, ${result.failed} failed, ${result.superseded} superseded`);
    }
    return result;
  });
}

type ImageRow = { orgId: string; driveId: string; path: string; version: string | null; mime: string | null };

async function embedImageFile(
  s3: StorageAdapter,
  provider: EmbeddingProvider,
  row: ImageRow,
  opts: ImageEmbeddingOptions & { cpuMs: () => number; sleep: (ms: number) => Promise<void> }
): Promise<{ parts: { page: number | null; data: Uint8Array }[]; vectors: Float32Array[] }> {
  const mime = row.mime ?? "";
  const object = await s3.getObject(getS3Key(row.orgId, row.driveId, row.path));
  const parts = mime === "application/pdf"
    ? await renderPdfPages(object.body, PDF_PAGE_IMAGES)
    : [{ page: null, data: object.body }];
  const vectors: Float32Array[] = [];
  for (const part of parts) {
    const cpuStart = opts.cpuMs();
    try {
      const embedded = await withEmbeddingSlot(() => provider.embedParts!([
        { mime: mime === "application/pdf" ? "image/png" : mime, data: part.data },
      ]));
      if (embedded.length !== 1) throw new Error(`Embedding provider returned ${embedded.length} vectors for one image`);
      vectors.push(toUnitVector(embedded[0], provider.dimensions));
    } finally {
      const pauseMs = pauseForCpuShare(opts.cpuMs() - cpuStart, opts.cpuShare ?? DEFAULT_CPU_SHARE);
      if (pauseMs >= 1) await opts.sleep(pauseMs);
    }
  }
  return { parts, vectors };
}

const scheduledRuns = new WeakMap<DB, { running: Promise<void>; rerun: boolean }>();

/** Start one image job. A concurrent request causes another scan after the current scan. */
export function scheduleImageEmbeddings(
  db: DB,
  s3: StorageAdapter,
  provider: EmbeddingProvider,
  opts: ImageEmbeddingOptions = {}
): Promise<void> {
  if (!provider.supportsMime?.("image/png") || !provider.embedParts) return Promise.resolve();
  const active = scheduledRuns.get(db);
  if (active) {
    active.rerun = true;
    return active.running;
  }
  const state = { running: Promise.resolve(), rerun: false };
  state.running = (async () => {
    try {
      do {
        state.rerun = false;
        await runPendingImageEmbeddings(db, s3, provider, opts);
      } while (state.rerun);
    } catch (err) {
      (opts.log ?? console.error)(`image embedding job stopped: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Delete before this async function settles. A later request must start a new run.
      scheduledRuns.delete(db);
    }
  })();
  scheduledRuns.set(db, state);
  return state.running;
}
