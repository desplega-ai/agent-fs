const MIME_MAP: Record<string, string> = {
  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  ico: "image/x-icon",
  // Documents
  pdf: "application/pdf",
  // Text/code
  txt: "text/plain",
  md: "text/markdown",
  mdx: "text/markdown",
  html: "text/html",
  css: "text/css",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  xml: "application/xml",
  json: "application/json",
  jsonl: "application/x-ndjson",
  ndjson: "application/x-ndjson",
  yaml: "application/x-yaml",
  yml: "application/x-yaml",
  toml: "application/toml",
  // Code (all text/plain — correct for S3 delivery)
  ts: "text/plain",
  tsx: "text/plain",
  js: "text/javascript",
  jsx: "text/javascript",
  py: "text/x-python",
  rb: "text/x-ruby",
  rs: "text/x-rust",
  go: "text/x-go",
  java: "text/x-java",
  c: "text/x-c",
  cpp: "text/x-c++",
  h: "text/x-c",
  hpp: "text/x-c++",
  sh: "text/x-shellscript",
  sql: "text/x-sql",
  graphql: "text/x-graphql",
  // Data files
  parquet: "application/vnd.apache.parquet",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  db: "application/vnd.sqlite3",
  sqlite: "application/vnd.sqlite3",
  sqlite3: "application/vnd.sqlite3",
  // Archives
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
};

export function detectMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_MAP[ext] ?? "application/octet-stream";
}

export function isIndexableMimeType(contentType: string): boolean {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/x-ndjson" ||
    normalized === "application/xml" ||
    normalized === "application/x-yaml" ||
    normalized === "application/toml" ||
    normalized === "image/svg+xml"
  );
}

export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function decodeIndexableText(
  bytes: Uint8Array,
  contentType: string
): string | null {
  const decoded = decodeUtf8Strict(bytes);
  if (decoded === null) return null;

  if (isIndexableMimeType(contentType)) return decoded;

  // Unknown extension/content-type: index it only when it is plainly text.
  if (contentType === "application/octet-stream" && looksLikeTextBytes(bytes)) {
    return decoded;
  }

  return null;
}

function looksLikeTextBytes(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;

  let suspicious = 0;
  for (const byte of bytes) {
    if (byte === 0) return false;
    const allowedControl = byte === 9 || byte === 10 || byte === 12 || byte === 13;
    if (byte < 32 && !allowedControl) suspicious++;
  }

  return suspicious / bytes.length < 0.01;
}
