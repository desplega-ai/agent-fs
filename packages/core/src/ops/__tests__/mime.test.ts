import { describe, it, expect } from "bun:test";
import { copiedMimeType, detectMimeType, withUtf8Charset } from "../mime.js";

describe("detectMimeType", () => {
  // Standard extensions
  it("detects common types", () => {
    expect(detectMimeType("photo.png")).toBe("image/png");
    expect(detectMimeType("doc.pdf")).toBe("application/pdf");
    expect(detectMimeType("readme.md")).toBe("text/markdown");
    expect(detectMimeType("app.ts")).toBe("text/plain");
    expect(detectMimeType("style.css")).toBe("text/css");
  });

  // Case insensitivity
  it("handles uppercase extensions", () => {
    expect(detectMimeType("PHOTO.PNG")).toBe("image/png");
    expect(detectMimeType("doc.PDF")).toBe("application/pdf");
    expect(detectMimeType("README.MD")).toBe("text/markdown");
  });

  // No extension
  it("returns octet-stream for no extension", () => {
    expect(detectMimeType("Makefile")).toBe("application/octet-stream");
    expect(detectMimeType("LICENSE")).toBe("application/octet-stream");
    expect(detectMimeType("Dockerfile")).toBe("application/octet-stream");
  });

  // Dotfiles
  it("handles dotfiles", () => {
    expect(detectMimeType(".gitignore")).toBe("application/octet-stream");
    expect(detectMimeType(".env")).toBe("application/octet-stream");
    expect(detectMimeType(".bashrc")).toBe("application/octet-stream");
  });

  // Multiple dots
  it("uses last extension for multi-dot filenames", () => {
    expect(detectMimeType("archive.tar.gz")).toBe("application/gzip");
    expect(detectMimeType("my.component.tsx")).toBe("text/plain");
    expect(detectMimeType("config.prod.json")).toBe("application/json");
  });

  // Paths with directories
  it("works with full paths", () => {
    expect(detectMimeType("src/components/Button.tsx")).toBe("text/plain");
    expect(detectMimeType("/docs/guide.pdf")).toBe("application/pdf");
    expect(detectMimeType("assets/logo.svg")).toBe("image/svg+xml");
  });

  // Unknown extensions
  it("returns octet-stream for unknown extensions", () => {
    expect(detectMimeType("model.onnx")).toBe("application/octet-stream");
    expect(detectMimeType("file.xyz")).toBe("application/octet-stream");
  });

  it("detects data file types", () => {
    expect(detectMimeType("data.parquet")).toBe("application/vnd.apache.parquet");
    expect(detectMimeType("data.tsv")).toBe("text/tab-separated-values");
    expect(detectMimeType("app.db")).toBe("application/vnd.sqlite3");
    expect(detectMimeType("rows.ndjson")).toBe("application/x-ndjson");
  });

  // Empty/edge cases
  it("handles edge cases", () => {
    expect(detectMimeType("")).toBe("application/octet-stream");
    expect(detectMimeType(".")).toBe("application/octet-stream");
    expect(detectMimeType("..")).toBe("application/octet-stream");
  });
});

describe("withUtf8Charset", () => {
  it("appends charset to text-family types", () => {
    expect(withUtf8Charset("text/markdown")).toBe("text/markdown; charset=utf-8");
    expect(withUtf8Charset("application/json")).toBe("application/json; charset=utf-8");
    expect(withUtf8Charset("image/svg+xml")).toBe("image/svg+xml; charset=utf-8");
  });

  it("leaves binary types unchanged", () => {
    expect(withUtf8Charset("image/png")).toBe("image/png");
    expect(withUtf8Charset("application/octet-stream")).toBe("application/octet-stream");
    expect(withUtf8Charset("application/pdf")).toBe("application/pdf");
  });

  it("does not double-append when a charset is already present", () => {
    expect(withUtf8Charset("text/plain; charset=utf-8")).toBe("text/plain; charset=utf-8");
    expect(withUtf8Charset("text/plain;charset=UTF-8")).toBe("text/plain;charset=UTF-8");
  });

  it("keeps non-charset MIME parameters", () => {
    expect(withUtf8Charset("text/plain; format=flowed")).toBe("text/plain; format=flowed; charset=utf-8");
  });
});

describe("copiedMimeType", () => {
  it("keeps the source type", () => {
    expect(copiedMimeType("application/pdf", "/moved.txt")).toBe("application/pdf");
    expect(copiedMimeType("text/html", "/b.html")).toBe("text/html");
    expect(copiedMimeType("image/svg+xml", "/b.svg")).toBe("image/svg+xml");
  });

  it("types markup by the destination when its extension does not imply it", () => {
    expect(copiedMimeType("text/html", "/a.pdf")).toBe("application/pdf");
    expect(copiedMimeType("image/svg+xml", "/a.png")).toBe("image/png");
    expect(copiedMimeType("Text/HTML; charset=utf-8", "/a")).toBe("application/octet-stream");
    expect(copiedMimeType("application/xml", "/a.txt")).toBe("text/plain");
  });

  it("falls back to the destination type", () => {
    expect(copiedMimeType(undefined, "/a.pdf")).toBe("application/pdf");
  });
});
