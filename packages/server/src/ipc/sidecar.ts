// Sidecar dir model + schema mirror.
//
// v1 decision (plan §Phase 3.2, "option B"): sidecar files live host-side at
// `~/.agent-fs/sidecars/<mountpoint-hash>/` and the FUSE helper exposes them
// as a virtual `<mount>/.agent-fs/` directory. The helper owns the actual
// writes (see `packages/fuse-helper/src/sidecar.rs`); this module exists so
// the daemon has the type definitions for future daemon-side writes and so
// the helper's Hello-time `mountpoint` can be hashed into the same path
// scheme.
//
// Keeping the helper and the daemon agreeing on the directory format is the
// load-bearing part — if it ever drifts, the helper will surface sidecars
// the daemon can't find (or vice versa). The hash function is intentionally
// simple (sha256 of the absolute path, hex-truncated).

import { createHash } from "node:crypto";
import { join } from "node:path";
import { getHome } from "@/core";

export interface MountSession {
  /** Absolute path the helper passed in its `Hello` request. */
  mountpoint: string;
  /** Per-mount host-side sidecar directory (see above). */
  sidecarDir: string;
}

/**
 * Compute the host-side sidecar directory for a given mountpoint.
 *
 * Deterministic: same mountpoint → same dir. Hash is truncated to 16 hex
 * chars (64 bits, plenty for collision resistance across one user's mounts)
 * to keep the path short.
 */
export function sidecarDirFor(mountpoint: string): string {
  const hash = createHash("sha256").update(mountpoint).digest("hex").slice(0, 16);
  return join(getHome(), "sidecars", hash);
}

/** Conflict record (matches the Rust helper's `agent-fs.conflict/v1`). */
export interface ConflictRecord {
  schema: "agent-fs.conflict/v1";
  id: string;
  timestamp: string;
  drive: string;
  path: string;
  base_version: number;
  head_version: number;
  base_hash: string;
  attempted_hash: string;
  bytes: number;
  pid: number;
}

/** Error record (matches the Rust helper's `agent-fs.error/v1`). */
export interface ErrorRecord {
  schema: "agent-fs.error/v1";
  id: string;
  timestamp: string;
  drive?: string;
  path?: string;
  errno: number;
  http_status?: number;
  code?: string;
  message: string;
  pid: number;
}

/**
 * In-memory cache of `MountSession` keyed by socket connection identity.
 * Each IPC server instance maintains its own table; the `Hello` handler
 * registers entries here. For pure-functional dispatch we don't currently
 * read these back (helper owns sidecar writes); kept for forward
 * compatibility with daemon-driven sidecar emission.
 */
export class MountSessionTable {
  private byConn = new WeakMap<object, MountSession>();

  /** Register a mountpoint for a given connection token. */
  set(token: object, mountpoint: string): MountSession {
    const sess: MountSession = {
      mountpoint,
      sidecarDir: sidecarDirFor(mountpoint),
    };
    this.byConn.set(token, sess);
    return sess;
  }

  get(token: object): MountSession | undefined {
    return this.byConn.get(token);
  }
}
