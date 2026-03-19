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
  xml: "application/xml",
  json: "application/json",
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
  // Archives
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
};

export function detectMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_MAP[ext] ?? "application/octet-stream";
}
