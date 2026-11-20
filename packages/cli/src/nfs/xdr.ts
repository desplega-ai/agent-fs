// Minimal XDR (RFC 4506) reader/writer for the ONC RPC / NFSv3 server.

export class XdrReader {
  private view: DataView;
  pos = 0;

  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  u32(): number {
    if (this.pos + 4 > this.buf.length) throw new RangeError("XDR underflow");
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  u64(): bigint {
    if (this.pos + 8 > this.buf.length) throw new RangeError("XDR underflow");
    const v = this.view.getBigUint64(this.pos);
    this.pos += 8;
    return v;
  }

  bool(): boolean {
    return this.u32() !== 0;
  }

  /** Fixed-length opaque (no length prefix). */
  fixed(len: number): Uint8Array {
    if (this.pos + len > this.buf.length) throw new RangeError("XDR underflow");
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len + ((4 - (len % 4)) % 4);
    return out;
  }

  opaque(max = 1 << 30): Uint8Array {
    const len = this.u32();
    if (len > max) throw new RangeError(`XDR opaque too long: ${len}`);
    return this.fixed(len);
  }

  string(max = 4096): string {
    return new TextDecoder().decode(this.opaque(max));
  }
}

export class XdrWriter {
  private chunks: Uint8Array[] = [];
  length = 0;

  private push(b: Uint8Array) {
    this.chunks.push(b);
    this.length += b.length;
  }

  u32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0);
    this.push(b);
    return this;
  }

  u64(v: bigint | number): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v));
    this.push(b);
    return this;
  }

  bool(v: boolean): this {
    return this.u32(v ? 1 : 0);
  }

  fixed(b: Uint8Array): this {
    this.push(b);
    const pad = (4 - (b.length % 4)) % 4;
    if (pad) this.push(new Uint8Array(pad));
    return this;
  }

  opaque(b: Uint8Array): this {
    this.u32(b.length);
    return this.fixed(b);
  }

  string(s: string): this {
    return this.opaque(new TextEncoder().encode(s));
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}
