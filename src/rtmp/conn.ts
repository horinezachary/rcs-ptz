// One RTMP connection, either end: the handshake, chunk streams in both directions, the protocol control
// messages (chunk size, acknowledgements, window size, ping), and whole messages out. The server
// (server.ts) and the client (client.ts) put the NetConnection and NetStream commands on top.

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { decode, encode, type Amf } from './amf.js';

export const MSG = {
  SET_CHUNK_SIZE: 1,
  ABORT: 2,
  ACK: 3,
  USER_CONTROL: 4,
  WINDOW_ACK: 5,
  PEER_BW: 6,
  AUDIO: 8,
  VIDEO: 9,
  DATA_AMF3: 15,
  CMD_AMF3: 17,
  DATA: 18,
  CMD: 20
} as const;

export interface RtmpMessage {
  type: number;
  streamId: number;
  timestamp: number;
  body: Buffer;
}

const HANDSHAKE = 1536;
/** Larger messages are refused: nothing a camera sends comes near this. */
const MAX_MESSAGE = 16 * 1024 * 1024;
const MAX_CHUNK = 0xffffff;
export const OUT_CHUNK = 4096;
const WINDOW = 2_500_000;

interface InStream {
  timestamp: number;
  delta: number;
  length: number;
  type: number;
  streamId: number;
  extended: boolean;
  parts: Buffer[];
  got: number;
}

export class RtmpError extends Error {}

/**
 * Emits 'message' (RtmpMessage) for everything but protocol control, 'command' (name, args, message) for
 * AMF0 commands and data, 'ready' after the handshake, 'close' once.
 */
export class RtmpConnection extends EventEmitter {
  private buf: Buffer = Buffer.alloc(0);
  private phase: 'c0' | 'c2' | 's0' | 'open' = 'c0';
  private inChunk = 128;
  private outChunk = 128;
  private streams = new Map<number, InStream>();
  private received = 0;
  private acked = 0;
  private peerWindow = WINDOW;
  private closed = false;
  private s1: Buffer | null = null;
  private c1: Buffer | null = null;
  bytesIn = 0;

  constructor(
    readonly socket: Socket,
    readonly role: 'server' | 'client'
  ) {
    super();
    this.phase = role === 'server' ? 'c0' : 's0';
    socket.on('data', (d: Buffer) => {
      try {
        this.push(d);
      } catch (e) {
        this.fail((e as Error).message);
      }
    });
    socket.on('close', () => this.end());
    socket.on('error', (e) => this.fail(e.message));
    if (role === 'client') {
      this.c1 = Buffer.concat([Buffer.alloc(8), randomBytes(HANDSHAKE - 8)]);
      socket.write(Buffer.concat([Buffer.from([3]), this.c1]));
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.socket.destroy();
    this.end();
  }

  private fail(why: string): void {
    if (!this.closed) this.emit('error-text', why);
    this.close();
  }

  private end(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  private push(d: Buffer): void {
    this.bytesIn += d.length;
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (this.phase === 'c0') {
      if (this.buf.length < 1 + HANDSHAKE) return;
      if (this.buf[0] !== 3) throw new RtmpError(`RTMP version ${this.buf[0]} is not supported`);
      const c1 = this.buf.subarray(1, 1 + HANDSHAKE);
      this.s1 = Buffer.concat([Buffer.alloc(8), randomBytes(HANDSHAKE - 8)]);
      this.socket.write(Buffer.concat([Buffer.from([3]), this.s1, c1]));
      this.buf = this.buf.subarray(1 + HANDSHAKE);
      this.phase = 'c2';
    }
    if (this.phase === 'c2') {
      if (this.buf.length < HANDSHAKE) return;
      this.buf = this.buf.subarray(HANDSHAKE);
      this.phase = 'open';
      this.emit('ready');
    }
    if (this.phase === 's0') {
      if (this.buf.length < 1 + 2 * HANDSHAKE) return;
      if (this.buf[0] !== 3) throw new RtmpError(`RTMP version ${this.buf[0]} is not supported`);
      const s1 = this.buf.subarray(1, 1 + HANDSHAKE);
      this.socket.write(Buffer.from(s1));
      this.buf = this.buf.subarray(1 + 2 * HANDSHAKE);
      this.phase = 'open';
      this.emit('ready');
    }
    if (this.phase === 'open') this.chunks();
  }

  private chunks(): void {
    let at = 0;
    const b = this.buf;
    for (;;) {
      const start = at;
      if (b.length - at < 1) break;
      const fmt = b[at]! >> 6;
      let csid = b[at]! & 0x3f;
      at++;
      if (csid === 0) {
        if (b.length - at < 1) break;
        csid = b[at]! + 64;
        at++;
      } else if (csid === 1) {
        if (b.length - at < 2) break;
        csid = b[at]! + b[at + 1]! * 256 + 64;
        at += 2;
      }
      const hlen = [11, 7, 3, 0][fmt]!;
      if (b.length - at < hlen) {
        at = start;
        break;
      }
      let s = this.streams.get(csid);
      if (!s) {
        if (fmt >= 2) throw new RtmpError(`Chunk stream ${csid} starts without a full header`);
        s = { timestamp: 0, delta: 0, length: 0, type: 0, streamId: 0, extended: false, parts: [], got: 0 };
      }
      const fresh = s.got === 0;
      let ts = 0;
      if (fmt <= 2) ts = b.readUIntBE(at, 3);
      let length = s.length,
        type = s.type,
        streamId = s.streamId;
      if (fmt <= 1) {
        length = b.readUIntBE(at + 3, 3);
        type = b[at + 6]!;
      }
      if (fmt === 0) streamId = b.readUInt32LE(at + 7);
      at += hlen;
      const extended = fmt <= 2 ? ts === 0xffffff : s.extended;
      if (extended) {
        if (b.length - at < 4) {
          at = start;
          break;
        }
        if (fmt <= 2) ts = b.readUInt32BE(at);
        at += 4;
      }
      if (length > MAX_MESSAGE) throw new RtmpError('RTMP message too large');
      const take = Math.min(this.inChunk, length - (fresh ? 0 : s.got));
      if (b.length - at < take) {
        at = start;
        break;
      }
      // Commit the header now the whole chunk is here.
      if (fmt === 0) {
        s.timestamp = ts;
        s.delta = 0;
      } else if (fmt <= 2) {
        if (fresh) {
          s.delta = ts;
          s.timestamp = (s.timestamp + ts) >>> 0;
        }
      } else if (fresh) s.timestamp = (s.timestamp + s.delta) >>> 0;
      s.length = length;
      s.type = type;
      s.streamId = streamId;
      s.extended = extended;
      this.streams.set(csid, s);
      s.parts.push(b.subarray(at, at + take));
      s.got += take;
      at += take;
      if (s.got >= s.length) {
        const body = s.parts.length === 1 ? Buffer.from(s.parts[0]!) : Buffer.concat(s.parts);
        s.parts = [];
        s.got = 0;
        this.message({ type: s.type, streamId: s.streamId, timestamp: s.timestamp, body });
        if (this.closed) return;
      }
    }
    this.buf = at >= b.length ? Buffer.alloc(0) : Buffer.from(b.subarray(at));
    this.received += at;
    if (this.received - this.acked >= this.peerWindow) {
      this.acked = this.received;
      const v = Buffer.alloc(4);
      v.writeUInt32BE(this.received >>> 0);
      this.send(MSG.ACK, 0, 0, v, 2);
    }
  }

  private message(m: RtmpMessage): void {
    switch (m.type) {
      case MSG.SET_CHUNK_SIZE: {
        const n = m.body.readUInt32BE(0) & 0x7fffffff;
        if (n < 1 || n > MAX_CHUNK) throw new RtmpError('Bad chunk size');
        this.inChunk = n;
        return;
      }
      case MSG.ABORT: {
        const s = this.streams.get(m.body.readUInt32BE(0));
        if (s) {
          s.parts = [];
          s.got = 0;
        }
        return;
      }
      case MSG.WINDOW_ACK:
        this.peerWindow = Math.max(1, m.body.readUInt32BE(0));
        return;
      case MSG.ACK:
      case MSG.PEER_BW:
        return;
      case MSG.USER_CONTROL: {
        const ev = m.body.readUInt16BE(0);
        if (ev === 6) {
          // Ping request: answer with the same timestamp.
          const r = Buffer.alloc(6);
          r.writeUInt16BE(7);
          m.body.copy(r, 2, 2, 6);
          this.send(MSG.USER_CONTROL, 0, 0, r, 2);
        }
        this.emit('user', ev, m.body.subarray(2));
        return;
      }
      case MSG.CMD:
      case MSG.DATA:
      case MSG.CMD_AMF3:
      case MSG.DATA_AMF3: {
        const body = m.type === MSG.CMD_AMF3 || m.type === MSG.DATA_AMF3 ? m.body.subarray(1) : m.body;
        let args: Amf[];
        try {
          args = decode(body);
        } catch {
          return;
        }
        const name = typeof args[0] === 'string' ? args[0] : '';
        this.emit('command', name, args.slice(1), m);
        return;
      }
      default:
        this.emit('message', m);
    }
  }

  /** Sends one message, split into chunks of the outgoing chunk size. */
  send(type: number, streamId: number, timestamp: number, body: Buffer, csid = 3): void {
    if (this.closed) return;
    const ext = timestamp >= 0xffffff;
    const h = Buffer.alloc(12 + (ext ? 4 : 0));
    h[0] = csid & 0x3f;
    h.writeUIntBE(ext ? 0xffffff : timestamp, 1, 3);
    h.writeUIntBE(body.length, 4, 3);
    h[7] = type;
    h.writeUInt32LE(streamId, 8);
    if (ext) h.writeUInt32BE(timestamp >>> 0, 12);
    const parts: Buffer[] = [h];
    for (let at = 0; at < body.length || at === 0; at += this.outChunk) {
      if (at > 0) {
        const c = Buffer.alloc(ext ? 5 : 1);
        c[0] = 0xc0 | (csid & 0x3f);
        if (ext) c.writeUInt32BE(timestamp >>> 0, 1);
        parts.push(c);
      }
      parts.push(body.subarray(at, at + this.outChunk));
      if (body.length === 0) break;
    }
    this.socket.write(Buffer.concat(parts));
  }

  setChunkSize(n = OUT_CHUNK): void {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    this.send(MSG.SET_CHUNK_SIZE, 0, 0, b, 2);
    this.outChunk = n;
  }

  windowAck(n = WINDOW): void {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    this.send(MSG.WINDOW_ACK, 0, 0, b, 2);
  }

  peerBandwidth(n = WINDOW): void {
    const b = Buffer.alloc(5);
    b.writeUInt32BE(n);
    b[4] = 2;
    this.send(MSG.PEER_BW, 0, 0, b, 2);
  }

  userControl(event: number, value: number): void {
    const b = Buffer.alloc(6);
    b.writeUInt16BE(event);
    b.writeUInt32BE(value, 2);
    this.send(MSG.USER_CONTROL, 0, 0, b, 2);
  }

  command(streamId: number, name: string, ...args: Amf[]): void {
    this.send(MSG.CMD, streamId, 0, encode(name, ...args), streamId ? 8 : 3);
  }

  data(streamId: number, ...args: Amf[]): void {
    this.send(MSG.DATA, streamId, 0, encode(...args), 4);
  }
}

/** rtmp://host[:port]/app[/more]/stream → its parts. The stream name is the last path segment, with any query. */
export function parseRtmpUrl(url: string): { host: string; port: number; app: string; stream: string; tcUrl: string } | null {
  const m = /^rtmp:\/\/(\[[^\]]+\]|[^/:?#]+)(?::(\d+))?\/(.+)$/i.exec(url.trim());
  if (!m) return null;
  const path = m[3]!;
  const q = path.indexOf('?');
  const base = q >= 0 ? path.slice(0, q) : path;
  const query = q >= 0 ? path.slice(q) : '';
  const cut = base.lastIndexOf('/');
  if (cut <= 0) return null;
  const app = base.slice(0, cut);
  const stream = base.slice(cut + 1) + query;
  if (!stream) return null;
  const host = m[1]!.replace(/^\[|\]$/g, '');
  const port = m[2] ? Number(m[2]) : 1935;
  if (port < 1 || port > 65535) return null;
  return { host, port, app, stream, tcUrl: `rtmp://${m[1]}${m[2] ? ':' + m[2] : ''}/${app}` };
}
