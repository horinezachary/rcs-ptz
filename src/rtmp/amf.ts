// AMF0, as RTMP command and data messages carry it: numbers, booleans, strings, objects, null, ECMA and
// strict arrays. Enough for connect, createStream, publish, play, onStatus and onMetaData.

export type Amf = number | boolean | string | null | undefined | Amf[] | { [k: string]: Amf } | Date;

export class AmfError extends Error {}

export function encode(...values: Amf[]): Buffer {
  const parts: Buffer[] = [];
  for (const v of values) write(v, parts);
  return Buffer.concat(parts);
}

function str(s: string, parts: Buffer[]): void {
  const b = Buffer.from(s, 'utf8');
  const h = Buffer.alloc(2);
  h.writeUInt16BE(Math.min(b.length, 0xffff));
  parts.push(h, b.subarray(0, 0xffff));
}

function write(v: Amf, parts: Buffer[]): void {
  if (typeof v === 'number') {
    const b = Buffer.alloc(9);
    b[0] = 0;
    b.writeDoubleBE(v, 1);
    parts.push(b);
  } else if (typeof v === 'boolean') parts.push(Buffer.from([1, v ? 1 : 0]));
  else if (typeof v === 'string') {
    parts.push(Buffer.from([2]));
    str(v, parts);
  } else if (v === null) parts.push(Buffer.from([5]));
  else if (v === undefined) parts.push(Buffer.from([6]));
  else if (v instanceof Date) {
    const b = Buffer.alloc(11);
    b[0] = 11;
    b.writeDoubleBE(v.getTime(), 1);
    parts.push(b);
  } else if (Array.isArray(v)) {
    const h = Buffer.alloc(5);
    h[0] = 10;
    h.writeUInt32BE(v.length, 1);
    parts.push(h);
    for (const x of v) write(x, parts);
  } else {
    parts.push(Buffer.from([3]));
    for (const [k, x] of Object.entries(v)) {
      str(k, parts);
      write(x, parts);
    }
    parts.push(Buffer.from([0, 0, 9]));
  }
}

export function decode(buf: Buffer): Amf[] {
  const out: Amf[] = [];
  const at = { i: 0 };
  while (at.i < buf.length) out.push(read(buf, at, 0));
  return out;
}

function need(buf: Buffer, at: { i: number }, n: number): void {
  if (at.i + n > buf.length) throw new AmfError('AMF0 value runs past the message');
}

function readStr(buf: Buffer, at: { i: number }, long = false): string {
  need(buf, at, long ? 4 : 2);
  const n = long ? buf.readUInt32BE(at.i) : buf.readUInt16BE(at.i);
  at.i += long ? 4 : 2;
  need(buf, at, n);
  const s = buf.toString('utf8', at.i, at.i + n);
  at.i += n;
  return s;
}

function readProps(buf: Buffer, at: { i: number }, depth: number): Record<string, Amf> {
  const o: Record<string, Amf> = {};
  for (;;) {
    const k = readStr(buf, at);
    need(buf, at, 1);
    if (k === '' && buf[at.i] === 9) {
      at.i++;
      return o;
    }
    o[k] = read(buf, at, depth + 1);
  }
}

function read(buf: Buffer, at: { i: number }, depth: number): Amf {
  if (depth > 32) throw new AmfError('AMF0 nested too deep');
  need(buf, at, 1);
  const t = buf[at.i++]!;
  switch (t) {
    case 0: {
      need(buf, at, 8);
      const n = buf.readDoubleBE(at.i);
      at.i += 8;
      return n;
    }
    case 1:
      need(buf, at, 1);
      return buf[at.i++] !== 0;
    case 2:
      return readStr(buf, at);
    case 3:
      return readProps(buf, at, depth);
    case 5:
      return null;
    case 6:
      return undefined;
    case 8:
      need(buf, at, 4);
      at.i += 4; // the count is a hint; the list ends like an object
      return readProps(buf, at, depth);
    case 10: {
      need(buf, at, 4);
      const n = buf.readUInt32BE(at.i);
      at.i += 4;
      if (n > 65536) throw new AmfError('AMF0 array too long');
      const a: Amf[] = [];
      for (let k = 0; k < n; k++) a.push(read(buf, at, depth + 1));
      return a;
    }
    case 11: {
      need(buf, at, 10);
      const d = new Date(buf.readDoubleBE(at.i));
      at.i += 10;
      return d;
    }
    case 12:
      return readStr(buf, at, true);
    default:
      throw new AmfError(`AMF0 type ${t} is not supported`);
  }
}
