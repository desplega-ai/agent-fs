// IPC server for the FUSE helper.
//
// Wire format: 4-byte big-endian u32 length prefix + msgpack body.
// Each request/response carries the same `request_id` so the helper can
// multiplex calls over a single socket. Concurrency is unbounded — Bun's
// scheduler handles it; the heavy DB/S3 work is the actual bottleneck.
//
// Handlers live in `./handlers.ts` and are typed against the `IpcContext`
// the daemon passes in (db, s3, embeddingProvider, apiKey resolver).

import { unlinkSync, existsSync, chmodSync } from "node:fs";
import { Packr, Unpackr } from "msgpackr";
import type { Socket } from "bun";
import type { IpcContext } from "./handlers.js";
import { dispatchIpc } from "./handlers.js";

/** Maximum frame body size (matches the helper's reader cap). */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** Wire envelope: `{ id, body }`. The helper mirrors `id` back on responses. */
export interface Envelope {
  id: number;
  body: unknown;
}

// Use named encoding so {op: "..."} keys round-trip cleanly with the helper's
// serde tagged enum (rmp-serde `to_vec_named` / `from_slice`).
// useRecords: false keeps the wire format as plain msgpack maps/arrays —
// msgpackr's default "records" mode is non-standard and breaks rmp-serde.
const packr = new Packr({ useRecords: false });
const unpackr = new Unpackr({ useRecords: false });

interface ConnState {
  buf: Buffer;
}

/**
 * Start the IPC listener on a Unix socket.
 *
 * Returns a handle with `stop()` to shut down + remove the socket file.
 * On startup, stale sockets are removed if no PID still owns them.
 */
export function startIpcServer(
  socketPath: string,
  ctx: IpcContext
): { stop: () => void; socketPath: string } {
  // Belt-and-suspenders cleanup of stale socket files. Caller (daemon.ts)
  // already does the alive-pid check; this just unlinks if the path exists.
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      /* ignore */
    }
  }

  const server = Bun.listen<ConnState>({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.data = { buf: Buffer.alloc(0) };
      },
      data(socket, chunk) {
        socket.data.buf = Buffer.concat([socket.data.buf, chunk]);
        drainFrames(socket, ctx).catch((err) => {
          // Catastrophic decode error — log and close.
          console.error("[agent-fs ipc] frame drain failed:", err);
          socket.end();
        });
      },
      close(socket) {
        socket.data.buf = Buffer.alloc(0);
      },
      error(_socket, err) {
        console.error("[agent-fs ipc] socket error:", err);
      },
    },
  });

  // Tighten perms — same-UID only.
  try {
    chmodSync(socketPath, 0o600);
  } catch {
    /* ignore */
  }

  return {
    socketPath,
    stop: () => {
      server.stop(true);
      try {
        unlinkSync(socketPath);
      } catch {
        /* ignore */
      }
    },
  };
}

async function drainFrames(socket: Socket<ConnState>, ctx: IpcContext): Promise<void> {
  while (true) {
    const state = socket.data;
    if (state.buf.length < 4) return;
    const len = state.buf.readUInt32BE(0);
    if (len === 0 || len > MAX_FRAME_BYTES) {
      console.error(`[agent-fs ipc] implausible frame length ${len}; closing`);
      socket.end();
      return;
    }
    if (state.buf.length < 4 + len) return;
    const body = state.buf.subarray(4, 4 + len);
    state.buf = state.buf.subarray(4 + len);

    let env: Envelope;
    try {
      env = unpackr.unpack(body) as Envelope;
    } catch (err) {
      console.error("[agent-fs ipc] decode failed:", err);
      socket.end();
      return;
    }

    // Run the handler concurrently — don't block the drain loop on slow ops.
    // Errors are caught inside dispatchIpc and wrapped as Response::Error.
    void handleEnvelope(socket, ctx, env);
  }
}

async function handleEnvelope(
  socket: Socket<ConnState>,
  ctx: IpcContext,
  env: Envelope
): Promise<void> {
  let respBody: unknown;
  try {
    respBody = await dispatchIpc(ctx, env.body);
  } catch (err: any) {
    // Last-resort guard — handlers themselves should produce a structured
    // Error response. If they throw, we surface as a generic IPC error.
    respBody = {
      Error: {
        http_status: 0,
        code: null,
        message: String(err?.message ?? err),
      },
    };
  }
  const respEnv: Envelope = { id: env.id, body: respBody };
  const buf = packr.pack(respEnv);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(buf.length, 0);
  // Concatenate then write once — multiple writes can interleave with other
  // pending responses on the same socket if a handler ran concurrently.
  socket.write(Buffer.concat([lenBuf, buf as unknown as Buffer]));
}

// ---------------------------------------------------------------------------
// Small helper exposed for tests — pack/unpack frames against a buffer.
// ---------------------------------------------------------------------------

/** Encode an envelope onto the wire (length-prefix + msgpack body). */
export function encodeFrame(env: Envelope): Buffer {
  const body = packr.pack(env);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(body.length, 0);
  return Buffer.concat([lenBuf, body as unknown as Buffer]);
}

/** Decode a single frame from a buffer, returning the envelope + leftover. */
export function decodeFrame(buf: Buffer): { env: Envelope; rest: Buffer } | null {
  if (buf.length < 4) return null;
  const len = buf.readUInt32BE(0);
  if (buf.length < 4 + len) return null;
  const env = unpackr.unpack(buf.subarray(4, 4 + len)) as Envelope;
  return { env, rest: buf.subarray(4 + len) };
}
