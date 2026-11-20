// The filesystem the NFS server exposes: one agent-fs drive, held in memory.
//
// Nothing touches local disk. Reads fetch the whole file into a bounded RAM
// cache; writes collect in a RAM buffer per file and upload on NFS COMMIT
// (the client sends it on close) or after FLUSH_IDLE_MS of quiet.
// macOS metadata files (.DS_Store, ._*) stay in memory and never upload.

import { randomBytes } from "node:crypto";

export const NFS3_OK = 0;
export const NFS3ERR_NOENT = 2;
export const NFS3ERR_IO = 5;
export const NFS3ERR_ACCES = 13;
export const NFS3ERR_EXIST = 17;
export const NFS3ERR_NOTDIR = 20;
export const NFS3ERR_ISDIR = 21;
export const NFS3ERR_INVAL = 22;
export const NFS3ERR_NAMETOOLONG = 63;
export const NFS3ERR_NOTEMPTY = 66;
export const NFS3ERR_STALE = 70;
export const NFS3ERR_BADHANDLE = 10001;
export const NFS3ERR_NOTSUPP = 10004;

export class FsError extends Error {
  constructor(public status: number, message = `NFS status ${status}`) {
    super(message);
  }
}

export interface DriveEntry {
  name: string;
  type: "file" | "directory";
  size: number;
  mtimeMs: number;
}

/** The agent-fs calls the filesystem needs. Paths are absolute ("/a/b.md"). */
export interface DriveApi {
  /** Immediate children; [] when the folder does not exist. */
  list(path: string): Promise<DriveEntry[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
}

export interface Attr {
  id: number;
  type: "file" | "directory";
  size: number;
  mtimeMs: number;
}

export interface VfsOptions {
  listTtlMs?: number;
  flushIdleMs?: number;
  retryMs?: number;
  cacheBytes?: number;
  log?: (msg: string) => void;
}

interface Dirty {
  buf: Uint8Array;
  len: number;
  gen: number;
  flushedGen: number;
  mtimeMs: number;
  localOnly: boolean;
  timer?: ReturnType<typeof setTimeout>;
  flushing?: Promise<void>;
}

interface Listing {
  at: number;
  entries: Map<string, DriveEntry>;
}

interface Cached {
  bytes: Uint8Array;
  size: number;
  mtimeMs: number;
}

const ROOT_ID = 1;
// Finder and Spotlight litter every volume with these; keep them off the drive.
const LOCAL_ONLY = /^(\._.*|\.DS_Store|\.Spotlight-V100|\.fseventsd|\.TemporaryItems|\.metadata_never_index)$/;
// Refusing .Trashes makes Finder offer "delete immediately" instead of
// moving files into a hidden folder that would never reach agent-fs.
const REFUSED = /^\.Trashes$/;

export function isLocalOnly(path: string): boolean {
  return path.split("/").some((seg) => LOCAL_ONLY.test(seg));
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export class Vfs {
  /** 8 random bytes per server run: handles from an earlier run are STALE, never mis-mapped. */
  readonly boot = randomBytes(8);
  private paths = new Map<number, string>([[ROOT_ID, "/"]]);
  private ids = new Map<string, number>([["/", ROOT_ID]]);
  private nextId = ROOT_ID + 1;
  private listings = new Map<string, Listing>();
  private listingLoads = new Map<string, Promise<Listing>>();
  private content = new Map<string, Cached>();
  private contentBytes = 0;
  private dirty = new Map<string, Dirty>();
  private dirtyLoads = new Map<string, Promise<Dirty>>();
  private virtualDirs = new Set<string>();
  private listTtlMs: number;
  private flushIdleMs: number;
  private retryMs: number;
  private cacheBytes: number;
  private log: (msg: string) => void;

  constructor(private api: DriveApi, opts: VfsOptions = {}) {
    this.listTtlMs = opts.listTtlMs ?? 2_000;
    this.flushIdleMs = opts.flushIdleMs ?? 2_000;
    this.retryMs = opts.retryMs ?? 10_000;
    this.cacheBytes = opts.cacheBytes ?? 256 * 1024 * 1024;
    this.log = opts.log ?? ((m) => console.error(m));
    // Spotlight skips a volume with this file at its root; indexing would download the whole drive.
    this.dirty.set("/.metadata_never_index", {
      buf: new Uint8Array(0),
      len: 0,
      gen: 0,
      flushedGen: 0,
      mtimeMs: Date.now(),
      localOnly: true,
    });
  }

  // ---- handles -----------------------------------------------------------

  idFor(path: string): number {
    let id = this.ids.get(path);
    if (id === undefined) {
      id = this.nextId++;
      this.ids.set(path, id);
      this.paths.set(id, path);
    }
    return id;
  }

  handle(path: string): Uint8Array {
    const fh = new Uint8Array(16);
    fh.set(this.boot, 0);
    new DataView(fh.buffer).setBigUint64(8, BigInt(this.idFor(path)));
    return fh;
  }

  pathOf(fh: Uint8Array): string {
    if (fh.length !== 16) throw new FsError(NFS3ERR_BADHANDLE);
    for (let i = 0; i < 8; i++) if (fh[i] !== this.boot[i]) throw new FsError(NFS3ERR_STALE);
    const id = Number(new DataView(fh.buffer, fh.byteOffset, 16).getBigUint64(8));
    const path = this.paths.get(id);
    if (path === undefined) throw new FsError(NFS3ERR_STALE);
    return path;
  }

  child(dir: string, name: string): string {
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
      throw new FsError(NFS3ERR_INVAL, `bad name: ${name}`);
    }
    if (new TextEncoder().encode(name).length > 255) throw new FsError(NFS3ERR_NAMETOOLONG);
    return dir === "/" ? `/${name}` : `${dir}/${name}`;
  }

  // ---- metadata ----------------------------------------------------------

  private async listing(dir: string): Promise<Listing> {
    const cached = this.listings.get(dir);
    if (cached && Date.now() - cached.at < this.listTtlMs) return cached;
    let load = this.listingLoads.get(dir);
    if (!load) {
      load = (async () => {
        const entries = isLocalOnly(dir) ? [] : await this.api.list(dir);
        const listing = { at: Date.now(), entries: new Map(entries.map((e) => [e.name, e])) };
        this.listings.set(dir, listing);
        return listing;
      })().finally(() => this.listingLoads.delete(dir));
      this.listingLoads.set(dir, load);
    }
    return load;
  }

  private dropListing(dir: string): void {
    this.listings.delete(dir);
  }

  async attr(path: string): Promise<Attr> {
    if (path === "/") return { id: ROOT_ID, type: "directory", size: 0, mtimeMs: 0 };
    const d = this.dirty.get(path);
    if (d) return { id: this.idFor(path), type: "file", size: d.len, mtimeMs: d.mtimeMs };
    if (this.virtualDirs.has(path)) return { id: this.idFor(path), type: "directory", size: 0, mtimeMs: 0 };
    const e = (await this.listing(parentOf(path))).entries.get(baseName(path));
    if (!e) throw new FsError(NFS3ERR_NOENT);
    return { id: this.idFor(path), type: e.type, size: e.size, mtimeMs: e.mtimeMs };
  }

  private async exists(path: string): Promise<Attr | null> {
    try {
      return await this.attr(path);
    } catch (err) {
      if (err instanceof FsError && err.status === NFS3ERR_NOENT) return null;
      throw err;
    }
  }

  private async requireDir(path: string): Promise<void> {
    if ((await this.attr(path)).type !== "directory") throw new FsError(NFS3ERR_NOTDIR);
  }

  async lookup(dir: string, name: string): Promise<{ path: string; attr: Attr }> {
    await this.requireDir(dir);
    const path = this.child(dir, name);
    return { path, attr: await this.attr(path) };
  }

  async readdir(dir: string): Promise<Array<{ name: string; attr: Attr }>> {
    await this.requireDir(dir);
    const names = new Set((await this.listing(dir)).entries.keys());
    const prefix = dir === "/" ? "/" : `${dir}/`;
    for (const p of [...this.dirty.keys(), ...this.virtualDirs]) {
      if (p.startsWith(prefix) && !p.slice(prefix.length).includes("/")) names.add(p.slice(prefix.length));
    }
    const out: Array<{ name: string; attr: Attr }> = [];
    for (const name of [...names].sort()) {
      const attr = await this.exists(this.child(dir, name));
      if (attr) out.push({ name, attr });
    }
    return out;
  }

  // ---- data --------------------------------------------------------------

  private async fetch(path: string, attr: Attr): Promise<Uint8Array> {
    const hit = this.content.get(path);
    // A cached copy stays valid while the drive still reports the same size + mtime.
    if (hit && hit.size === attr.size && hit.mtimeMs === attr.mtimeMs) {
      this.content.delete(path);
      this.content.set(path, hit);
      return hit.bytes;
    }
    const bytes = await this.api.read(path);
    this.remember(path, bytes, attr.mtimeMs);
    return bytes;
  }

  private remember(path: string, bytes: Uint8Array, mtimeMs: number): void {
    this.forget(path);
    if (bytes.length > this.cacheBytes) return;
    this.content.set(path, { bytes, size: bytes.length, mtimeMs });
    this.contentBytes += bytes.length;
    for (const [p, c] of this.content) {
      if (this.contentBytes <= this.cacheBytes) break;
      this.content.delete(p);
      this.contentBytes -= c.bytes.length;
    }
  }

  private forget(path: string): void {
    const c = this.content.get(path);
    if (c) {
      this.content.delete(path);
      this.contentBytes -= c.bytes.length;
    }
  }

  async read(path: string, offset: number, count: number): Promise<{ data: Uint8Array; eof: boolean; attr: Attr }> {
    const attr = await this.attr(path);
    if (attr.type === "directory") throw new FsError(NFS3ERR_ISDIR);
    const d = this.dirty.get(path);
    const bytes = d ? d.buf.subarray(0, d.len) : await this.fetch(path, attr);
    const end = Math.min(bytes.length, offset + count);
    const data = offset >= bytes.length ? new Uint8Array(0) : bytes.slice(offset, end);
    return { data, eof: end >= bytes.length, attr };
  }

  /** The RAM write buffer for a file, loading its current bytes on first use. */
  private async dirtyFor(path: string, keepContent: boolean): Promise<Dirty> {
    const existing = this.dirty.get(path);
    if (existing) return existing;
    let load = this.dirtyLoads.get(path);
    if (!load) {
      load = (async () => {
        const attr = await this.exists(path);
        if (attr?.type === "directory") throw new FsError(NFS3ERR_ISDIR);
        const bytes = attr && keepContent ? await this.fetch(path, attr) : new Uint8Array(0);
        const raced = this.dirty.get(path);
        if (raced) return raced;
        const d: Dirty = {
          buf: bytes.slice(),
          len: bytes.length,
          gen: 0,
          flushedGen: 0,
          mtimeMs: Date.now(),
          localOnly: isLocalOnly(path),
        };
        this.dirty.set(path, d);
        return d;
      })().finally(() => this.dirtyLoads.delete(path));
      this.dirtyLoads.set(path, load);
    }
    return load;
  }

  private resize(d: Dirty, len: number): void {
    if (len > d.buf.length) {
      const next = new Uint8Array(Math.max(len, d.buf.length * 2, 4096));
      next.set(d.buf.subarray(0, d.len));
      d.buf = next;
    } else if (len < d.len) {
      d.buf.fill(0, len, d.len);
    }
    d.len = len;
  }

  private touched(path: string, d: Dirty): void {
    d.gen++;
    d.mtimeMs = Date.now();
    if (!d.localOnly) this.schedule(path, d, this.flushIdleMs);
  }

  private schedule(path: string, d: Dirty, delayMs: number): void {
    if (d.timer) clearTimeout(d.timer);
    d.timer = setTimeout(() => {
      d.timer = undefined;
      this.flush(path).catch(() => {});
    }, delayMs);
  }

  async write(path: string, offset: number, data: Uint8Array): Promise<Attr> {
    const d = await this.dirtyFor(path, true);
    if (offset + data.length > d.len) this.resize(d, offset + data.length);
    d.buf.set(data, offset);
    this.touched(path, d);
    return this.attr(path);
  }

  async setSize(path: string, size: number): Promise<Attr> {
    const attr = await this.attr(path);
    if (attr.type === "directory") throw new FsError(NFS3ERR_ISDIR);
    if (attr.size === size && !this.dirty.has(path)) return attr;
    const d = await this.dirtyFor(path, size > 0);
    this.resize(d, size);
    this.touched(path, d);
    return this.attr(path);
  }

  async create(dir: string, name: string, exclusive: boolean): Promise<{ path: string; attr: Attr }> {
    await this.requireDir(dir);
    const path = this.child(dir, name);
    if (REFUSED.test(name)) throw new FsError(NFS3ERR_ACCES);
    const found = await this.exists(path);
    if (found) {
      if (exclusive || found.type === "directory") throw new FsError(NFS3ERR_EXIST);
      return { path, attr: found };
    }
    const d = await this.dirtyFor(path, false);
    this.touched(path, d);
    return { path, attr: await this.attr(path) };
  }

  async mkdir(dir: string, name: string): Promise<{ path: string; attr: Attr }> {
    await this.requireDir(dir);
    const path = this.child(dir, name);
    if (REFUSED.test(name)) throw new FsError(NFS3ERR_ACCES);
    if (await this.exists(path)) throw new FsError(NFS3ERR_EXIST);
    // shortcut: object storage has no folders, so an empty one lives only in
    // this process until a file lands in it; upgrade with a server-side marker.
    this.virtualDirs.add(path);
    return { path, attr: await this.attr(path) };
  }

  async remove(dir: string, name: string): Promise<void> {
    const path = this.child(dir, name);
    const attr = await this.attr(path);
    if (attr.type === "directory") throw new FsError(NFS3ERR_ISDIR);
    const d = this.dirty.get(path);
    if (d?.timer) clearTimeout(d.timer);
    this.dirty.delete(path);
    const onServer = (await this.listing(dir)).entries.has(name);
    if (onServer && !isLocalOnly(path)) await this.api.remove(path);
    this.forget(path);
    this.dropListing(dir);
    this.dropId(path);
  }

  async rmdir(dir: string, name: string): Promise<void> {
    const path = this.child(dir, name);
    const attr = await this.attr(path);
    if (attr.type !== "directory") throw new FsError(NFS3ERR_NOTDIR);
    if ((await this.readdir(path)).length > 0) throw new FsError(NFS3ERR_NOTEMPTY);
    this.virtualDirs.delete(path);
    this.dropId(path);
  }

  async rename(fromDir: string, fromName: string, toDir: string, toName: string): Promise<void> {
    const from = this.child(fromDir, fromName);
    const to = this.child(toDir, toName);
    if (from === to) return;
    await this.requireDir(toDir);
    if (REFUSED.test(toName)) throw new FsError(NFS3ERR_ACCES);
    const attr = await this.attr(from);
    const target = await this.exists(to);
    if (target?.type === "directory" && attr.type !== "directory") throw new FsError(NFS3ERR_ISDIR);

    if (attr.type === "directory") {
      // shortcut: only folders that exist solely in memory can move; moving a
      // stored folder needs a server-side prefix move.
      if (!this.virtualDirs.has(from) || (await this.listing(from)).entries.size > 0) {
        throw new FsError(NFS3ERR_NOTSUPP, "renaming a stored folder is not supported yet");
      }
      if (target) throw new FsError(NFS3ERR_EXIST);
      for (const p of [...this.virtualDirs]) {
        if (p === from || p.startsWith(`${from}/`)) {
          this.virtualDirs.delete(p);
          this.virtualDirs.add(to + p.slice(from.length));
        }
      }
      for (const [p, d] of [...this.dirty]) {
        if (p.startsWith(`${from}/`)) {
          this.dirty.delete(p);
          this.dirty.set(to + p.slice(from.length), d);
        }
      }
      this.moveId(from, to);
      return;
    }

    const td = this.dirty.get(to);
    if (td?.timer) clearTimeout(td.timer);
    this.dirty.delete(to);

    const d = this.dirty.get(from);
    if (d?.localOnly || (d && isLocalOnly(to))) {
      // Memory-only on at least one side: move the buffer, upload if it became a real file.
      this.dirty.delete(from);
      d.localOnly = isLocalOnly(to);
      this.dirty.set(to, d);
      if (!d.localOnly) {
        d.flushedGen = -1;
        this.touched(to, d);
      }
    } else if (isLocalOnly(to)) {
      throw new FsError(NFS3ERR_ACCES);
    } else {
      if (d) await this.flush(from);
      await this.api.move(from, to);
      // A write that landed during the upload follows the file to its new name.
      const raced = this.dirty.get(from);
      if (raced) {
        this.dirty.delete(from);
        this.dirty.set(to, raced);
        raced.flushedGen = -1;
        this.touched(to, raced);
      }
    }
    const moved = this.content.get(from);
    this.forget(from);
    this.forget(to);
    if (moved) this.remember(to, moved.bytes, moved.mtimeMs);
    this.dropListing(fromDir);
    this.dropListing(toDir);
    this.dropId(to);
    this.moveId(from, to);
  }

  private moveId(from: string, to: string): void {
    for (const [p, id] of [...this.ids]) {
      if (p === from || p.startsWith(`${from}/`)) {
        const np = to + p.slice(from.length);
        this.ids.delete(p);
        this.ids.set(np, id);
        this.paths.set(id, np);
      }
    }
  }

  private dropId(path: string): void {
    const id = this.ids.get(path);
    if (id !== undefined && id !== ROOT_ID) {
      this.ids.delete(path);
      this.paths.delete(id);
    }
  }

  // ---- durability --------------------------------------------------------

  /** Upload a file's RAM buffer now. Resolves once the drive holds those bytes. */
  async flush(path: string): Promise<void> {
    for (;;) {
      const d = this.dirty.get(path);
      if (!d || d.localOnly) return;
      if (d.flushing) {
        await d.flushing.catch(() => {});
        continue;
      }
      if (d.gen === d.flushedGen) return;
      if (d.timer) {
        clearTimeout(d.timer);
        d.timer = undefined;
      }
      const gen = d.gen;
      const snapshot = d.buf.slice(0, d.len);
      d.flushing = this.api.write(path, snapshot);
      try {
        await d.flushing;
      } catch (err: any) {
        // Keep the bytes and retry; COMMIT still reports the failure to the client.
        this.log(`agent-fs nfs: upload of ${path} failed, retrying in ${this.retryMs / 1000}s: ${err.message}`);
        if (this.dirty.get(path) === d) this.schedule(path, d, this.retryMs);
        throw err;
      } finally {
        d.flushing = undefined;
      }
      d.flushedGen = gen;
      this.remember(path, snapshot, d.mtimeMs);
      const listing = this.listings.get(parentOf(path));
      listing?.entries.set(baseName(path), {
        name: baseName(path),
        type: "file",
        size: snapshot.length,
        mtimeMs: d.mtimeMs,
      });
      if (d.gen === gen && this.dirty.get(path) === d) {
        this.dirty.delete(path);
        if (!listing) this.dropListing(parentOf(path));
      }
      return;
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.dirty.keys()].map((p) => this.flush(p)));
  }

  /** Paths with bytes not yet on the drive (for shutdown warnings). */
  pending(): string[] {
    return [...this.dirty].filter(([, d]) => !d.localOnly && d.gen !== d.flushedGen).map(([p]) => p);
  }
}
