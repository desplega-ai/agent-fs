import { describe, test, expect, afterEach } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { writeAllSync } from "../stdio.js";

/**
 * `writeAllSync` is the byte-exact writer behind `stdio.writeStdoutRaw`
 * (used by `cat --raw` / non-TTY `cat`). PR #27 review found that the
 * *other* wrapper, `stdio.writeStdout`, synthesizes a trailing "\n" when
 * absent — fine for human/log output, wrong for a raw byte-for-byte read.
 * These tests drive `writeAllSync` directly against a real fd (a temp
 * file, not the process's stdout) so the assertions are exact byte counts,
 * not process-output-capture heuristics.
 */
describe("writeAllSync (raw byte-exact writer)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  function tempFile(): { path: string; fd: number } {
    const dir = mkdtempSync(join(tmpdir(), "agent-fs-stdio-test-"));
    dirs.push(dir);
    const path = join(dir, "out.bin");
    const fd = openSync(path, "w");
    return { path, fd };
  }

  test("content with no trailing newline is written byte-for-byte (no newline synthesized)", () => {
    const { path, fd } = tempFile();
    const data = "1,field-1\n2,field-2";
    writeAllSync(fd, data);
    closeSync(fd);
    const written = readFileSync(path);
    expect(written.length).toBe(Buffer.byteLength(data, "utf-8"));
    expect(written.toString("utf-8")).toBe(data);
    expect(statSync(path).size).toBe(Buffer.byteLength(data, "utf-8"));
  });

  test("empty content writes exactly 0 bytes", () => {
    const { path, fd } = tempFile();
    writeAllSync(fd, "");
    closeSync(fd);
    expect(statSync(path).size).toBe(0);
  });

  test("content already ending in a single newline does not gain a second one", () => {
    const { path, fd } = tempFile();
    const data = "a,b,c\n";
    writeAllSync(fd, data);
    closeSync(fd);
    const written = readFileSync(path, "utf-8");
    expect(written).toBe(data);
    expect(written.endsWith("\n\n")).toBe(false);
  });

  test("a payload larger than the OS pipe buffer (64KB) is still byte-exact", () => {
    const { path, fd } = tempFile();
    const line = "1,field-1-a,field-1-b,field-1-c\n";
    const data = line.repeat(3000); // well over 65536 bytes
    expect(Buffer.byteLength(data, "utf-8")).toBeGreaterThan(65536);
    writeAllSync(fd, data);
    closeSync(fd);
    expect(statSync(path).size).toBe(Buffer.byteLength(data, "utf-8"));
    expect(readFileSync(path, "utf-8")).toBe(data);
  });
});
