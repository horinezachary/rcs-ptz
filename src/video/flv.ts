// FLV video tags, as an HTTP-FLV stream carries them and as RTMP video messages carry their bodies: H.264 only.
// FlvReader takes an HTTP-FLV byte stream as it arrives; parseVideoTag takes one tag body (or RTMP message).

export interface AvcConfig {
  /** The AVCDecoderConfigurationRecord, as an MP4 avcC box holds it. */
  avcC: Buffer;
}

export interface AvcFrame {
  /** Decode time, ms. */
  dts: number;
  /** Composition offset, ms. */
  cts: number;
  key: boolean;
  /** Length-prefixed NAL units, as an MP4 sample holds them. */
  data: Buffer;
}

export class FlvError extends Error {}

const MAX_TAG = 8 * 1024 * 1024;

export class FlvReader {
  private buf: Buffer = Buffer.alloc(0);
  private headerDone = false;

  constructor(
    private readonly onConfig: (c: AvcConfig) => void,
    private readonly onFrame: (f: AvcFrame) => void
  ) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let at = 0;
    if (!this.headerDone) {
      if (this.buf.length < 13) return;
      if (this.buf.toString('latin1', 0, 3) !== 'FLV') throw new FlvError('Not an FLV stream');
      at = this.buf.readUInt32BE(5) + 4; // header, then PreviousTagSize0
      this.headerDone = true;
    }
    while (this.buf.length - at >= 11) {
      const type = this.buf[at]! & 0x1f;
      const size = this.buf.readUIntBE(at + 1, 3);
      if (size > MAX_TAG) throw new FlvError('FLV tag too large');
      if (this.buf.length - at < 11 + size + 4) break;
      const ts = (this.buf.readUIntBE(at + 4, 3) | (this.buf[at + 7]! << 24)) >>> 0;
      if (type === 9) this.video(ts, this.buf.subarray(at + 11, at + 11 + size));
      at += 11 + size + 4;
    }
    this.buf = at >= this.buf.length ? Buffer.alloc(0) : Buffer.from(this.buf.subarray(at));
  }

  private video(ts: number, d: Buffer): void {
    parseVideoTag(ts, d, this.onConfig, this.onFrame);
  }
}

/** One FLV video tag body. Returns false when it is not H.264 (HEVC, VP6 and the rest are left out). */
export function parseVideoTag(ts: number, d: Buffer, onConfig: (c: AvcConfig) => void, onFrame: (f: AvcFrame) => void): boolean {
  if (d.length < 5) return true;
  if ((d[0]! & 0x0f) !== 7 || d[0]! & 0x80) return false; // AVC only (bit 7 marks Enhanced RTMP: HEVC, AV1)
  const key = d[0]! >> 4 === 1;
  const packet = d[1]!;
  if (packet === 0) {
    onConfig({ avcC: Buffer.from(d.subarray(5)) });
    return true;
  }
  if (packet !== 1) return true;
  const cts = d.readIntBE(2, 3);
  onFrame({ dts: ts, cts, key, data: Buffer.from(d.subarray(5)) });
  return true;
}

/** Width and height from an avcC's first SPS, or null. */
export function avcSize(avcC: Buffer): { width: number; height: number } | null {
  try {
    if (avcC.length < 8) return null;
    const n = avcC.readUInt16BE(6);
    const sps = avcC.subarray(8, 8 + n);
    return spsSize(sps);
  } catch {
    return null;
  }
}

/** The SPS (with its NAL header byte) and PPS from an avcC, for SDP and Annex B. */
export function avcParams(avcC: Buffer): { sps: Buffer[]; pps: Buffer[] } {
  const sps: Buffer[] = [];
  const pps: Buffer[] = [];
  let at = 5;
  const ns = (avcC[at++] ?? 0) & 0x1f;
  for (let i = 0; i < ns && at + 2 <= avcC.length; i++) {
    const n = avcC.readUInt16BE(at);
    sps.push(avcC.subarray(at + 2, at + 2 + n));
    at += 2 + n;
  }
  const np = avcC[at++] ?? 0;
  for (let i = 0; i < np && at + 2 <= avcC.length; i++) {
    const n = avcC.readUInt16BE(at);
    pps.push(avcC.subarray(at + 2, at + 2 + n));
    at += 2 + n;
  }
  return { sps, pps };
}

class Bits {
  private i = 0;
  constructor(private readonly b: Buffer) {}
  bit(): number {
    const v = (this.b[this.i >> 3]! >> (7 - (this.i & 7))) & 1;
    this.i++;
    return v;
  }
  bits(n: number): number {
    let v = 0;
    for (let k = 0; k < n; k++) v = v * 2 + this.bit();
    return v;
  }
  ue(): number {
    let z = 0;
    while (this.bit() === 0 && z < 32) z++;
    return 2 ** z - 1 + this.bits(z);
  }
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -k / 2;
  }
}

function spsSize(nal: Buffer): { width: number; height: number } | null {
  // Strip emulation prevention bytes.
  const raw: number[] = [];
  for (let i = 1; i < nal.length; i++) {
    if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    raw.push(nal[i]!);
  }
  const r = new Bits(Buffer.from(raw));
  const profile = r.bits(8);
  r.bits(16);
  r.ue();
  let chroma = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = r.ue();
    if (chroma === 3) r.bit();
    r.ue();
    r.ue();
    r.bit();
    if (r.bit()) {
      for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
        if (!r.bit()) continue;
        let last = 8,
          next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
          if (next !== 0) next = (last + r.se() + 256) % 256;
          last = next === 0 ? last : next;
        }
      }
    }
  }
  r.ue();
  const poc = r.ue();
  if (poc === 0) r.ue();
  else if (poc === 1) {
    r.bit();
    r.se();
    r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue();
  r.bit();
  const wmb = r.ue() + 1;
  const hmu = r.ue() + 1;
  const frameMbsOnly = r.bit();
  if (!frameMbsOnly) r.bit();
  r.bit();
  let cl = 0,
    cr = 0,
    ct = 0,
    cb = 0;
  if (r.bit()) {
    cl = r.ue();
    cr = r.ue();
    ct = r.ue();
    cb = r.ue();
  }
  const cx = chroma === 0 || chroma === 3 ? 1 : 2;
  const cy = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
  const width = wmb * 16 - (cl + cr) * cx;
  const height = hmu * 16 * (2 - frameMbsOnly) - (ct + cb) * cy;
  return width > 0 && height > 0 && width < 10000 && height < 10000 ? { width, height } : null;
}
