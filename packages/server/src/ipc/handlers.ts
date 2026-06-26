// IPC request handlers.
//
// One handler per FUSE op, dispatched by the request's `op` field. Each runs
// in-process via `dispatchOp` / `writeRaw` so the daemon never round-trips
// through HTTP loopback. RBAC + versioning + indexing flow through the same
// path as the JSON op route:
//   - write paths (`open_write`, `create_file`, `truncate`) require
//     editor-or-better — enforced inside `writeRaw` itself;
//   - `unlink` / `rename` go through `dispatchOp` ("rm" / "mv", editor ops);
//   - read/list/getattr paths stay viewer-accessible.
//
// Wire encoding mirrors the Rust helper's `serde` enums (see
// `packages/fuse-helper/src/ipc.rs` — `#[serde(rename_all = "snake_case")]`):
//   - Requests are `{ op: "<snake_case>", ...fields }`.
//   - Responses are `{ <snake_case variant>: { ...fields } }` for data
//     variants, or bare strings `"ok"` / `"pong"` for the unit variants.

import {
  dispatchOp,
  writeRaw,
  resolveContext,
  listDrivesForUser,
  listUserOrgs,
  getHeadVersionRow,
  getUserByApiKey,
  getS3Key,
} from "@/core";
import type { DB, StorageAdapter, EmbeddingProvider } from "@/core";

export interface IpcContext {
  db: DB;
  s3: StorageAdapter;
  embeddingProvider: EmbeddingProvider | null;
  appUrl?: string;
  /**
   * Resolve the bearer-equivalent API key for IPC calls. The daemon runs in
   * single-user local mode; the key lives in `~/.agent-fs/config.json` (the
   * same one the CLI's `ApiClient` reads). Returning `null` causes handlers
   * that need a user to respond with an AUTH error.
   */
  resolveApiKey: () => string | null;
}

// ---------------------------------------------------------------------------
// Wire-shape helpers
// ---------------------------------------------------------------------------

interface ErrorResponse {
  error: {
    http_status: number;
    code: string | null;
    message: string;
  };
}

function err(http_status: number, code: string | null, message: string): ErrorResponse {
  return { error: { http_status, code, message } };
}

function classifyError(e: any): ErrorResponse {
  const name = String(e?.name ?? "");
  const msg = String(e?.message ?? e ?? "unknown error");
  if (name === "EditConflictError") {
    return err(409, "EDIT_CONFLICT", msg);
  }
  if (name === "NotFoundError") {
    return err(404, "NOT_FOUND", msg);
  }
  if (name === "PermissionDeniedError") {
    return err(403, "PERMISSION_DENIED", msg);
  }
  if (name === "ValidationError") {
    return err(415, "VALIDATION", msg);
  }
  if (name === "IndexingInProgressError") {
    return err(503, "INDEXING_IN_PROGRESS", msg);
  }
  // Unknown user/auth issue from the resolver
  if (/no.*api.*key|no.*user/i.test(msg)) {
    return err(401, "AUTH_MISSING", msg);
  }
  return err(500, "INTERNAL", msg);
}

// ---------------------------------------------------------------------------
// Auth resolver
// ---------------------------------------------------------------------------

interface AuthState {
  userId: string;
  email: string;
}

function resolveAuth(ctx: IpcContext): AuthState {
  const key = ctx.resolveApiKey();
  if (!key) {
    const e: any = new Error("daemon has no API key configured");
    e.name = "AuthError";
    throw e;
  }
  const user = getUserByApiKey(ctx.db, key);
  if (!user) {
    const e: any = new Error("API key did not resolve to a user");
    e.name = "AuthError";
    throw e;
  }
  return { userId: user.id, email: user.email };
}

// ---------------------------------------------------------------------------
// Per-op handlers
// ---------------------------------------------------------------------------

interface Request {
  op: string;
  // op-specific fields:
  drive?: string;
  path?: string;
  from_path?: string;
  to_drive?: string;
  to_path?: string;
  size?: number;
  base_version?: number | null;
  content_hash?: string;
  bytes?: Uint8Array | Buffer;
  line?: string;
  client_version?: string;
  pid?: number;
  head_version?: number;
  base_hash?: string;
  attempted_hash?: string;
}

/**
 * Resolve the org + drive for an IPC request. `drive` is the slug or id; we
 * look it up against the user's visible drives.
 */
function resolveDrive(
  ctx: IpcContext,
  userId: string,
  driveRef: string
): { orgId: string; driveId: string } {
  // Cheapest path: drive ref already an id (uuid).
  try {
    const resolved = resolveContext(ctx.db, { userId, driveId: driveRef });
    return { orgId: resolved.orgId, driveId: resolved.driveId };
  } catch {
    /* fall through to slug lookup */
  }
  // Slug-based — walk every org the user can see. The number of orgs per
  // local user is tiny (usually 1); this is fine.
  const orgs = listUserOrgs(ctx.db, userId);
  for (const org of orgs) {
    const drives = listDrivesForUser(ctx.db, org.id, userId);
    // Match by name (slug == name in this codebase).
    const match = drives.find((d) => d.name === driveRef);
    if (match) {
      return { orgId: org.id, driveId: match.id };
    }
  }
  const e: any = new Error(`Drive not found: ${driveRef}`);
  e.name = "NotFoundError";
  throw e;
}

function buildOpCtx(
  ctx: IpcContext,
  auth: AuthState,
  orgId: string,
  driveId: string
) {
  return {
    db: ctx.db,
    s3: ctx.s3,
    orgId,
    driveId,
    userId: auth.userId,
    embeddingProvider: ctx.embeddingProvider,
    appUrl: ctx.appUrl,
  };
}

// ---------------------------------------------------------------------------
// Public dispatch
// ---------------------------------------------------------------------------

export async function dispatchIpc(ctx: IpcContext, body: unknown): Promise<unknown> {
  if (!body || typeof body !== "object") {
    return err(400, "VALIDATION", "request body must be an object");
  }
  const req = body as Request;
  try {
    return await dispatch(ctx, req);
  } catch (e) {
    return classifyError(e);
  }
}

async function dispatch(ctx: IpcContext, req: Request): Promise<unknown> {
  switch (req.op) {
    case "ping":
      return "pong";

    case "hello":
      // Stateless v1 — we acknowledge but don't persist per-conn state in
      // this minimal handler. The plan's MountSession lives in sidecar.ts
      // and is hooked up by the daemon's connect callback (out of scope of
      // a pure dispatcher).
      return "ok";

    case "list_drives": {
      const auth = resolveAuth(ctx);
      const orgs = listUserOrgs(ctx.db, auth.userId);
      const out: Array<{ slug: string; id: string; org_id: string }> = [];
      for (const org of orgs) {
        const drives = listDrivesForUser(ctx.db, org.id, auth.userId);
        for (const d of drives) {
          out.push({ slug: d.name, id: d.id, org_id: org.id });
        }
      }
      return { drives: out };
    }

    case "default_drive_slug": {
      const auth = resolveAuth(ctx);
      const orgs = listUserOrgs(ctx.db, auth.userId);
      // First default-marked drive across the user's visible orgs wins.
      for (const org of orgs) {
        const drives = listDrivesForUser(ctx.db, org.id, auth.userId);
        const def = drives.find((d) => d.isDefault) ?? drives[0];
        if (def) {
          return { default_drive_slug: def.name };
        }
      }
      return { default_drive_slug: null };
    }

    case "get_attr": {
      const auth = resolveAuth(ctx);
      const { orgId, driveId } = resolveDrive(ctx, auth.userId, req.drive!);
      const path = req.path!;
      const opCtx = buildOpCtx(ctx, auth, orgId, driveId);
      try {
        const stat = (await dispatchOp(opCtx, "stat", { path })) as any;
        return {
          attr: {
            kind: "File",
            size: stat.size,
            mtime_unix: Math.floor(new Date(stat.modifiedAt).getTime() / 1000),
            version: stat.currentVersion ?? null,
            content_hash: null,
          },
        };
      } catch (e: any) {
        if (String(e?.name) === "NotFoundError") {
          try {
            const lsRes = (await dispatchOp(opCtx, "ls", { path })) as any;
            if (lsRes && Array.isArray(lsRes.entries) && lsRes.entries.length > 0) {
              return {
                attr: {
                  kind: "Dir",
                  size: 0,
                  mtime_unix: 0,
                  version: null,
                  content_hash: null,
                },
              };
            }
          } catch {
            /* fall through */
          }
        }
        throw e;
      }
    }

    case "read_dir": {
      const auth = resolveAuth(ctx);
      const { orgId, driveId } = resolveDrive(ctx, auth.userId, req.drive!);
      const path = req.path ?? "/";
      const opCtx = buildOpCtx(ctx, auth, orgId, driveId);
      const lsRes = (await dispatchOp(opCtx, "ls", { path })) as any;
      const entries = (lsRes?.entries ?? []).map((e: any) => ({
        name: e.name,
        kind: e.type === "directory" ? "Dir" : "File",
        size: e.size ?? 0,
        mtime_unix: e.modifiedAt
          ? Math.floor(new Date(e.modifiedAt).getTime() / 1000)
          : 0,
        version: null,
        content_hash: null,
      }));
      return { dir_entries: entries };
    }

    case "open_read": {
      const auth = resolveAuth(ctx);
      const { orgId, driveId } = resolveDrive(ctx, auth.userId, req.drive!);
      const path = req.path!;
      const key = getS3Key(orgId, driveId, path);
      const object = await ctx.s3.getObject(key);
      // Pull head metadata for version + hash. Falls back to nulls if missing.
      const head = getHeadVersionRow({ db: ctx.db, driveId }, path);
      return {
        open_read: {
          bytes: object.body,
          version: head?.version ?? 0,
          content_hash: head?.contentHash ?? "",
          size: object.body.length,
          mtime_unix: head?.createdAt
            ? Math.floor(new Date(head.createdAt).getTime() / 1000)
            : 0,
        },
      };
    }

    case "open_write": {
      const auth = resolveAuth(ctx);
      const { orgId, driveId } = resolveDrive(ctx, auth.userId, req.drive!);
      const path = req.path!;
      const opCtx = buildOpCtx(ctx, auth, orgId, driveId);
      const bytes = toBytes(req.bytes);
      const result = await writeRaw(opCtx, {
        path,
        bytes,
        expectedVersion: req.base_version ?? undefined,
      });
      return {
        open_write: {
          version: result.version,
          content_hash: result.contentHash ?? "",
          deduped: result.deduped ?? false,
        },
      };
    }

    case "create_file": {
      const auth = resolveAuth(ctx);
      const { orgId, driveId } = resolveDrive(ctx, auth.userId, req.drive!);
      const path = req.path!;
      const opCtx = buildOpCtx(ctx, auth, orgId, driveId);
      // Create-only semantics: expectedVersion: 0 ⇒ file must not exist yet.
      const result = await writeRaw(opCtx, {
        path,
        bytes: new Uint8Array(0),
        expectedVersion: 0,
      });
      return {
        open_write: {
          version: result.version,
          content_hash: result.contentHash ?? "",
          deduped: result.deduped ?? false,
        },
      };
    }

    case "truncate": {
      const auth = resolveAuth(ctx);
      const { orgId, driveId } = resolveDrive(ctx, auth.userId, req.drive!);
      const path = req.path!;
      const size = req.size ?? 0;
      const opCtx = buildOpCtx(ctx, auth, orgId, driveId);
      // Read current bytes, truncate, write back.
      const key = getS3Key(orgId, driveId, path);
      const current = (await ctx.s3.getObject(key)).body;
      const trimmed = current.subarray(0, Math.min(size, current.length));
      const result = await writeRaw(opCtx, { path, bytes: trimmed });
      return {
        open_write: {
          version: result.version,
          content_hash: result.contentHash ?? "",
          deduped: result.deduped ?? false,
        },
      };
    }

    case "unlink": {
      const auth = resolveAuth(ctx);
      const { orgId, driveId } = resolveDrive(ctx, auth.userId, req.drive!);
      const path = req.path!;
      const opCtx = buildOpCtx(ctx, auth, orgId, driveId);
      await dispatchOp(opCtx, "rm", { path });
      return "ok";
    }

    case "rename": {
      const auth = resolveAuth(ctx);
      const { orgId, driveId } = resolveDrive(ctx, auth.userId, req.drive!);
      const from = req.from_path!;
      const to = req.to_path!;
      const opCtx = buildOpCtx(ctx, auth, orgId, driveId);
      await dispatchOp(opCtx, "mv", { from, to });
      return "ok";
    }

    case "mkdir": {
      // Object storage has no directory marker convention here. The namespace
      // populates on first write under the prefix. Return Ok so the kernel
      // doesn't surface a spurious error.
      resolveAuth(ctx);
      return "ok";
    }

    case "rmdir": {
      const auth = resolveAuth(ctx);
      const { orgId, driveId } = resolveDrive(ctx, auth.userId, req.drive!);
      const path = req.path!;
      const opCtx = buildOpCtx(ctx, auth, orgId, driveId);
      const lsRes = (await dispatchOp(opCtx, "ls", { path })) as any;
      if (lsRes?.entries?.length > 0) {
        return err(409, "VALIDATION", "directory not empty");
      }
      return "ok";
    }

    case "record_conflict": {
      // v1: helper owns the sidecar writes; this is a logging passthrough so
      // the daemon has visibility. Out of scope here is fanout to webhooks /
      // events table.
      console.warn(
        "[agent-fs ipc] conflict:",
        JSON.stringify({
          drive: req.drive,
          path: req.path,
          base_version: req.base_version,
          head_version: req.head_version,
          bytes: req.bytes,
        })
      );
      return "ok";
    }

    case "write_status": {
      console.warn("[agent-fs ipc] status:", req.line);
      return "ok";
    }

    default:
      return err(400, "VALIDATION", `unknown op: ${req.op}`);
  }
}

function toBytes(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (Array.isArray(input)) return new Uint8Array(input as number[]);
  if (input == null) return new Uint8Array(0);
  if (typeof input === "string") return new TextEncoder().encode(input);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) {
    return new Uint8Array(input);
  }
  return new Uint8Array(0);
}
