// Fragmented MP4 for Media Source Extensions: an init segment from the stream's avcC, then one fragment per
// frame. Video only, one track, millisecond timescale.

const box = (type: string, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
const full = (type: string, version: number, flags: number, ...parts: Buffer[]): Buffer => {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0);
  return box(type, vf, ...parts);
};
const u32 = (...v: number[]): Buffer => {
  const b = Buffer.alloc(v.length * 4);
  v.forEach((x, i) => b.writeUInt32BE(x >>> 0, i * 4));
  return b;
};
const u16 = (...v: number[]): Buffer => {
  const b = Buffer.alloc(v.length * 2);
  v.forEach((x, i) => b.writeUInt16BE(x & 0xffff, i * 2));
  return b;
};
const zeros = (n: number) => Buffer.alloc(n);
const MATRIX = u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);

/** MSE codec string, as video/mp4; codecs="avc1.42c033", from the avcC's profile, constraints and level. */
export function mimeOf(avcC: Buffer): string {
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `video/mp4; codecs="avc1.${hex(avcC[1] ?? 0x42)}${hex(avcC[2] ?? 0)}${hex(avcC[3] ?? 0x1f)}"`;
}

export function initSegment(avcC: Buffer, width: number, height: number): Buffer {
  const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), u32(0x200), Buffer.from('isomiso6avc1mp41', 'latin1'));
  const mvhd = full('mvhd', 0, 0, u32(0, 0, 1000, 0, 0x10000), u16(0x100), zeros(10), MATRIX, zeros(24), u32(2));
  const tkhd = full('tkhd', 0, 3, u32(0, 0, 1, 0, 0), zeros(8), u16(0, 0, 0), u16(0), MATRIX, u32(width << 16, height << 16));
  const mdhd = full('mdhd', 0, 0, u32(0, 0, 1000, 0), u16(0x55c4, 0));
  const hdlr = full('hdlr', 0, 0, u32(0), Buffer.from('vide', 'latin1'), zeros(12), Buffer.from('Video\0', 'latin1'));
  const avc1 = box(
    'avc1',
    zeros(6),
    u16(1), // data reference index
    zeros(16),
    u16(width, height),
    u32(0x480000, 0x480000, 0),
    u16(1),
    zeros(32), // compressor name
    u16(0x18, 0xffff),
    box('avcC', avcC)
  );
  const stbl = box(
    'stbl',
    full('stsd', 0, 0, u32(1), avc1),
    full('stts', 0, 0, u32(0)),
    full('stsc', 0, 0, u32(0)),
    full('stsz', 0, 0, u32(0, 0)),
    full('stco', 0, 0, u32(0))
  );
  const minf = box('minf', full('vmhd', 0, 1, u16(0, 0, 0, 0)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl);
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
  const mvex = box('mvex', full('trex', 0, 0, u32(1, 1, 0, 0, 0)));
  return Buffer.concat([ftyp, box('moov', mvhd, trak, mvex)]);
}

/** One frame as a movie fragment: moof + mdat. */
export function fragment(seq: number, frame: { dts: number; cts: number; key: boolean; data: Buffer }, duration: number): Buffer {
  const flags = frame.key ? 0x02000000 : 0x01010000;
  const trun = (offset: number) => full('trun', 1, 0x000f01, u32(1, offset, duration, frame.data.length, flags, frame.cts));
  const make = (offset: number) =>
    box(
      'moof',
      full('mfhd', 0, 0, u32(seq)),
      box('traf', full('tfhd', 0, 0x020000, u32(1)), full('tfdt', 1, 0, u32(Math.floor(frame.dts / 2 ** 32), frame.dts % 2 ** 32)), trun(offset))
    );
  const size = make(0).length;
  return Buffer.concat([make(size + 8), box('mdat', frame.data)]);
}
