import type { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

/**
 * Runs the vector KNN query on a worker thread with its own read-only
 * connection. sqlite-vec scans every stored vector, which takes hundreds of
 * milliseconds on a large index, and tens of seconds for the first scan after
 * a restart, while the table is read from disk. On the main thread that
 * blocked every request, health checks included.
 *
 * The worker also runs one scan right after it opens, so the first real
 * search finds the vectors in the OS page cache.
 *
 * Without a started worker (tests, in-memory databases), `runKnn` runs the
 * query inline on the caller's connection.
 */

export type ChunkHit = { chunk_id: number; distance: number };

export interface KnnParams {
  query: Float32Array;
  driveId: string;
  excludedPaths: string[];
  k: number;
}

const KNN_SQL = `SELECT chunk_id, distance
FROM chunk_vectors
WHERE embedding MATCH ?
  AND chunk_id IN (
    SELECT chunks.id
    FROM content_chunks AS chunks
    INNER JOIN files
      ON files.drive_id = chunks.drive_id
     AND files.path = chunks.file_path
    WHERE chunks.drive_id = ?
      AND files.is_deleted = 0
      AND chunks.file_path NOT IN (
        SELECT value FROM json_each(?)
      )
  )
ORDER BY distance
LIMIT ?`;

// The worker is plain JavaScript in a string so it survives bundling into the
// single-file CLI: it only needs bun:sqlite and the extension path.
const WORKER_SOURCE = `
import { Database } from "bun:sqlite";
let knn;
self.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === "open") {
    try {
      const db = new Database(msg.dbPath, { readonly: true });
      db.loadExtension(msg.extensionPath);
      db.exec("PRAGMA busy_timeout = 5000");
      knn = db.prepare(msg.sql);
      // Warm the page cache: one full scan with a throwaway query.
      db.prepare("SELECT count(*) FROM (SELECT chunk_id FROM chunk_vectors WHERE embedding MATCH ? AND k = 1)")
        .get(new Float32Array(msg.dimensions));
      postMessage({ type: "ready" });
    } catch (err) {
      postMessage({ type: "failed", error: String(err && err.message || err) });
    }
    return;
  }
  try {
    const rows = knn.all(msg.query, msg.driveId, msg.excluded, msg.k);
    postMessage({ id: msg.id, rows });
  } catch (err) {
    postMessage({ id: msg.id, error: String(err && err.message || err) });
  }
};
`;

type Pending = { resolve: (rows: ChunkHit[]) => void; reject: (err: Error) => void };

interface VectorWorker {
  worker: Worker;
  pending: Map<number, Pending>;
  nextId: number;
  broken: boolean;
}

const workers = new WeakMap<Database, VectorWorker>();

/** Starts the KNN worker for `sqlite`, the connection the server opened on `dbPath`. */
export function startVectorSearchWorker(
  sqlite: Database,
  dbPath: string,
  opts: { dimensions?: number; log?: (msg: string) => void } = {}
): void {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "application/javascript" }));
  const state: VectorWorker = { worker: new Worker(url), pending: new Map(), nextId: 1, broken: false };
  const fail = (reason: string) => {
    if (state.broken) return;
    state.broken = true;
    log(`vector search worker stopped (${reason}); searches run on the main thread`);
    for (const p of state.pending.values()) p.reject(new Error(`vector search worker stopped: ${reason}`));
    state.pending.clear();
    state.worker.terminate();
  };

  state.worker.onmessage = (event: MessageEvent) => {
    const msg = event.data;
    if (msg.type === "ready") return;
    if (msg.type === "failed") return fail(msg.error);
    const pending = state.pending.get(msg.id);
    if (!pending) return;
    state.pending.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error));
    else pending.resolve(msg.rows);
  };
  state.worker.onerror = (event: ErrorEvent) => fail(event.message || "error");
  // Do not keep the process alive for the worker alone.
  (state.worker as Worker & { unref(): void }).unref();

  state.worker.postMessage({
    type: "open",
    dbPath,
    extensionPath: sqliteVec.getLoadablePath(),
    sql: KNN_SQL,
    dimensions: opts.dimensions ?? 768,
  });
  workers.set(sqlite, state);
}

/** The KNN step of vector search: on the worker when one runs for `sqlite`, else inline. */
export function runKnn(sqlite: Database, params: KnnParams): Promise<ChunkHit[]> {
  const excluded = JSON.stringify(params.excludedPaths);
  const state = workers.get(sqlite);
  if (!state || state.broken) {
    return Promise.resolve(
      sqlite.prepare(KNN_SQL).all(params.query, params.driveId, excluded, params.k) as ChunkHit[]
    );
  }
  const id = state.nextId++;
  return new Promise<ChunkHit[]>((resolve, reject) => {
    state.pending.set(id, { resolve, reject });
    state.worker.postMessage({ id, query: params.query, driveId: params.driveId, excluded, k: params.k });
  });
}

/** Stops the worker for `sqlite` (tests). */
export function stopVectorSearchWorker(sqlite: Database): void {
  const state = workers.get(sqlite);
  if (!state) return;
  state.broken = true;
  state.worker.terminate();
  workers.delete(sqlite);
}
