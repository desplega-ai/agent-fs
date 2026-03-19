---
date: 2026-03-19T18:00:00Z
topic: "Signed URLs in FE & MIME Type Fixes"
status: done
autonomy: critical-questions
---

# Signed URLs in FE & MIME Type Fixes

## Summary

Two related fixes to make binary file loading (PDFs, images) work properly in the live app:

1. **Fix MIME types on upload** — detect content type from file extension and pass it to S3 + store in DB
2. **Use signed URLs in FE for ALL file types** — replace `fetchRaw` blob proxy with presigned S3 URLs across all viewers (text, images, PDFs), with correct `ResponseContentType` overrides. One homogeneous approach.

### Root Cause

`putObject` in `packages/core/src/s3/client.ts:76` never sets `ContentType` on the `PutObjectCommand`. Everything gets stored as `application/octet-stream`. The FE's `PdfViewer` creates a blob URL from this — browsers refuse to render `application/octet-stream` as PDF in an iframe.

---

## Phase 1: MIME Type Detection Utility

**Goal:** Create a lightweight MIME type lookup from file extension. No external dependencies.

### Changes

#### 1.1 Create `packages/core/src/ops/mime.ts`

Simple extension→MIME map covering common file types:

```typescript
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
```

#### 1.2 Unit tests for `detectMimeType` (`packages/core/src/ops/__tests__/mime.test.ts`)

Edge case coverage:

```typescript
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
```

### Verification

```bash
bun run typecheck
bun test packages/core/src/ops/__tests__/mime.test.ts
```

---

## Phase 2: Fix Upload MIME Types

**Goal:** All S3 writes set `ContentType` correctly. Store it in the DB.

### Changes

#### 2.1 Add `contentType` parameter to `putObject` (`packages/core/src/s3/client.ts`)

Update the `putObject` method to accept and pass `ContentType`:

```typescript
async putObject(
  key: string,
  body: string | Uint8Array,
  metadata?: Record<string, string>,
  contentType?: string,
): Promise<PutObjectResult> {
  const result = await this.client.send(
    new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: typeof body === "string" ? Buffer.from(body) : body,
      Metadata: metadata,
      ...(contentType && { ContentType: contentType }),
    })
  );
  // ...
}
```

#### 2.2 Update `write` op to detect and pass MIME type (`packages/core/src/ops/write.ts`)

```typescript
import { detectMimeType } from "./mime.js";

// In write():
const contentType = detectMimeType(params.path);
const s3Result = await ctx.s3.putObject(s3Key, content, undefined, contentType);
```

#### 2.3 Update `edit` op (`packages/core/src/ops/edit.ts`)

Same pattern — after reading + modifying content, re-upload with correct MIME:

```typescript
import { detectMimeType } from "./mime.js";

// When writing back:
const contentType = detectMimeType(params.path);
await ctx.s3.putObject(s3Key, newContent, undefined, contentType);
```

#### 2.4 Update `append` op (`packages/core/src/ops/append.ts`)

Same pattern:

```typescript
import { detectMimeType } from "./mime.js";

const contentType = detectMimeType(params.path);
const s3Result = await ctx.s3.putObject(s3Key, newContent, undefined, contentType);
```

#### 2.5 Update `cp` op (`packages/core/src/ops/cp.ts`)

`cp` uses `s3.copyObject` which preserves the source object's metadata. Since `copyObject` doesn't let us override ContentType easily (it copies source metadata), and the source might already have `application/octet-stream`, we should check if `copyObject` needs a `MetadataDirective: "REPLACE"` + explicit ContentType.

However, this is a deeper change. For now, **skip `cp`** — the copy will inherit whatever the source has. If the source was uploaded after this fix, it'll be correct.

#### 2.6 Update `revert` op (`packages/core/src/ops/revert.ts`)

`revert` reads old content and writes it back. Should set MIME type on the re-write:

```typescript
import { detectMimeType } from "./mime.js";

const contentType = detectMimeType(params.path);
await ctx.s3.putObject(s3Key, oldContent, undefined, contentType);
```

#### 2.7 Update `createVersion` to store contentType in DB (`packages/core/src/ops/versioning.ts`)

Add `contentType` to the params and set it on the files table:

```typescript
export async function createVersion(
  ctx: OpContext,
  params: {
    path: string;
    s3VersionId: string;
    operation: "write" | "edit" | "append" | "delete" | "revert";
    message?: string;
    diffSummary?: string;
    size?: number;
    etag?: string;
    contentType?: string; // NEW
  }
): Promise<number> {
  // ... existing code ...

  // In the upsert — add contentType to the update/insert:
  if (existing) {
    ctx.db.update(schema.files).set({
      size: params.size ?? existing.size,
      contentType: params.contentType ?? existing.contentType, // NEW
      author: ctx.userId,
      // ...
    })
  } else {
    ctx.db.insert(schema.files).values({
      // ...existing fields...
      contentType: params.contentType ?? null, // NEW
    })
  }
}
```

Then update all callers (`write`, `edit`, `append`, `revert`) to pass `contentType: detectMimeType(params.path)` to `createVersion`.

### Verification

```bash
bun run typecheck
bun run test

# Manual check: write a file, then verify S3 content type
bun run packages/cli/src/index.ts -- write /test.pdf --content "fake pdf"
bun run packages/cli/src/index.ts -- stat /test.pdf
# contentType should be "application/pdf"
```

---

## Phase 3: Fix Presigned URLs Content-Type

**Goal:** Presigned URLs serve files with the correct `Content-Type` header, even for files uploaded before the MIME fix.

### Changes

#### 3.1 Update `getPresignedUrl` to accept `responseContentType` (`packages/core/src/s3/client.ts`)

```typescript
async getPresignedUrl(
  key: string,
  expiresIn: number = 86400,
  responseContentType?: string,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: this.bucket,
    Key: key,
    ...(responseContentType && { ResponseContentType: responseContentType }),
  });
  return getSignedUrl(this.client as any, command, { expiresIn });
}
```

`ResponseContentType` overrides the `Content-Type` header in the S3 response — this works even for objects stored with wrong content types.

#### 3.2 Update `signedUrl` op to detect and pass MIME type (`packages/core/src/ops/signed-url.ts`)

```typescript
import { detectMimeType } from "./mime.js";

export async function signedUrl(
  ctx: OpContext,
  params: SignedUrlParams
): Promise<SignedUrlResult> {
  const normalizedPath = normalizePath(params.path);
  const key = getS3Key(ctx.orgId, ctx.driveId, normalizedPath);
  const expiresIn = params.expiresIn ?? 86400;
  const contentType = detectMimeType(normalizedPath);

  // Verify file exists
  // ... existing check ...

  const url = await ctx.s3.getPresignedUrl(
    key,
    expiresIn,
    contentType !== "application/octet-stream" ? contentType : undefined,
  );

  return {
    url,
    path: normalizedPath,
    expiresIn,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}
```

Only override when we can detect a specific type — for unknown extensions, let S3's stored type pass through.

### Verification

```bash
bun run typecheck
bun run test

# Manual: get a signed URL for a PDF and check headers
bun run packages/cli/src/index.ts -- signed-url /test.pdf
curl -I "<url>"
# Content-Type should be application/pdf
```

---

## Phase 4: FE — Use Signed URLs for ALL File Types

**Goal:** Homogenize all file loading in the FE to use presigned S3 URLs. Replace both `fetchRaw` (binary viewers) and `useFileContent`/`cat` op (text viewers) with a single signed URL approach. This is simpler, more efficient (direct S3 download), and correctly serves content types.

**How the UI handles MIME type / viewer discrimination:** The `FileViewer` component (`live/src/components/viewers/FileViewer.tsx`) decides which viewer to render based purely on **file extension** — not on the content type from S3 or the server. The functions `isImage()`, `isPdf()`, `isMarkdown()`, and `isTextFile()` all check the extension of the path. The signed URL approach doesn't change this — viewer selection remains extension-based, only the *data loading mechanism* changes.

### Changes

#### 4.1 Add `getSignedUrl` method to FE API client (`live/src/api/client.ts`)

```typescript
async getSignedUrl(orgId: string, driveId: string, path: string): Promise<{ url: string; expiresAt: string }> {
  return this.callOp<{ url: string; expiresAt: string }>(
    orgId,
    "signed-url",
    { path },
    driveId,
  );
}
```

#### 4.2 Create `useSignedUrl` hook (`live/src/hooks/use-signed-url.ts`)

```typescript
import { useState, useEffect } from "react"
import { useAuth } from "@/contexts/auth"

export function useSignedUrl(path: string | null) {
  const { client, orgId, driveId } = useAuth()
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!path || !orgId) {
      setUrl(null)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)

    client.getSignedUrl(orgId, driveId, path).then((result) => {
      if (!cancelled) {
        setUrl(result.url)
        setIsLoading(false)
      }
    }).catch((err) => {
      if (!cancelled) {
        setError((err as Error).message)
        setIsLoading(false)
      }
    })

    return () => { cancelled = true }
  }, [path, orgId, driveId, client])

  return { url, error, isLoading }
}
```

#### 4.3 Update `ImageViewer` (`live/src/components/viewers/ImageViewer.tsx`)

Replace the `fetchRaw` + `createObjectURL` approach with `useSignedUrl`:

```typescript
import { useSignedUrl } from "@/hooks/use-signed-url"

export function ImageViewer({ path, className }: ImageViewerProps) {
  const { url, error, isLoading } = useSignedUrl(path)

  if (error) { /* error state */ }
  if (isLoading || !url) { /* loading spinner */ }

  return (
    <div className={cn("flex items-center justify-center overflow-auto p-8", className)}>
      <img src={url} alt={path} className="max-w-full max-h-full object-contain rounded-md" />
    </div>
  )
}
```

No more blob URLs, no more `URL.revokeObjectURL` cleanup, no more `useEffect` with async fetch.

#### 4.4 Update `PdfViewer` (`live/src/components/viewers/PdfViewer.tsx`)

Same pattern:

```typescript
import { useSignedUrl } from "@/hooks/use-signed-url"

export function PdfViewer({ path, className }: PdfViewerProps) {
  const { url, error, isLoading } = useSignedUrl(path)

  if (error) { /* error state */ }
  if (isLoading || !url) { /* loading spinner */ }

  return (
    <iframe src={url} title={path} className={cn("w-full h-full border-0", className)} />
  )
}
```

The iframe gets a presigned URL with `ResponseContentType: application/pdf` — the browser will render it natively.

#### 4.5 Update `useFileContent` to use signed URLs (`live/src/hooks/use-file-content.ts`)

Currently `useFileContent` calls the `cat` op (which returns `{ content, totalLines, truncated }`). Replace with a signed-URL-based fetch:

```typescript
import { useState, useEffect } from "react"
import { useAuth } from "@/contexts/auth"

export function useFileContent(path: string | null) {
  const { client, orgId, driveId } = useAuth()
  const [data, setData] = useState<{ content: string; totalLines: number; truncated: boolean } | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!path || !orgId) {
      setData(null)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)

    client.getSignedUrl(orgId, driveId, path).then(async (result) => {
      const res = await fetch(result.url)
      if (!res.ok) throw new Error(`Failed to fetch: ${res.statusText}`)
      const text = await res.text()
      if (!cancelled) {
        const lines = text.split("\n")
        setData({ content: text, totalLines: lines.length, truncated: false })
        setIsLoading(false)
      }
    }).catch((err) => {
      if (!cancelled) {
        setError((err as Error).message)
        setIsLoading(false)
      }
    })

    return () => { cancelled = true }
  }, [path, orgId, driveId, client])

  return { data, isLoading, error }
}
```

**Trade-off:** The `cat` op supported offset/limit pagination for large files. With signed URLs we fetch the full file. For the current 10MB file limit this is acceptable. If large file pagination is needed later, keep `cat` as a fallback for files above a threshold.

**Alternative — keep `cat` for text, signed URL for binary:** If we want to preserve truncation behavior for very large text files, we could keep the existing `useFileContent` for text viewers and only use `useSignedUrl` for binary viewers. But for homogeneity, the signed URL approach is cleaner. The `TextViewer` already handles raw content strings — we just need to feed it the full content.

#### 4.6 Consider CORS for presigned URLs

Presigned URLs point directly to S3/MinIO, which is a different origin from the live app. The S3 bucket needs CORS configuration to allow requests from the live app's origin.

**For MinIO (local dev):** MinIO allows all origins by default, so this should work out of the box.

**For production S3:** Need to ensure the bucket has a CORS policy allowing the live app origin. This is likely already configured since the `/files/*/raw` route exists — but if not, add it to the S3 bucket config.

**Key point:** For `<img>` and `<iframe>` tags, the browser doesn't enforce CORS — it only enforces it for `fetch`/`XMLHttpRequest`. So `<img src="presigned-url">` and `<iframe src="presigned-url">` will work without CORS configuration. CORS only matters if we later want to fetch file content via JS (e.g., for canvas manipulation).

### Verification

```bash
cd live && pnpm build  # should compile

# Manual checks:
# 1. Upload an image: agent-fs write /test.png --content "..." (or via S3 directly)
# 2. Navigate to image in live app — should render in ImageViewer
# 3. Upload a PDF: agent-fs write /test.pdf --content "..."
# 4. Navigate to PDF in live app — should render in iframe
# 5. Check browser Network tab — requests go to S3/MinIO presigned URL, not /files/*/raw
```

---

## Phase 5: Version Bump & E2E

### Changes

#### 5.1 Bump version in root `package.json`

Patch bump.

#### 5.2 Add E2E test for MIME type verification

Add to `scripts/e2e.ts`:

```typescript
// Test: write a .pdf file, stat it, verify contentType is "application/pdf"
// Test: signed-url for .pdf returns correct Content-Type header
// Test: signed-url for .png returns correct Content-Type header
```

### Verification

```bash
bun run typecheck
bun run test
bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"
```

---

## Manual E2E

```bash
# Start daemon + live app:
bun run packages/cli/src/index.ts -- daemon start
cd live && pnpm dev

# 1. Write a text file and verify MIME type in stat:
bun run packages/cli/src/index.ts -- write /hello.md --content "# Hello"
bun run packages/cli/src/index.ts -- stat /hello.md
# Expected: contentType = "text/markdown"

# 2. Write a test HTML file (simulating image upload):
bun run packages/cli/src/index.ts -- write /test.html --content "<h1>test</h1>"
bun run packages/cli/src/index.ts -- stat /test.html
# Expected: contentType = "text/html"

# 3. Get signed URL and verify Content-Type header:
bun run packages/cli/src/index.ts -- signed-url /hello.md
curl -I "<url>"
# Expected: Content-Type: text/markdown

# 4. In live app: navigate to a file → verify it loads via signed URL (check Network tab)
# 5. In live app: navigate to a PDF → verify iframe renders correctly
```

---

## Dependency Summary

No new dependencies required. `@aws-sdk/s3-request-presigner` was already added in the previous plan.

## Files Modified

| File | Phase | Change |
|------|-------|--------|
| `packages/core/src/ops/mime.ts` | 1 | **New** — MIME type detection utility |
| `packages/core/src/ops/__tests__/mime.test.ts` | 1 | **New** — Edge case unit tests for detectMimeType |
| `packages/core/src/s3/client.ts` | 2, 3 | Add `contentType` param to `putObject`, `responseContentType` to `getPresignedUrl` |
| `packages/core/src/ops/write.ts` | 2 | Detect + pass MIME type to S3 and DB |
| `packages/core/src/ops/edit.ts` | 2 | Detect + pass MIME type to S3 |
| `packages/core/src/ops/append.ts` | 2 | Detect + pass MIME type to S3 |
| `packages/core/src/ops/revert.ts` | 2 | Detect + pass MIME type to S3 |
| `packages/core/src/ops/versioning.ts` | 2 | Accept + store `contentType` in DB |
| `packages/core/src/ops/signed-url.ts` | 3 | Detect MIME + pass `ResponseContentType` |
| `live/src/api/client.ts` | 4 | Add `getSignedUrl` method |
| `live/src/hooks/use-signed-url.ts` | 4 | **New** — hook for signed URL fetching |
| `live/src/hooks/use-file-content.ts` | 4 | Replace `cat` op with signed URL fetch |
| `live/src/components/viewers/ImageViewer.tsx` | 4 | Use `useSignedUrl` instead of `fetchRaw` |
| `live/src/components/viewers/PdfViewer.tsx` | 4 | Use `useSignedUrl` instead of `fetchRaw` |
| `package.json` | 5 | Version bump |
| `scripts/e2e.ts` | 5 | Add MIME type verification tests |

## Out of Scope

- **Binary upload support**: The `write` op only accepts `content: string`. Uploading actual binary files (real PDFs, images) requires a separate upload endpoint with multipart/form-data. This is a separate feature.
- **Fixing existing files**: Files already in S3 with `application/octet-stream` won't be retroactively fixed. The `ResponseContentType` override on presigned URLs handles this gracefully.
- **`cp` MIME fix**: Copying objects preserves source metadata. Fixing this requires `MetadataDirective: "REPLACE"` which is a deeper change.
- **SWR/caching for signed URLs**: Signed URLs expire (default 24h), so a caching strategy with refresh-before-expiry could be added later.
