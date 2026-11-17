// An RTMP client: plays a stream from an RTMP server into a LiveStream (a camera whose picture is on a media
// server already), or publishes FLV video tags to one (the simulator pushing to the module's receiver).

import { EventEmitter } from 'node:events';
import net from 'node:net';
import { parseVideoTag } from '../video/flv.js';
import type { LiveStream } from '../video/stream.js';
import { MSG, RtmpConnection, parseRtmpUrl } from './conn.js';

const RETRY_MS = 3000;
const STALL_MS = 10_000;

interface Session {
  conn: RtmpConnection;
  streamId: number;
}

function open(url: string, onReady: (s: Session) => void, onFail: (why: string) => void): RtmpConnection | null {
  const u = parseRtmpUrl(url);
  if (!u) {
    onFail('Not an rtmp:// address with an app and a stream name');
    return null;
  }
  const socket = net.connect({ host: u.host, port: u.port });
  socket.setNoDelay(true);
  socket.setTimeout(STALL_MS, () => {
    onFail('The server stopped answering');
    socket.destroy();
  });
  const conn = new RtmpConnection(socket, 'client');
  let txn = 1;
  const pending = new Map<number, (args: any[]) => void>();
  const call = (name: string, cb: (args: any[]) => void, ...args: any[]) => {
    const t = ++txn;
    pending.set(t, cb);
    conn.command(0, name, t, ...args);
  };
  conn.on('error-text', (why: string) => onFail(why));
  conn.on('ready', () => {
    conn.setChunkSize();
    pending.set(1, (args) => {
      const info = args[3];
      if (info?.code !== 'NetConnection.Connect.Success') return onFail(info?.description || 'The server refused the connection');
      conn.windowAck();
      call('createStream', (r) => {
        const id = typeof r[3] === 'number' ? r[3] : 1;
        onReady({ conn, streamId: id });
      }, null);
    });
    conn.command(0, 'connect', 1, { app: u.app, flashVer: 'FMLE/3.0 (compatible; rcs-ptz)', tcUrl: u.tcUrl, fpad: false, capabilities: 15, audioCodecs: 0x0fff, videoCodecs: 0xff, videoFunction: 1 });
  });
  conn.on('command', (name: string, args: any[]) => {
    const t = args[0];
    if ((name === '_result' || name === '_error') && typeof t === 'number' && pending.has(t)) {
      const cb = pending.get(t)!;
      pending.delete(t);
      if (name === '_error') return onFail(args[2]?.description || 'The server refused the request');
      cb([name, ...args]);
    }
  });
  socket.on('error', (e: NodeJS.ErrnoException) => onFail(e.code === 'ECONNREFUSED' ? 'Connection refused' : e.message));
  return conn;
}

/** Keeps playing an RTMP URL into a LiveStream until stopped, reconnecting when it drops. */
export class RtmpPuller {
  private conn: RtmpConnection | null = null;
  private retry: NodeJS.Timeout | null = null;
  private running = false;
  private base = 0;
  private last = 0;

  constructor(
    readonly url: string,
    private readonly stream: LiveStream
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.conn?.close();
    this.conn = null;
  }

  private again(why: string): void {
    this.conn?.close();
    this.conn = null;
    this.stream.ended(why);
    if (!this.running || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.running) this.connect();
    }, RETRY_MS);
  }

  private connect(): void {
    const u = parseRtmpUrl(this.url);
    this.stream.setSource(`pull ${u ? `rtmp://${u.host}${u.port === 1935 ? '' : ':' + u.port}/${u.app}/…` : this.url}`);
    let first = -1;
    this.base = this.last + 40;
    const conn = open(
      this.url,
      ({ conn, streamId }) => {
        conn.userControl(3, streamId); // buffer length follows; most servers don't need it
        conn.command(streamId, 'play', 0, null, u!.stream, -1000);
      },
      (why) => {
        if (this.conn === conn) this.again(why);
      }
    );
    if (!conn) return this.again('Not an rtmp:// address');
    this.conn = conn;
    conn.on('command', (name: string, args: any[]) => {
      if (name === 'onStatus') {
        const code = String(args[2]?.code ?? '');
        if (/Play\.(StreamNotFound|Failed)|Publish\.BadName/.test(code)) this.again(args[2]?.description || code);
        if (/Play\.(Stop|UnpublishNotify)/.test(code)) this.stream.ended('The stream stopped');
      }
    });
    conn.on('message', (m) => {
      if (m.type !== MSG.VIDEO) return;
      const ok = parseVideoTag(
        m.timestamp,
        m.body,
        (c) => this.stream.config(c.avcC),
        (f) => {
          if (first < 0) first = f.dts;
          const dts = this.base + (f.dts - first);
          this.last = dts;
          this.stream.frame({ ...f, dts });
        }
      );
      if (!ok) this.stream.setCodec(m.body[0]! & 0x80 ? 'HEVC (Enhanced RTMP)' : `codec ${m.body[0]! & 0x0f}`);
    });
    conn.on('close', () => {
      if (this.conn === conn) this.again('The server closed the stream');
    });
  }
}

/** Publishes FLV video tag bodies to an RTMP URL (the simulator, and tests). */
export class RtmpPublisher extends EventEmitter {
  private conn: RtmpConnection | null = null;
  private streamId = 0;
  ready = false;

  constructor(readonly url: string) {
    super();
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const u = parseRtmpUrl(this.url);
      const conn = open(
        this.url,
        ({ conn, streamId }) => {
          this.streamId = streamId;
          conn.command(0, 'releaseStream', 0, null, u!.stream);
          conn.command(0, 'FCPublish', 0, null, u!.stream);
          conn.command(streamId, 'publish', 0, null, u!.stream, 'live');
        },
        (why) => {
          if (!this.ready) reject(new Error(why));
          this.emit('error-text', why);
        }
      );
      if (!conn) return;
      this.conn = conn;
      conn.on('command', (name: string, args: any[]) => {
        if (name !== 'onStatus') return;
        const code = String(args[2]?.code ?? '');
        if (code === 'NetStream.Publish.Start') {
          this.ready = true;
          resolve();
        } else if (!this.ready) reject(new Error(args[2]?.description || code));
      });
      conn.on('close', () => {
        this.ready = false;
        this.emit('close');
      });
    });
  }

  video(timestamp: number, body: Buffer): void {
    if (this.ready && this.conn) this.conn.send(MSG.VIDEO, this.streamId, timestamp, body, 6);
  }

  meta(o: Record<string, number | string>): void {
    if (this.ready && this.conn) this.conn.data(this.streamId, '@setDataFrame', 'onMetaData', o);
  }

  stop(): void {
    this.conn?.close();
    this.conn = null;
    this.ready = false;
  }
}
