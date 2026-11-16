import { StorageUnavailableError } from "../errors.js";

/** Ops that write to storage: they answer on time and may finish later. */
export const STORAGE_WRITE_OPS = new Set(["write", "edit", "append", "revert", "rm", "mv", "cp"]);

let deadlineMs = 15_000;

/** Test hook: shorten the deadline. */
export function setWriteDeadlineMsForTests(ms: number): void {
  deadlineMs = ms;
}

/**
 * Answer a storage write within the deadline (plus 1 s per MiB of body), and
 * let the op itself run to its end. The write is not cancelled: a storage
 * request cut off mid-flight can still land later, after a newer write, so
 * the op keeps its path lock and records what storage did. The caller gets a
 * retryable 503 that says the change may still be applied.
 */
export function answerWithin<T>(work: Promise<T>, bodyBytes = 0): Promise<T> {
  const ms = deadlineMs + Math.floor(bodyBytes / (1024 * 1024)) * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new StorageUnavailableError(`Storage did not answer within ${Math.round(ms / 1000)} s; the change may still be applied`)),
      ms
    );
  });
  work.catch(() => {}); // a late failure after the 503 has nobody left to tell
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
