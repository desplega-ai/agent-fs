import { writeSync } from "node:fs";

/**
 * Write every byte of `data` to `fd`, retrying on EAGAIN until the whole
 * buffer is flushed.
 *
 * Root cause this works around (verified empirically, see PR description):
 * `console.log`/`process.stdout.write` queue writes asynchronously when
 * stdout is a non-TTY pipe. Under backpressure — a payload larger than the
 * OS pipe buffer (65536 bytes on Linux) — Bun's runtime can treat the event
 * loop as idle and exit before the queued write finishes flushing, silently
 * dropping the unwritten remainder. Piping a >64KB `cat` result through
 * `wc -c` reproduced this on every run (always cut to exactly 65536 or
 * 65537 bytes, regardless of `--limit`), while redirecting the same command
 * to a file — always a synchronous write — returned the full byte count
 * every time. A raw `writeSync` retry loop on the fd bypasses the async
 * stream path entirely and blocks until every byte is on the pipe.
 *
 * Exported (in addition to being used internally by `stdio`) so unit tests
 * can verify byte-exactness directly against a real fd (e.g. a temp file)
 * without touching the process's actual stdout/stderr.
 */
export function writeAllSync(fd: number, data: string): void {
  if (data.length === 0) return;
  const buf = Buffer.from(data, "utf-8");
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += writeSync(fd, buf, offset, buf.length - offset);
    } catch (err: any) {
      if (err?.code === "EAGAIN") continue;
      throw err;
    }
  }
}

// Exposed as a mutable object (rather than plain exported functions) so
// tests can substitute the writers without touching the real fds.
export const stdio = {
  writeStdout(data: string): void {
    writeAllSync(1, data.endsWith("\n") ? data : data + "\n");
  },
  writeStderr(data: string): void {
    writeAllSync(2, data.endsWith("\n") ? data : data + "\n");
  },
  // For raw/programmatic consumers (`cat --raw`, non-TTY `cat`): the stored
  // bytes, exactly as stored — no synthesized trailing newline, so `wc -c`
  // and hashes over the piped output match `stat.size` exactly (see PR #27
  // review: writeStdout's newline synthesis made an empty file emit "\n"
  // and a file with no trailing newline emit one extra byte).
  writeStdoutRaw(data: string): void {
    writeAllSync(1, data);
  },
};
