// The bridge's RTSP server: each camera's live stream as H.264 over RTP (RFC 6184, packetization mode 1),
// over TCP (interleaved) or UDP, at rtsp://<unit>:8554/<camera id>. The frames are the ones the camera sent,
// repacketized, never decoded. A login, when the bridge has one, is RTSP Digest (Basic also accepted).

import { createHash, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { avcParams, type AvcFrame } from '../video/flv.js';
import type { LiveStream } from '../video/stream.js';

const MTU = 1400;
const REALM = 'rcs-ptz';
/** A TCP client this far behind skips to the next keyframe. */
const MAX_QUEUE = 2 * 1024 * 1024;

export interface RtspSource {
  name: string;
  stream: LiveStream;
}

interface Session {
  id: string;
  cam: string;
  source: RtspSource | null;
  tcp: { rtp: number; rtcp: number } | null;
  udp: { sock: dgram.Socket; rtcp: dgram.Socket; host: string; rtp: number; rtcpPort: number; serverPorts: [number, number] } | null;
  playing: boolean;
  seq: number;
  ssrc: number;
  packets: number;
  octets: number;
  lastTs: number;
  skip: boolean;
  onFrame: ((f: AvcFrame) => void) | null;
  srTimer: NodeJS.Timeout | null;
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

export class RtspServer extends EventEmitter {
  private server: net.Server | null = null;
  private sessions = new Map<string, { s: Session; sock: net.Socket }>();
  private nonce = randomBytes(16).toString('hex');
  port = 0;
  error = '';

  constructor(
    private readonly lookup: (cam: string) => RtspSource | null,
    private readonly auth: () => { user: string; password: string } | null
  ) {
    super();
  }

  async listen(port: number, host = '0.0.0.0'): Promise<number> {
    await this.close();
    const server = net.createServer((s) => this.accept(s));
    this.server = server;
    await new Promise<void>((resolve) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        this.error = e.code === 'EADDRINUSE' ? `Port ${port} is in use` : e.message;
        this.server = null;
        resolve();
      });
      server.listen(port, host, () => {
        this.error = '';
        resolve();
      });
    });
    this.port = this.server ? (this.server.address() as net.AddressInfo).port : 0;
    return this.port;
  }

  async close(): Promise<void> {
    for (const { s, sock } of this.sessions.values()) {
      this.end(s);
      sock.destroy();
    }
    this.sessions.clear();
    const srv = this.server;
    this.server = null;
    this.port = 0;
    if (srv) await new Promise<void>((r) => srv.close(() => r()));
  }

  /** Cameras with an RTSP client playing now. */
  watching(): Set<string> {
    return new Set([...this.sessions.values()].filter((x) => x.s.playing).map((x) => x.s.cam));
  }

  private accept(sock: net.Socket): void {
    sock.setNoDelay(true);
    let buf = Buffer.alloc(0);
    const mine = new Set<string>();
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > 1_000_000) return sock.destroy();
      for (;;) {
        if (buf[0] === 0x24) {
          // Interleaved RTCP from the client: skip it.
          if (buf.length < 4) break;
          const n = buf.readUInt16BE(2);
          if (buf.length < 4 + n) break;
          buf = buf.subarray(4 + n);
          continue;
        }
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) break;
        const head = buf.toString('latin1', 0, end);
        const len = Number(/\r\ncontent-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
        if (buf.length < end + 4 + len) break;
        buf = buf.subarray(end + 4 + len);
        this.request(sock, head, mine);
      }
    });
    const gone = () => {
      for (const id of mine) {
        const x = this.sessions.get(id);
        if (x) this.end(x.s);
        this.sessions.delete(id);
      }
      this.emit('change');
    };
    sock.on('close', gone);
    sock.on('error', () => sock.destroy());
  }

  private reply(sock: net.Socket, cseq: string, status: string, headers: Record<string, string | number> = {}, body = ''): void {
    const h = [`RTSP/1.0 ${status}`, `CSeq: ${cseq}`, 'Server: rcs-ptz bridge', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
    if (body) h.push('Content-Length: ' + Buffer.byteLength(body));
    sock.write(h.join('\r\n') + '\r\n\r\n' + body);
  }

  private authorized(method: string, h: Record<string, string>): boolean {
    const a = this.auth();
    if (!a?.user) return true;
    const given = h['authorization'] ?? '';
    if (/^Basic /i.test(given)) return Buffer.from(given.slice(6), 'base64').toString('utf8') === `${a.user}:${a.password}`;
    if (!/^Digest /i.test(given)) return false;
    const f: Record<string, string> = {};
    for (const m of given.slice(7).matchAll(/(\w+)="?([^",]*)"?/g)) f[m[1]!] = m[2]!;
    if (f.username !== a.user || f.nonce !== this.nonce || f.realm !== REALM) return false;
    const ha1 = md5(`${a.user}:${REALM}:${a.password}`);
    const ha2 = md5(`${method}:${f.uri}`);
    return f.response === md5(`${ha1}:${f.nonce}:${ha2}`);
  }

  private request(sock: net.Socket, head: string, mine: Set<string>): void {
    const lines = head.split('\r\n');
    const [method = '', url = ''] = lines[0]!.split(' ');
    const h: Record<string, string> = {};
    for (const l of lines.slice(1)) {
      const i = l.indexOf(':');
      if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
    }
    const cseq = h['cseq'] ?? '0';
    if (method === 'OPTIONS') return this.reply(sock, cseq, '200 OK', { Public: 'OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN, GET_PARAMETER' });
    if (!this.authorized(method, h)) return this.reply(sock, cseq, '401 Unauthorized', { 'WWW-Authenticate': `Digest realm="${REALM}", nonce="${this.nonce}"` });
    let path = '';
    try {
      path = new URL(url).pathname;
    } catch {
      path = url;
    }
    const cam = path.split('/').filter(Boolean)[0] ?? '';
    switch (method) {
      case 'DESCRIBE': {
        const src = this.lookup(cam);
        if (!src) return this.reply(sock, cseq, '404 Not Found');
        const send = () => {
          if (!src.stream.avcC) return this.reply(sock, cseq, '503 Service Unavailable', {}, '');
          const local = sock.localAddress?.replace(/^::ffff:/, '') ?? '0.0.0.0';
          const sdp = this.sdp(src, local);
          this.reply(sock, cseq, '200 OK', { 'Content-Type': 'application/sdp', 'Content-Base': url.replace(/\/?$/, '/') }, sdp);
        };
        if (src.stream.avcC) return send();
        // Pulled streams start when watched: give the camera a moment to send its first keyframe.
        this.emit('want', cam);
        const t = setTimeout(send, 4000);
        src.stream.once('config', () => {
          clearTimeout(t);
          send();
        });
        return;
      }
      case 'SETUP': {
        const src = this.lookup(cam);
        if (!src) return this.reply(sock, cseq, '404 Not Found');
        const tr = h['transport'] ?? '';
        const id = (h['session'] ?? '').split(';')[0] || randomBytes(6).toString('hex');
        const s: Session = this.sessions.get(id)?.s ?? { id, cam, source: src, tcp: null, udp: null, playing: false, seq: Math.floor(Math.random() * 65535), ssrc: randomBytes(4).readUInt32BE(), packets: 0, octets: 0, lastTs: 0, skip: true, onFrame: null, srTimer: null };
        if (/TCP/i.test(tr)) {
          const m = /interleaved=(\d+)-(\d+)/.exec(tr);
          const a = m ? Number(m[1]) : 0;
          s.tcp = { rtp: a, rtcp: m ? Number(m[2]) : a + 1 };
          this.sessions.set(id, { s, sock });
          mine.add(id);
          return this.reply(sock, cseq, '200 OK', { Transport: `RTP/AVP/TCP;unicast;interleaved=${s.tcp.rtp}-${s.tcp.rtcp};ssrc=${s.ssrc.toString(16).padStart(8, '0')}`, Session: `${id};timeout=60` });
        }
        const m = /client_port=(\d+)-(\d+)/.exec(tr);
        if (!m) return this.reply(sock, cseq, '461 Unsupported Transport');
        const rtp = dgram.createSocket(sock.remoteFamily === 'IPv6' ? 'udp6' : 'udp4');
        const rtcp = dgram.createSocket(sock.remoteFamily === 'IPv6' ? 'udp6' : 'udp4');
        rtp.on('error', () => {});
        rtcp.on('error', () => {});
        Promise.all([new Promise<void>((r) => rtp.bind(0, () => r())), new Promise<void>((r) => rtcp.bind(0, () => r()))]).then(() => {
          const host = sock.remoteAddress?.replace(/^::ffff:/, '') ?? '';
          s.udp = { sock: rtp, rtcp, host, rtp: Number(m[1]), rtcpPort: Number(m[2]), serverPorts: [rtp.address().port, rtcp.address().port] };
          this.sessions.set(id, { s, sock });
          mine.add(id);
          this.reply(sock, cseq, '200 OK', { Transport: `RTP/AVP;unicast;client_port=${m[1]}-${m[2]};server_port=${s.udp.serverPorts[0]}-${s.udp.serverPorts[1]};ssrc=${s.ssrc.toString(16).padStart(8, '0')}`, Session: `${id};timeout=60` });
        });
        return;
      }
      case 'PLAY': {
        const id = (h['session'] ?? '').split(';')[0] ?? '';
        const x = this.sessions.get(id);
        if (!x) return this.reply(sock, cseq, '454 Session Not Found');
        this.reply(sock, cseq, '200 OK', { Session: id, Range: 'npt=0.000-', 'RTP-Info': `url=${url.replace(/\/$/, '')}/trackID=0;seq=${x.s.seq};rtptime=0` });
        this.play(x.s, sock);
        this.emit('change');
        return;
      }
      case 'TEARDOWN': {
        const id = (h['session'] ?? '').split(';')[0] ?? '';
        const x = this.sessions.get(id);
        if (x) {
          this.end(x.s);
          this.sessions.delete(id);
          mine.delete(id);
        }
        this.reply(sock, cseq, '200 OK', { Session: id });
        this.emit('change');
        return;
      }
      case 'GET_PARAMETER':
      case 'SET_PARAMETER':
        return this.reply(sock, cseq, '200 OK', h['session'] ? { Session: h['session'].split(';')[0]! } : {});
      default:
        return this.reply(sock, cseq, '405 Method Not Allowed', { Allow: 'OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN, GET_PARAMETER' });
    }
  }

  private sdp(src: RtspSource, local: string): string {
    const avcC = src.stream.avcC!;
    const { sps, pps } = avcParams(avcC);
    const pl = [avcC[1], avcC[2], avcC[3]].map((x) => (x ?? 0).toString(16).padStart(2, '0')).join('');
    const sets = [...sps, ...pps].map((b) => b.toString('base64')).join(',');
    return [
      'v=0',
      `o=- ${Date.now()} 1 IN IP4 ${local}`,
      `s=${src.name.replace(/[\r\n]/g, ' ')}`,
      'c=IN IP4 0.0.0.0',
      't=0 0',
      'a=control:*',
      'a=range:npt=0-',
      'm=video 0 RTP/AVP 96',
      'a=rtpmap:96 H264/90000',
      `a=fmtp:96 packetization-mode=1;profile-level-id=${pl};sprop-parameter-sets=${sets}`,
      `a=framesize:96 ${src.stream.width}-${src.stream.height}`,
      'a=control:trackID=0',
      ''
    ].join('\r\n');
  }

  private play(s: Session, sock: net.Socket): void {
    if (s.playing || !s.source) return;
    s.playing = true;
    const stream = s.source.stream;
    s.onFrame = (f) => this.sendFrame(s, sock, f);
    stream.on('frame', s.onFrame);
    for (const f of stream.gop) this.sendFrame(s, sock, f);
    s.srTimer = setInterval(() => this.senderReport(s, sock), 5000);
    s.srTimer.unref?.();
  }

  private end(s: Session): void {
    if (s.onFrame && s.source) s.source.stream.off('frame', s.onFrame);
    s.onFrame = null;
    s.playing = false;
    if (s.srTimer) clearInterval(s.srTimer);
    s.srTimer = null;
    if (s.udp) {
      try {
        s.udp.sock.close();
        s.udp.rtcp.close();
      } catch {}
      s.udp = null;
    }
  }

  private out(s: Session, sock: net.Socket, packet: Buffer, rtcp = false): void {
    if (s.tcp) {
      const h = Buffer.from([0x24, rtcp ? s.tcp.rtcp : s.tcp.rtp, 0, 0]);
      h.writeUInt16BE(packet.length, 2);
      sock.write(Buffer.concat([h, packet]));
    } else if (s.udp) {
      (rtcp ? s.udp.rtcp : s.udp.sock).send(packet, rtcp ? s.udp.rtcpPort : s.udp.rtp, s.udp.host, () => {});
    }
  }

  private sendFrame(s: Session, sock: net.Socket, f: AvcFrame): void {
    if (s.tcp && sock.writableLength > MAX_QUEUE) s.skip = true;
    if (s.skip && !f.key) return;
    s.skip = false;
    const nals: Buffer[] = [];
    for (let at = 0; at + 4 <= f.data.length; ) {
      const n = f.data.readUInt32BE(at);
      if (n <= 0 || at + 4 + n > f.data.length) break;
      nals.push(f.data.subarray(at + 4, at + 4 + n));
      at += 4 + n;
    }
    if (f.key && s.source?.stream.avcC && !nals.some((n) => (n[0]! & 0x1f) === 7)) {
      const { sps, pps } = avcParams(s.source.stream.avcC);
      nals.unshift(...sps, ...pps);
    }
    const ts = Math.round((f.dts + f.cts) * 90) >>> 0;
    s.lastTs = ts;
    nals.forEach((nal, i) => {
      const last = i === nals.length - 1;
      if (nal.length <= MTU) return this.rtp(s, sock, nal, ts, last);
      const hdr = nal[0]!;
      const fuInd = (hdr & 0xe0) | 28;
      for (let at = 1; at < nal.length; at += MTU) {
        const first = at === 1;
        const end = at + MTU >= nal.length;
        const fuHdr = (first ? 0x80 : 0) | (end ? 0x40 : 0) | (hdr & 0x1f);
        this.rtp(s, sock, Buffer.concat([Buffer.from([fuInd, fuHdr]), nal.subarray(at, at + MTU)]), ts, last && end);
      }
    });
  }

  private rtp(s: Session, sock: net.Socket, payload: Buffer, ts: number, marker: boolean): void {
    const h = Buffer.alloc(12);
    h[0] = 0x80;
    h[1] = (marker ? 0x80 : 0) | 96;
    h.writeUInt16BE(s.seq & 0xffff, 2);
    s.seq = (s.seq + 1) & 0xffff;
    h.writeUInt32BE(ts, 4);
    h.writeUInt32BE(s.ssrc, 8);
    s.packets++;
    s.octets += payload.length;
    this.out(s, sock, Buffer.concat([h, payload]));
  }

  private senderReport(s: Session, sock: net.Socket): void {
    const b = Buffer.alloc(28);
    b[0] = 0x80;
    b[1] = 200;
    b.writeUInt16BE(6, 2);
    b.writeUInt32BE(s.ssrc, 4);
    const ms = Date.now() + 2208988800000;
    b.writeUInt32BE(Math.floor(ms / 1000) >>> 0, 8);
    b.writeUInt32BE(Math.floor(((ms % 1000) / 1000) * 2 ** 32) >>> 0, 12);
    b.writeUInt32BE(s.lastTs, 16);
    b.writeUInt32BE(s.packets >>> 0, 20);
    b.writeUInt32BE(s.octets >>> 0, 24);
    this.out(s, sock, b, true);
  }
}
