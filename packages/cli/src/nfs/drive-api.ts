// DriveApi backed by the agent-fs HTTP API (local daemon or hosted).

import type { ApiClient } from "../api-client.js";
import {
  FsError,
  NFS3ERR_ACCES,
  NFS3ERR_IO,
  NFS3ERR_NOENT,
  type DriveApi,
  type DriveEntry,
} from "./vfs.js";

export function toFsError(err: unknown): FsError {
  const msg = (err as Error)?.message ?? String(err);
  if (/not found|does not exist/i.test(msg)) return new FsError(NFS3ERR_NOENT, msg);
  if (/permission|forbidden|not allowed|unauthori[sz]ed|read-only|viewer/i.test(msg)) {
    return new FsError(NFS3ERR_ACCES, msg);
  }
  return new FsError(NFS3ERR_IO, msg);
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toFsError(err);
  }
}

export function agentFsDriveApi(client: ApiClient, orgId: string, driveId: string): DriveApi {
  return {
    async list(path) {
      try {
        const res = await client.callOp(orgId, "ls", { driveId, path });
        return (res.entries ?? []).map(
          (e: any): DriveEntry => ({
            name: e.name,
            type: e.type === "directory" ? "directory" : "file",
            size: e.size ?? 0,
            mtimeMs: e.modifiedAt ? Date.parse(e.modifiedAt) || 0 : 0,
          })
        );
      } catch (err) {
        const fsErr = toFsError(err);
        if (fsErr.status === NFS3ERR_NOENT) return [];
        throw fsErr;
      }
    },
    read: (path) => wrap(async () => (await client.getRaw(orgId, driveId, path)).bytes),
    write: (path, bytes) =>
      wrap(async () => {
        await client.putRaw(orgId, driveId, path, bytes, { message: "Saved from agent-fs mount" });
      }),
    remove: (path) => wrap(() => client.callOp(orgId, "rm", { driveId, path })),
    move: (from, to) => wrap(() => client.callOp(orgId, "mv", { driveId, from, to })),
  };
}
