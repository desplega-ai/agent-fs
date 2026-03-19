import { describe, it, expect } from "bun:test";
import { detectMimeType } from "../mime.js";

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
    expect(detectMimeType("data.parquet")).toBe("application/octet-stream");
    expect(detectMimeType("model.onnx")).toBe("application/octet-stream");
    expect(detectMimeType("file.xyz")).toBe("application/octet-stream");
  });

  // Empty/edge cases
  it("handles edge cases", () => {
    expect(detectMimeType("")).toBe("application/octet-stream");
    expect(detectMimeType(".")).toBe("application/octet-stream");
    expect(detectMimeType("..")).toBe("application/octet-stream");
  });
});
