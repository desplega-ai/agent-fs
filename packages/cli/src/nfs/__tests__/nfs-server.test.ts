// NFSv3 server tests: RPC calls built by hand against an in-memory drive.
// The Linux end-to-end run (libnfs client against a real daemon) is in the PR.

import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { NfsServer } from "../server.js";
import { Vfs, type DriveApi, type DriveEntry } from "../vfs.js";
import { XdrReader, XdrWriter } from "../xdr.js";

class MemDrive implements DriveApi {
  files = new Map<string, Uint8Array>();
  calls: string[] = [];
  /** When set, uploads wait on it, so a test can act while one is in flight. */
  gate?: Promise<void>;
  uploading?: () => void;
  /** When set, downloads wait on it, so a test can start several reads of one file. */
  readGate?: Promise<void>;
  failRemove = false;
  failMove = false;

  constructor(init: Record<string, string>) {
    for (const [p, c] of Object.entries(init)) this.files.set(p, new TextEncoder().encode(c));
  }

  async list(dir: string): Promise<DriveEntry[]> {
    const prefix = dir === "/" ? "/" : `${dir}/`;
    const out = new Map<string, DriveEntry>();
    for (const [p, b] of this.files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const [name, ...more] = rest.split("/");
      out.set(name, { name, type: more.length ? "directory" : "file", size: more.length ? 0 : b.length, mtimeMs: 1_700_000_000_000 });
    }
    return [...out.values()];
  }
  async read(p: string) {
    this.calls.push(`read ${p}`);
    await this.readGate;
    const b = this.files.get(p);
    if (!b) throw new Error("not found");
    return b;
  }
  async write(p: string, bytes: Uint8Array) {
    this.calls.push(`write ${p} ${new TextDecoder().decode(bytes)}`);
    const copy = bytes.slice();
    if (this.gate) {
      this.uploading?.();
      await this.gate;
    }
    this.files.set(p, copy);
  }
  async remove(p: string) {
    this.calls.push(`rm ${p}`);
    if (this.failRemove) throw new Error("offline");
    this.files.delete(p);
  }
  async move(from: string, to: string) {
    this.calls.push(`mv ${from} ${to}`);
    if (this.failMove) throw new Error("offline");
    this.files.set(to, this.files.get(from)!);
    this.files.delete(from);
  }
  text(p: string) {
    const b = this.files.get(p);
    return b ? new TextDecoder().decode(b) : undefined;
  }
}

const enc = (s: string) => new TextEncoder().encode(s);
let xid = 1;

function call(prog: number, proc: number, args: (w: XdrWriter) => void): Uint8Array {
  const w = new XdrWriter().u32(xid++).u32(0).u32(2).u32(prog).u32(3).u32(proc);
  w.u32(1).opaque(new XdrWriter().u32(0).string("mac").u32(501).u32(20).u32(0).bytes()); // AUTH_SYS
  w.u32(0).opaque(new Uint8Array(0));
  args(w);
  return w.bytes();
}

/** Run one call; return a reader positioned at the procedure's result body. */
async function rpc(server: NfsServer, prog: number, proc: number, args: (w: XdrWriter) => void = () => {}) {
  const reply = await server.handle(call(prog, proc, args));
  const r = new XdrReader(reply!);
  r.u32(); // xid
  expect(r.u32()).toBe(1); // REPLY
  expect(r.u32()).toBe(0); // MSG_ACCEPTED
  r.u32();
  r.opaque(); // verifier
  expect(r.u32()).toBe(0); // SUCCESS
  return r;
}

function skipFattr(r: XdrReader) {
  r.fixed(84);
}

function setup(init: Record<string, string>, flushIdleMs = 60_000) {
  const drive = new MemDrive(init);
  const vfs = new Vfs(drive, { flushIdleMs, retryMs: 20, listTtlMs: 0, log: () => {} });
  const server = new NfsServer(vfs, { log: () => {} });
  return { drive, vfs, server };
}

async function mnt(server: NfsServer, path = "/") {
  const r = await rpc(server, 100005, 1, (w) => w.string(path));
  expect(r.u32()).toBe(0);
  return r.opaque();
}

async function lookup(server: NfsServer, dir: Uint8Array, name: string) {
  const r = await rpc(server, 100003, 3, (w) => w.opaque(dir).string(name));
  const status = r.u32();
  return { status, fh: status === 0 ? r.opaque() : null };
}

async function readAll(server: NfsServer, fh: Uint8Array) {
  const r = await rpc(server, 100003, 6, (w) => w.opaque(fh).u64(0).u32(1 << 20));
  expect(r.u32()).toBe(0);
  if (r.bool()) skipFattr(r);
  r.u32();
  r.bool();
  return new TextDecoder().decode(r.opaque());
}

async function readAt(server: NfsServer, fh: Uint8Array, offset: number, count: number) {
  const r = await rpc(server, 100003, 6, (w) => w.opaque(fh).u64(offset).u32(count));
  expect(r.u32()).toBe(0);
  if (r.bool()) skipFattr(r);
  r.u32();
  r.bool();
  return new TextDecoder().decode(r.opaque());
}

async function write(server: NfsServer, fh: Uint8Array, offset: number, data: string) {
  const bytes = enc(data);
  const r = await rpc(server, 100003, 7, (w) => w.opaque(fh).u64(offset).u32(bytes.length).u32(0).opaque(bytes));
  expect(r.u32()).toBe(0);
}

/** A WRITE with the given stable_how; returns the status and the committed level. */
async function stableWrite(server: NfsServer, fh: Uint8Array, data: string, stable: number) {
  const bytes = enc(data);
  const r = await rpc(server, 100003, 7, (w) => w.opaque(fh).u64(0).u32(bytes.length).u32(stable).opaque(bytes));
  const status = r.u32();
  r.bool(); // pre_op_attr: none
  if (r.bool()) skipFattr(r);
  if (status !== 0) return { status };
  r.u32(); // count
  return { status, committed: r.u32() };
}

/** Hold every upload until release(); started resolves once one is in flight. */
function holdUploads(drive: MemDrive) {
  let release!: () => void;
  drive.gate = new Promise<void>((r) => (release = r));
  const started = new Promise<void>((r) => (drive.uploading = r));
  return {
    started,
    release: () => {
      drive.gate = undefined;
      release();
    },
  };
}

async function commit(server: NfsServer, fh: Uint8Array) {
  const r = await rpc(server, 100003, 21, (w) => w.opaque(fh).u64(0).u32(0));
  return r.u32();
}

async function create(server: NfsServer, dir: Uint8Array, name: string, mode = 0) {
  const r = await rpc(server, 100003, 8, (w) => {
    w.opaque(dir).string(name).u32(mode);
    if (mode === 2) w.fixed(new Uint8Array(8));
    else w.u32(0).u32(0).u32(0).u32(0).u32(0).u32(0);
  });
  const status = r.u32();
  if (status !== 0) return { status, fh: null };
  r.bool();
  return { status, fh: r.opaque() };
}

async function readdirNames(server: NfsServer, dir: Uint8Array) {
  const r = await rpc(server, 100003, 17, (w) => w.opaque(dir).u64(0).fixed(new Uint8Array(8)).u32(8192).u32(65536));
  expect(r.u32()).toBe(0);
  if (r.bool()) skipFattr(r);
  r.fixed(8);
  const names: string[] = [];
  while (r.bool()) {
    r.u64();
    names.push(r.string());
    r.u64();
    if (r.bool()) skipFattr(r);
    if (r.bool()) r.opaque();
  }
  expect(r.bool()).toBe(true); // eof
  return names;
}

describe("NFSv3 server over an agent-fs drive", () => {
  test("mounts, lists and reads files", async () => {
    const { server } = setup({ "/notes/a.md": "# A", "/t.csv": "a,b\n1,2" });
    const root = await mnt(server);
    // The Spotlight opt-out marker is memory-only and always at the root.
    expect((await readdirNames(server, root)).sort()).toEqual([".metadata_never_index", "notes", "t.csv"]);
    const notes = (await lookup(server, root, "notes")).fh!;
    const a = (await lookup(server, notes, "a.md")).fh!;
    expect(await readAll(server, a)).toBe("# A");
    expect((await lookup(server, root, "missing.md")).status).toBe(2);
  });

  test("an entry the drive names '.' is hidden; the rest of the folder still lists", async () => {
    // A key stored with a "./" segment makes the ls op return an entry named ".".
    const { server } = setup({ "/./stray.md": "x", "/t.csv": "a,b" });
    const root = await mnt(server);
    expect((await readdirNames(server, root)).sort()).toEqual([".metadata_never_index", "t.csv"]);
    expect(await readAll(server, (await lookup(server, root, "t.csv")).fh!)).toBe("a,b");
  });

  test("a folder that holds only a hidden entry is not empty: rmdir refuses it", async () => {
    const { server, drive } = setup({ "/d/./stray.md": "x" });
    const root = await mnt(server);
    expect(await readdirNames(server, (await lookup(server, root, "d")).fh!)).toEqual([]);
    const r = await rpc(server, 100003, 13, (w) => w.opaque(root).string("d"));
    expect(r.u32()).toBe(66); // NFS3ERR_NOTEMPTY
    expect(drive.text("/d/./stray.md")).toBe("x");
  });

  test("parallel READs of one file share a single download (macOS reads ahead 16 at a time)", async () => {
    const { server, drive } = setup({ "/big.bin": "0123456789abcdef" });
    const fh = (await lookup(server, await mnt(server), "big.bin")).fh!;
    let release!: () => void;
    drive.readGate = new Promise<void>((r) => (release = r));
    const downloads = () => drive.calls.filter((c) => c === "read /big.bin");
    const reads = [0, 4, 8, 12].map((offset) => readAt(server, fh, offset, 4));
    // Not a timing wait: up to the gate a READ only awaits resolved promises, so one
    // macrotask turn brings all four there. Without sharing, four downloads wait here.
    await Bun.sleep(5);
    expect(downloads()).toHaveLength(1);
    release();
    expect(await Promise.all(reads)).toEqual(["0123", "4567", "89ab", "cdef"]);
    expect(downloads()).toHaveLength(1);
  });

  test("a file larger than the cache downloads once for a sequential read, and leaves when another file is read", async () => {
    const drive = new MemDrive({ "/big.bin": "0123456789", "/s.txt": "ab" });
    const server = new NfsServer(new Vfs(drive, { cacheBytes: 4, listTtlMs: 0, log: () => {} }), { log: () => {} });
    const root = await mnt(server);
    const big = (await lookup(server, root, "big.bin")).fh!;
    const small = (await lookup(server, root, "s.txt")).fh!;
    const downloads = () => drive.calls.filter((c) => c === "read /big.bin").length;
    expect([await readAt(server, big, 0, 4), await readAt(server, big, 4, 4), await readAt(server, big, 8, 4)]).toEqual(["0123", "4567", "89"]);
    expect(downloads()).toBe(1);
    // The cache stays bounded: the next file takes the place of the large one.
    expect(await readAt(server, small, 0, 4)).toBe("ab");
    expect(await readAt(server, big, 0, 4)).toBe("0123");
    expect(downloads()).toBe(2);
  });

  test("a folder shows the mount time, not 1970: the drive stores no time for it", async () => {
    const before = Date.now();
    const { vfs, drive } = setup({ "/notes/a.md": "# A" });
    const list = drive.list.bind(drive);
    drive.list = async (dir) => (await list(dir)).map((e) => (e.type === "directory" ? { ...e, mtimeMs: 0 } : e));
    expect((await vfs.attr("/")).mtimeMs).toBeGreaterThanOrEqual(before);
    expect((await vfs.attr("/notes")).mtimeMs).toBeGreaterThanOrEqual(before);
    expect((await vfs.attr("/notes/a.md")).mtimeMs).toBe(1_700_000_000_000);
  });

  test("MNT of a sub-folder roots the export there; a missing one is refused", async () => {
    const { server } = setup({ "/notes/a.md": "# A" });
    const notes = await mnt(server, "/notes");
    expect(await readdirNames(server, notes)).toEqual(["a.md"]);
    const r = await rpc(server, 100005, 1, (w) => w.string("/nope"));
    expect(r.u32()).toBe(2);
  });

  test("overwrite (truncate + write) uploads only on COMMIT, with the exact bytes", async () => {
    const { server, drive } = setup({ "/a.md": "old content that is long" });
    const root = await mnt(server);
    const fh = (await lookup(server, root, "a.md")).fh!;
    const sr = await rpc(server, 100003, 2, (w) =>
      w.opaque(fh).u32(0).u32(0).u32(0).u32(1).u64(0).u32(0).u32(0).u32(0)
    );
    expect(sr.u32()).toBe(0);
    await write(server, fh, 0, "new");
    await write(server, fh, 3, " text");
    expect(drive.text("/a.md")).toBe("old content that is long");
    expect(await readAll(server, fh)).toBe("new text");
    expect(await commit(server, fh)).toBe(0);
    expect(drive.text("/a.md")).toBe("new text");
    expect(drive.calls.filter((c) => c.startsWith("write"))).toEqual(["write /a.md new text"]);
  });

  test("a partial write keeps the rest of the file", async () => {
    const { server, drive } = setup({ "/a.md": "hello world" });
    const root = await mnt(server);
    const fh = (await lookup(server, root, "a.md")).fh!;
    await write(server, fh, 6, "WORLD");
    await commit(server, fh);
    expect(drive.text("/a.md")).toBe("hello WORLD");
  });

  test("a new file uploads after the idle timer without COMMIT", async () => {
    const { server, drive } = setup({}, 20);
    const root = await mnt(server);
    const { fh } = await create(server, root, "new.md");
    await write(server, fh!, 0, "draft");
    await Bun.sleep(80);
    expect(drive.text("/new.md")).toBe("draft");
  });

  test("GUARDED and EXCLUSIVE create refuse an existing file; UNCHECKED reuses it", async () => {
    const { server } = setup({ "/a.md": "x" });
    const root = await mnt(server);
    expect((await create(server, root, "a.md", 1)).status).toBe(17);
    expect((await create(server, root, "a.md", 2)).status).toBe(17);
    expect((await create(server, root, "a.md", 0)).status).toBe(0);
  });

  test("Finder metadata files stay in memory and never reach the drive", async () => {
    const { server, drive, vfs } = setup({ "/a.md": "x" }, 10);
    const root = await mnt(server);
    for (const name of [".DS_Store", "._a.md"]) {
      const { fh } = await create(server, root, name);
      await write(server, fh!, 0, "meta");
      expect(await commit(server, fh!)).toBe(0);
    }
    await Bun.sleep(40);
    expect([...drive.files.keys()]).toEqual(["/a.md"]);
    expect((await readdirNames(server, root)).sort()).toEqual([".DS_Store", "._a.md", ".metadata_never_index", "a.md"]);
    expect(vfs.pending()).toEqual([]);
  });

  test(".Trashes is refused so Finder deletes instead of hiding files", async () => {
    const { server } = setup({});
    const root = await mnt(server);
    const r = await rpc(server, 100003, 9, (w) => w.opaque(root).string(".Trashes").u32(0).u32(0).u32(0).u32(0).u32(0).u32(0));
    expect(r.u32()).toBe(13);
  });

  test("rename moves on the drive and the old handle follows the file", async () => {
    const { server, drive } = setup({ "/a.md": "body" });
    const root = await mnt(server);
    const fh = (await lookup(server, root, "a.md")).fh!;
    const r = await rpc(server, 100003, 14, (w) => w.opaque(root).string("a.md").opaque(root).string("b.md"));
    expect(r.u32()).toBe(0);
    expect(drive.calls).toContain("mv /a.md /b.md");
    expect(await readAll(server, fh)).toBe("body");
    expect((await lookup(server, root, "a.md")).status).toBe(2);
  });

  test("rename of an unsaved buffer uploads it first (atomic-save pattern)", async () => {
    const { server, drive } = setup({ "/a.md": "v1" });
    const root = await mnt(server);
    const { fh } = await create(server, root, "a.md.tmp");
    await write(server, fh!, 0, "v2");
    const r = await rpc(server, 100003, 14, (w) => w.opaque(root).string("a.md.tmp").opaque(root).string("a.md"));
    expect(r.u32()).toBe(0);
    expect(drive.text("/a.md")).toBe("v2");
    expect(drive.files.has("/a.md.tmp")).toBe(false);
  });

  test("mkdir, write inside, then the folder exists on the drive", async () => {
    const { server, drive } = setup({});
    const root = await mnt(server);
    const r = await rpc(server, 100003, 9, (w) => w.opaque(root).string("docs").u32(0).u32(0).u32(0).u32(0).u32(0).u32(0));
    expect(r.u32()).toBe(0);
    r.bool();
    const docs = r.opaque();
    const { fh } = await create(server, docs, "x.md");
    await write(server, fh!, 0, "x");
    await commit(server, fh!);
    expect(drive.text("/docs/x.md")).toBe("x");
  });

  test("remove deletes on the drive", async () => {
    const { server, drive } = setup({ "/a.md": "x" });
    const root = await mnt(server);
    const r = await rpc(server, 100003, 12, (w) => w.opaque(root).string("a.md"));
    expect(r.u32()).toBe(0);
    expect(drive.files.has("/a.md")).toBe(false);
  });

  test("a handle from an earlier server run is STALE, never another file", async () => {
    const first = setup({ "/a.md": "x" });
    const fh = (await lookup(first.server, await mnt(first.server), "a.md")).fh!;
    const second = setup({ "/a.md": "x" });
    const r = await rpc(second.server, 100003, 1, (w) => w.opaque(fh));
    expect(r.u32()).toBe(70);
  });

  test("a failed upload fails COMMIT so the client reports the error", async () => {
    const { server, drive } = setup({ "/a.md": "x" });
    drive.write = async () => {
      throw new Error("permission denied");
    };
    const root = await mnt(server);
    const fh = (await lookup(server, root, "a.md")).fh!;
    await write(server, fh, 0, "y");
    expect(await commit(server, fh)).toBe(5);
  });

  test("a failed upload is retried in the background until it lands", async () => {
    const { server, drive } = setup({ "/a.md": "x" });
    const realWrite = drive.write.bind(drive);
    let failures = 2;
    drive.write = async (p, b) => {
      if (failures-- > 0) throw new Error("server unavailable");
      return realWrite(p, b);
    };
    const root = await mnt(server);
    const fh = (await lookup(server, root, "a.md")).fh!;
    await write(server, fh, 0, "y");
    expect(await commit(server, fh)).toBe(5);
    await Bun.sleep(120);
    expect(drive.text("/a.md")).toBe("y");
  });

  test("speaks record-marked RPC over TCP, including multi-fragment records", async () => {
    const { server } = setup({ "/a.md": "x" });
    const port = await server.listen(0);
    try {
      const record = call(100003, 0, () => {});
      const reply = await new Promise<Buffer>((resolve, reject) => {
        const sock = connect(port, "127.0.0.1", () => {
          // Two fragments: the first without the last-fragment bit.
          const a = record.subarray(0, 8);
          const b = record.subarray(8);
          const h1 = Buffer.alloc(4);
          h1.writeUInt32BE(a.length);
          const h2 = Buffer.alloc(4);
          h2.writeUInt32BE((0x80000000 | b.length) >>> 0);
          sock.write(Buffer.concat([h1, a]));
          sock.write(Buffer.concat([h2, b]));
        });
        sock.once("data", (d: Buffer) => {
          sock.end();
          resolve(d);
        });
        sock.once("error", reject);
      });
      expect(reply.readUInt32BE(0) & 0x80000000).not.toBe(0);
      const r = new XdrReader(new Uint8Array(reply.subarray(4)));
      r.u32();
      expect(r.u32()).toBe(1);
      expect(r.u32()).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe("write durability and ordering against the drive", () => {
  test("DATA_SYNC and FILE_SYNC writes reply only after the upload lands; UNSTABLE stays buffered", async () => {
    const { server, drive } = setup({ "/a.md": "old" });
    const fh = (await lookup(server, await mnt(server), "a.md")).fh!;
    expect(await stableWrite(server, fh, "buf", 0)).toEqual({ status: 0, committed: 0 });
    expect(drive.text("/a.md")).toBe("old");

    for (const stable of [1, 2]) {
      const hold = holdUploads(drive);
      let settled = false;
      const reply = stableWrite(server, fh, `sy${stable}`, stable).finally(() => (settled = true));
      await hold.started;
      await Bun.sleep(10);
      expect(settled).toBe(false);
      hold.release();
      expect(await reply).toEqual({ status: 0, committed: 2 });
      expect(drive.text("/a.md")).toBe(`sy${stable}`);
    }
  });

  test("a FILE_SYNC write whose upload fails returns IO and keeps the bytes pending", async () => {
    const { server, drive, vfs } = setup({ "/a.md": "old" });
    const fh = (await lookup(server, await mnt(server), "a.md")).fh!;
    drive.write = async () => {
      throw new Error("permission denied");
    };
    expect((await stableWrite(server, fh, "new", 2)).status).toBe(5);
    expect(vfs.pending()).toEqual(["/a.md"]);
    expect(await readAll(server, fh)).toBe("new");
  });

  test("a failed remove keeps the unsaved bytes", async () => {
    const { drive, vfs } = setup({ "/a.md": "old" });
    await vfs.write("/a.md", 0, enc("new"));
    drive.failRemove = true;
    await expect(vfs.remove("/", "a.md")).rejects.toThrow("offline");
    expect(new TextDecoder().decode((await vfs.read("/a.md", 0, 10)).data)).toBe("new");
    expect(vfs.pending()).toEqual(["/a.md"]);
  });

  test("a failed rename keeps the target's unsaved bytes", async () => {
    const { drive, vfs } = setup({ "/src.md": "source", "/dst.md": "old" });
    await vfs.write("/dst.md", 0, enc("NEW"));
    drive.failMove = true;
    await expect(vfs.rename("/", "src.md", "/", "dst.md")).rejects.toThrow("offline");
    expect(new TextDecoder().decode((await vfs.read("/dst.md", 0, 10)).data)).toBe("NEW");
    expect(vfs.pending()).toEqual(["/dst.md"]);
  });

  test("rename over a file whose upload is running: the renamed file wins", async () => {
    const { drive, vfs } = setup({ "/target.md": "old", "/temp.md": "replacement" });
    await vfs.write("/target.md", 0, enc("STALE"));
    const hold = holdUploads(drive);
    const upload = vfs.flush("/target.md");
    await hold.started;
    const rename = vfs.rename("/", "temp.md", "/", "target.md");
    await Bun.sleep(10);
    hold.release();
    await Promise.all([upload, rename]);
    expect(drive.text("/target.md")).toBe("replacement");
    expect(drive.files.has("/temp.md")).toBe(false);
    expect(vfs.pending()).toEqual([]);
  });

  test("remove of a file whose upload is running: it stays deleted", async () => {
    const { drive, vfs } = setup({ "/a.md": "old" });
    await vfs.write("/a.md", 0, enc("new"));
    const hold = holdUploads(drive);
    const upload = vfs.flush("/a.md");
    await hold.started;
    const remove = vfs.remove("/", "a.md");
    await Bun.sleep(10);
    hold.release();
    await Promise.all([upload, remove]);
    expect(drive.files.has("/a.md")).toBe(false);
    expect(vfs.pending()).toEqual([]);
  });

  test("a write still loading the old bytes when remove arrives cannot bring the file back", async () => {
    const { drive, vfs } = setup({ "/a.md": "old" });
    const realRead = drive.read.bind(drive);
    let reading!: () => void;
    let releaseRead!: () => void;
    const started = new Promise<void>((r) => (reading = r));
    const held = new Promise<void>((r) => (releaseRead = r));
    drive.read = async (p) => {
      const bytes = await realRead(p);
      reading();
      await held;
      return bytes;
    };
    const write = vfs.write("/a.md", 0, enc("new")).catch(() => {});
    await started;
    const remove = vfs.remove("/", "a.md");
    await Bun.sleep(10);
    releaseRead();
    await Promise.all([write, remove]);
    await vfs.flushAll();
    expect(drive.files.has("/a.md")).toBe(false);
    expect(vfs.pending()).toEqual([]);
  });

  test("renaming an unsaved folder moves its idle uploads to the new path", async () => {
    const { drive, vfs } = setup({}, 15);
    await vfs.mkdir("/", "folder");
    await vfs.create("/folder", "new.md", false);
    await vfs.write("/folder/new.md", 0, enc("new"));
    await vfs.rename("/", "folder", "/", "renamed");
    await Bun.sleep(80);
    expect(drive.text("/renamed/new.md")).toBe("new");
    expect(drive.files.has("/folder/new.md")).toBe(false);
    expect(vfs.pending()).toEqual([]);
  });

  test("a truncate waiting behind remove cannot bring the file back empty", async () => {
    const { drive, vfs } = setup({ "/a.md": "old" });
    const realRemove = drive.remove.bind(drive);
    let removing!: () => void;
    let releaseRemove!: () => void;
    const started = new Promise<void>((r) => (removing = r));
    const held = new Promise<void>((r) => (releaseRemove = r));
    drive.remove = async (p) => {
      removing();
      await held;
      return realRemove(p);
    };
    const remove = vfs.remove("/", "a.md");
    await started;
    const truncate = vfs.setSize("/a.md", 0).then(
      () => "ok",
      (e) => e.status,
    );
    await Bun.sleep(10);
    releaseRemove();
    await remove;
    expect(await truncate).toBe(70); // NFS3ERR_STALE
    await vfs.flushAll();
    expect(drive.files.has("/a.md")).toBe(false);
    expect(vfs.pending()).toEqual([]);
  });

  test("a file made while a folder rename checks the drive lands in the moved folder", async () => {
    const { drive, vfs } = setup({});
    await vfs.mkdir("/", "a");
    await vfs.mkdir("/a", "sub");
    const realList = drive.list.bind(drive);
    let listing!: () => void;
    let releaseList!: () => void;
    const started = new Promise<void>((r) => (listing = r));
    const held = new Promise<void>((r) => (releaseList = r));
    let hold = true;
    drive.list = async (p) => {
      if (p === "/a" && hold) {
        hold = false;
        listing();
        await held;
      }
      return realList(p);
    };
    const rename = vfs.rename("/", "a", "/", "b");
    await started;
    // Namespace changes run one at a time: the create waits for the rename, then follows its folder.
    const create = vfs.create("/a/sub", "child.md", false);
    releaseList();
    await rename;
    const { path } = await create;
    expect(path).toBe("/b/sub/child.md");
    await vfs.write(path, 0, enc("new"));
    await vfs.flushAll();
    expect(drive.text("/b/sub/child.md")).toBe("new");
    expect(drive.files.has("/a/sub/child.md")).toBe(false);
    expect(vfs.pending()).toEqual([]);
  });

  test("a create still checking its folder when the folder is renamed lands in the moved folder", async () => {
    const { drive, vfs } = setup({});
    await vfs.mkdir("/", "a");
    await vfs.mkdir("/a", "sub");
    const realList = drive.list.bind(drive);
    let listing!: () => void;
    let releaseList!: () => void;
    const started = new Promise<void>((r) => (listing = r));
    const held = new Promise<void>((r) => (releaseList = r));
    let subLists = 0;
    drive.list = async (p) => {
      // The second look at /a/sub is the one create makes while holding the file's lock.
      if (p === "/a/sub" && ++subLists === 2) {
        listing();
        await held;
      }
      return realList(p);
    };
    const create = vfs.create("/a/sub", "child.md", false).then(
      () => "ok",
      (e) => e.status,
    );
    await started;
    const rename = vfs.rename("/", "a", "/", "b");
    releaseList();
    expect(await create).toBe("ok");
    await rename;
    await vfs.flushAll();
    expect([...drive.files.keys()]).toEqual(["/b/sub/child.md"]);
    expect(vfs.pending()).toEqual([]);
  });

  test("a file renamed into a folder that is then renamed: the folder move waits and sees the stored file", async () => {
    const { drive, vfs } = setup({});
    await vfs.mkdir("/", "a");
    await vfs.mkdir("/a", "sub");
    await vfs.create("/", "f.md", false);
    await vfs.write("/f.md", 0, enc("mine"));
    const realList = drive.list.bind(drive);
    let listing!: () => void;
    let releaseList!: () => void;
    const started = new Promise<void>((r) => (listing = r));
    const held = new Promise<void>((r) => (releaseList = r));
    let hold = true;
    drive.list = async (p) => {
      if (p === "/a/sub" && hold) {
        hold = false;
        listing();
        await held;
      }
      return realList(p);
    };
    const move = vfs.rename("/", "f.md", "/a/sub", "f.md").then(
      () => "ok",
      (e) => e.status,
    );
    await started;
    const folder = vfs.rename("/", "a", "/", "b").then(
      () => "ok",
      (e) => e.status,
    );
    releaseList();
    expect(await move).toBe("ok");
    // Serial order: the folder now holds a stored file, and stored folders cannot move yet.
    expect(await folder).toBe(10004); // NFS3ERR_NOTSUPP
    await vfs.flushAll();
    expect([...drive.files.keys()]).toEqual(["/a/sub/f.md"]);
    expect(drive.text("/a/sub/f.md")).toBe("mine");
    expect(vfs.pending()).toEqual([]);
  });

  test("a stored file moving into a folder while the folder is renamed never lands outside what the folder shows", async () => {
    const { drive, vfs } = setup({ "/f.md": "mine" });
    await vfs.mkdir("/", "a");
    await vfs.mkdir("/a", "sub");
    const realMove = drive.move.bind(drive);
    let moving!: () => void;
    let releaseMove!: () => void;
    const started = new Promise<void>((r) => (moving = r));
    const held = new Promise<void>((r) => (releaseMove = r));
    drive.move = async (from, to) => {
      moving();
      await held;
      return realMove(from, to);
    };
    const move = vfs.rename("/", "f.md", "/a/sub", "f.md").then(
      () => "ok",
      (e) => e.status,
    );
    await started;
    const folder = vfs.rename("/", "a", "/", "b").then(
      () => "ok",
      (e) => e.status,
    );
    await Bun.sleep(10);
    releaseMove();
    expect(await move).toBe("ok");
    expect(await folder).toBe(10004); // NFS3ERR_NOTSUPP: /a now holds a stored file
    expect([...drive.files.keys()]).toEqual(["/a/sub/f.md"]);
    expect(drive.text("/a/sub/f.md")).toBe("mine");
    expect((await vfs.readdir("/a/sub")).map((e) => e.name)).toEqual(["f.md"]);
    expect(await vfs.lookup("/", "b").then(() => "found", (e) => e.status)).toBe(2); // NFS3ERR_NOENT
  });
});
