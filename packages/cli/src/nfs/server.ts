// NFSv3 (RFC 1813) + MOUNT v3 server over TCP, ONC RPC (RFC 5531).
//
// Both programs share one port, so the client is mounted with
// `port=<p>,mountport=<p>` and no portmapper is needed. It binds 127.0.0.1
// only: the mount is for this machine's user, and the RPC layer trusts the
// caller (AUTH_SYS credentials are not checked).

import { createServer, type Server, type Socket } from "node:net";
import { XdrReader, XdrWriter } from "./xdr.js";
import { FsError, NFS3ERR_IO, NFS3ERR_NOTSUPP, type Attr, type Vfs } from "./vfs.js";

const RPC_CALL = 0;
const RPC_REPLY = 1;
const MSG_ACCEPTED = 0;
const MSG_DENIED = 1;
const SUCCESS = 0;
const PROG_UNAVAIL = 1;
const PROG_MISMATCH = 2;
const PROC_UNAVAIL = 3;
const GARBAGE_ARGS = 4;

const PROG_NFS = 100003;
const PROG_MOUNT = 100005;

const NF3REG = 1;
const NF3DIR = 2;
const UNSTABLE = 0;
const FSF3_HOMOGENEOUS = 0x08;
const FSF3_CANSETTIME = 0x10;
const IO_SIZE = 1024 * 1024;
const MAX_RECORD = 4 * IO_SIZE;

// After a failed call, each procedure's result carries "no attributes"
// placeholders: one word per post_op_attr, two per wcc_data.
const FAIL_WORDS: Record<number, number> = {
  1: 0, 2: 2, 3: 1, 4: 1, 5: 1, 6: 1, 7: 2, 8: 2, 9: 2, 10: 2, 11: 2,
  12: 2, 13: 2, 14: 4, 15: 3, 16: 1, 17: 1, 18: 1, 19: 1, 20: 1, 21: 2,
};

export interface NfsServerOptions {
  uid?: number;
  gid?: number;
  log?: (msg: string) => void;
}

export class NfsServer {
  private server?: Server;
  private sockets = new Set<Socket>();
  private uid: number;
  private gid: number;
  private log: (msg: string) => void;
  private writeVerf: Uint8Array;

  constructor(private vfs: Vfs, opts: NfsServerOptions = {}) {
    this.uid = opts.uid ?? process.getuid?.() ?? 0;
    this.gid = opts.gid ?? process.getgid?.() ?? 0;
    this.log = opts.log ?? ((m) => console.error(m));
    this.writeVerf = vfs.boot;
  }

  listen(port = 0, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((sock) => this.accept(sock));
      server.once("error", reject);
      server.listen(port, host, () => {
        this.server = server;
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private accept(sock: Socket): void {
    this.sockets.add(sock);
    sock.setNoDelay(true);
    let pending: Buffer = Buffer.alloc(0);
    let fragments: Buffer[] = [];
    let fragmentBytes = 0;
    sock.on("data", (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= 4) {
        const header = pending.readUInt32BE(0);
        const len = header & 0x7fffffff;
        if (fragmentBytes + len > MAX_RECORD) {
          this.log(`agent-fs nfs: dropping client sending a ${fragmentBytes + len}-byte record`);
          sock.destroy();
          return;
        }
        if (pending.length < 4 + len) break;
        fragments.push(pending.subarray(4, 4 + len));
        fragmentBytes += len;
        pending = pending.subarray(4 + len);
        if (header & 0x80000000) {
          const record = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
          fragments = [];
          fragmentBytes = 0;
          this.handle(new Uint8Array(record)).then(
            (reply) => {
              if (reply && !sock.destroyed) {
                const head = Buffer.alloc(4);
                head.writeUInt32BE((0x80000000 | reply.length) >>> 0);
                sock.write(Buffer.concat([head, reply]));
              }
            },
            (err) => this.log(`agent-fs nfs: ${err?.stack ?? err}`)
          );
        }
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => this.sockets.delete(sock));
  }

  /** Handle one RPC record; returns the reply record (null when unparseable). */
  async handle(record: Uint8Array): Promise<Uint8Array | null> {
    const r = new XdrReader(record);
    let xid: number;
    try {
      xid = r.u32();
      if (r.u32() !== RPC_CALL) return null;
    } catch {
      return null;
    }
    const w = new XdrWriter().u32(xid).u32(RPC_REPLY);
    let prog: number, vers: number, proc: number;
    try {
      const rpcvers = r.u32();
      prog = r.u32();
      vers = r.u32();
      proc = r.u32();
      r.u32();
      r.opaque(400); // credentials (AUTH_SYS trusted, see header)
      r.u32();
      r.opaque(400); // verifier
      if (rpcvers !== 2) {
        return w.u32(MSG_DENIED).u32(0).u32(2).u32(2).bytes();
      }
    } catch {
      return w.u32(MSG_ACCEPTED).u32(0).u32(0).u32(GARBAGE_ARGS).bytes();
    }
    w.u32(MSG_ACCEPTED).u32(0).u32(0); // AUTH_NONE verifier
    if (prog !== PROG_NFS && prog !== PROG_MOUNT) return w.u32(PROG_UNAVAIL).bytes();
    if (vers !== 3) return w.u32(PROG_MISMATCH).u32(3).u32(3).bytes();

    const body = new XdrWriter();
    try {
      const known = prog === PROG_MOUNT ? await this.mount(proc, r, body) : await this.nfs(proc, r, body);
      if (!known) return w.u32(PROC_UNAVAIL).bytes();
    } catch (err) {
      if (err instanceof RangeError) return w.u32(GARBAGE_ARGS).bytes();
      const status = err instanceof FsError ? err.status : NFS3ERR_IO;
      if (!(err instanceof FsError)) this.log(`agent-fs nfs: proc ${proc} failed: ${(err as Error)?.message ?? err}`);
      const fail = new XdrWriter().u32(status);
      for (let i = 0; i < (FAIL_WORDS[proc] ?? 0); i++) fail.u32(0);
      return concat(w.u32(SUCCESS).bytes(), fail.bytes());
    }
    return concat(w.u32(SUCCESS).bytes(), body.bytes());
  }

  // ---- MOUNT v3 ----------------------------------------------------------

  private async mount(proc: number, r: XdrReader, w: XdrWriter): Promise<boolean> {
    switch (proc) {
      case 0: // NULL
      case 3: // UMNT
      case 4: // UMNTALL
        if (proc === 3) r.string(1024);
        return true;
      case 1: { // MNT: the export path is a folder of the drive ("/" = root).
        const path = "/" + r.string(1024).split("/").filter(Boolean).join("/");
        const attr = await this.vfs.attr(path).catch(() => null);
        if (attr?.type !== "directory") {
          w.u32(attr ? 20 : 2); // MNT3ERR_NOTDIR / MNT3ERR_NOENT
          return true;
        }
        w.u32(0).opaque(this.vfs.handle(path));
        w.u32(2).u32(0).u32(1); // auth flavors: AUTH_NONE, AUTH_SYS
        return true;
      }
      case 2: // DUMP
        w.bool(false);
        return true;
      case 5: // EXPORT
        w.bool(true).string("/").bool(false).bool(false);
        return true;
      default:
        return false;
    }
  }

  // ---- NFS v3 ------------------------------------------------------------

  private fattr(w: XdrWriter, a: Attr): void {
    const dir = a.type === "directory";
    const sec = Math.floor(a.mtimeMs / 1000);
    const nsec = Math.floor((a.mtimeMs % 1000) * 1e6);
    w.u32(dir ? NF3DIR : NF3REG)
      .u32(dir ? 0o755 : 0o644)
      .u32(dir ? 2 : 1)
      .u32(this.uid)
      .u32(this.gid)
      .u64(a.size)
      .u64(a.size)
      .u32(0)
      .u32(0) // rdev
      .u64(1) // fsid
      .u64(a.id);
    for (let i = 0; i < 3; i++) w.u32(sec).u32(nsec); // atime, mtime, ctime
  }

  private postOp(w: XdrWriter, a: Attr | null): void {
    if (a) {
      w.bool(true);
      this.fattr(w, a);
    } else {
      w.bool(false);
    }
  }

  private noWcc(w: XdrWriter): void {
    w.u32(0).u32(0);
  }

  private async maybeAttr(path: string): Promise<Attr | null> {
    return this.vfs.attr(path).catch(() => null);
  }

  /** sattr3; returns the requested size, if any. */
  private sattr(r: XdrReader): number | undefined {
    if (r.bool()) r.u32(); // mode
    if (r.bool()) r.u32(); // uid
    if (r.bool()) r.u32(); // gid
    const size = r.bool() ? Number(r.u64()) : undefined;
    for (let i = 0; i < 2; i++) if (r.u32() === 2) (r.u32(), r.u32()); // atime, mtime
    return size;
  }

  private async nfs(proc: number, r: XdrReader, w: XdrWriter): Promise<boolean> {
    const vfs = this.vfs;
    switch (proc) {
      case 0: // NULL
        return true;

      case 1: { // GETATTR
        const a = await vfs.attr(vfs.pathOf(r.opaque(64)));
        w.u32(0);
        this.fattr(w, a);
        return true;
      }

      case 2: { // SETATTR
        const path = vfs.pathOf(r.opaque(64));
        const size = this.sattr(r);
        if (r.bool()) (r.u32(), r.u32()); // guard ctime, not enforced
        const a = size === undefined ? await vfs.attr(path) : await vfs.setSize(path, size);
        w.u32(0).u32(0);
        this.postOp(w, a);
        return true;
      }

      case 3: { // LOOKUP
        const dir = vfs.pathOf(r.opaque(64));
        const name = r.string(1024);
        try {
          const { path, attr } = await vfs.lookup(dir, name);
          w.u32(0).opaque(vfs.handle(path));
          this.postOp(w, attr);
          this.postOp(w, await this.maybeAttr(dir));
        } catch (err) {
          if (!(err instanceof FsError)) throw err;
          w.u32(err.status);
          this.postOp(w, await this.maybeAttr(dir));
        }
        return true;
      }

      case 4: { // ACCESS: the drive's own RBAC decides on write.
        const a = await vfs.attr(vfs.pathOf(r.opaque(64)));
        const want = r.u32();
        w.u32(0);
        this.postOp(w, a);
        w.u32(want);
        return true;
      }

      case 6: { // READ
        const path = vfs.pathOf(r.opaque(64));
        const offset = Number(r.u64());
        const count = Math.min(r.u32(), IO_SIZE);
        const { data, eof, attr } = await vfs.read(path, offset, count);
        w.u32(0);
        this.postOp(w, attr);
        w.u32(data.length).bool(eof).opaque(data);
        return true;
      }

      case 7: { // WRITE: buffered in RAM; durable after COMMIT.
        const path = vfs.pathOf(r.opaque(64));
        const offset = Number(r.u64());
        r.u32(); // count (the opaque carries its own length)
        r.u32(); // stable_how requested; we always answer UNSTABLE
        const data = r.opaque(IO_SIZE);
        const a = await vfs.write(path, offset, data);
        w.u32(0).u32(0);
        this.postOp(w, a);
        w.u32(data.length).u32(UNSTABLE).fixed(this.writeVerf);
        return true;
      }

      case 8: { // CREATE
        const dir = vfs.pathOf(r.opaque(64));
        const name = r.string(1024);
        const mode = r.u32();
        let size: number | undefined;
        if (mode === 2) r.fixed(8);
        else size = this.sattr(r);
        let { path, attr } = await vfs.create(dir, name, mode !== 0);
        if (size !== undefined && size !== attr.size) attr = await vfs.setSize(path, size);
        w.u32(0).bool(true).opaque(vfs.handle(path));
        this.postOp(w, attr);
        this.noWcc(w);
        return true;
      }

      case 9: { // MKDIR
        const dir = vfs.pathOf(r.opaque(64));
        const name = r.string(1024);
        this.sattr(r);
        const { path, attr } = await vfs.mkdir(dir, name);
        w.u32(0).bool(true).opaque(vfs.handle(path));
        this.postOp(w, attr);
        this.noWcc(w);
        return true;
      }

      case 12: // REMOVE
      case 13: { // RMDIR
        const dir = vfs.pathOf(r.opaque(64));
        const name = r.string(1024);
        if (proc === 12) await vfs.remove(dir, name);
        else await vfs.rmdir(dir, name);
        w.u32(0);
        this.noWcc(w);
        return true;
      }

      case 14: { // RENAME
        const fromDir = vfs.pathOf(r.opaque(64));
        const fromName = r.string(1024);
        const toDir = vfs.pathOf(r.opaque(64));
        const toName = r.string(1024);
        await vfs.rename(fromDir, fromName, toDir, toName);
        w.u32(0);
        this.noWcc(w);
        this.noWcc(w);
        return true;
      }

      case 16: // READDIR
      case 17: { // READDIRPLUS
        const dir = vfs.pathOf(r.opaque(64));
        const cookie = Number(r.u64());
        r.fixed(8); // cookieverf, not checked
        const dircount = r.u32();
        const maxcount = proc === 17 ? r.u32() : dircount;
        const entries = await vfs.readdir(dir);
        w.u32(0);
        this.postOp(w, await vfs.attr(dir));
        w.fixed(new Uint8Array(8));
        let budget = maxcount - 200;
        let i = cookie;
        for (; i < entries.length; i++) {
          const e = entries[i];
          const path = vfs.child(dir, e.name);
          const entry = new XdrWriter().bool(true).u64(e.attr.id).string(e.name).u64(i + 1);
          if (proc === 17) {
            this.postOp(entry, e.attr);
            entry.bool(true).opaque(vfs.handle(path));
          }
          if (entry.length > budget) break;
          budget -= entry.length;
          w.fixed(entry.bytes());
        }
        w.bool(false).bool(i >= entries.length);
        return true;
      }

      case 18: { // FSSTAT
        const a = await vfs.attr(vfs.pathOf(r.opaque(64)));
        const tib = 2n ** 40n;
        w.u32(0);
        this.postOp(w, a);
        w.u64(tib).u64(tib).u64(tib).u64(1_000_000).u64(1_000_000).u64(1_000_000).u32(0);
        return true;
      }

      case 19: { // FSINFO
        const a = await vfs.attr(vfs.pathOf(r.opaque(64)));
        w.u32(0);
        this.postOp(w, a);
        w.u32(IO_SIZE).u32(IO_SIZE).u32(4096);
        w.u32(IO_SIZE).u32(IO_SIZE).u32(4096);
        w.u32(64 * 1024).u64(2n ** 40n).u32(0).u32(1_000_000);
        w.u32(FSF3_HOMOGENEOUS | FSF3_CANSETTIME);
        return true;
      }

      case 20: { // PATHCONF
        const a = await vfs.attr(vfs.pathOf(r.opaque(64)));
        w.u32(0);
        this.postOp(w, a);
        w.u32(1).u32(255).bool(true).bool(true).bool(false).bool(true);
        return true;
      }

      case 21: { // COMMIT: upload the RAM buffer now.
        const path = vfs.pathOf(r.opaque(64));
        await vfs.flush(path);
        w.u32(0);
        this.noWcc(w);
        w.fixed(this.writeVerf);
        return true;
      }

      case 5: // READLINK
      case 10: // SYMLINK
      case 11: // MKNOD
      case 15: // LINK
        throw new FsError(NFS3ERR_NOTSUPP);

      default:
        return false;
    }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
