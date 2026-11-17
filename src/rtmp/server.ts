// The unit's RTMP receiver: cameras push their stream to rtmp://<unit>:1935/live/<stream key>, and each key
// that belongs to a camera in the module feeds that camera's LiveStream. Publish only: nothing can play from
// here (the ONVIF bridge serves RTSP for that). An unknown key is refused.

import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { LiveStream } from '../video/stream.js';
import { parseVideoTag } from '../video/flv.js';
import { MSG, RtmpConnection } from './conn.js';

export const RTMP_APP = 'live';

export class RtmpServer extends EventEmitter {
  private server: net.Server | null = null;
  private conns = new Set<RtmpConnection>();
  /** stream key → the connection publishing it now */
  private publishers = new Map<string, RtmpConnection>();
  port = 0;
  error = '';

  constructor(private readonly lookup: (key: string) => LiveStream | null) {
    super();
  }

  async listen(port: number, host = '0.0.0.0'): Promise<number> {
    await this.close();
    const server = net.createServer((s) => this.accept(s));
    this.server = server;
    await new Promise<void>((resolve) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        this.error = e.code === 'EADDRINUSE' ? `Port ${port} is in use` : e.code === 'EACCES' ? `Port ${port} needs more rights` : e.message;
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
    for (const c of this.conns) c.close();
    this.conns.clear();
    this.publishers.clear();
    const s = this.server;
    this.server = null;
    this.port = 0;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  /** Who is publishing which key: for Setup. */
  publishing(): Map<string, string> {
    const m = new Map<string, string>();
    for (const [k, c] of this.publishers) m.set(k, c.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '');
    return m;
  }

  /** Drops whoever publishes this key (the camera was removed or its key changed). */
  kick(key: string): void {
    this.publishers.get(key)?.close();
  }

  private accept(socket: net.Socket): void {
    socket.setNoDelay(true);
    socket.setTimeout(30_000, () => socket.destroy());
    const c = new RtmpConnection(socket, 'server');
    this.conns.add(c);
    const peer = socket.remoteAddress?.replace(/^::ffff:/, '') ?? '?';
    let app = '';
    let key = '';
    let stream: LiveStream | null = null;
    let publishId = 0;

    c.on('command', (name: string, args: any[], m) => {
      const txn = typeof args[0] === 'number' ? args[0] : 0;
      switch (name) {
        case 'connect': {
          const o = args[1] && typeof args[1] === 'object' ? args[1] : {};
          app = String(o.app ?? '').replace(/\/+$/, '');
          c.windowAck();
          c.peerBandwidth();
          c.setChunkSize();
          if (app !== RTMP_APP) {
            c.command(0, '_error', txn, null, { level: 'error', code: 'NetConnection.Connect.Rejected', description: `Use the app "${RTMP_APP}"` });
            setTimeout(() => c.close(), 200);
            return;
          }
          c.command(0, '_result', txn, { fmsVer: 'FMS/3,5,7,7009', capabilities: 31 }, { level: 'status', code: 'NetConnection.Connect.Success', description: 'Connection succeeded.', objectEncoding: 0 });
          return;
        }
        case 'releaseStream':
        case 'FCPublish':
          c.command(0, '_result', txn, null);
          return;
        case 'createStream':
          c.command(0, '_result', txn, null, 1);
          return;
        case 'publish': {
          const name = typeof args[2] === 'string' ? args[2] : '';
          const k = name.split('?')[0]!;
          const s = this.lookup(k);
          publishId = m.streamId || 1;
          if (!s) {
            c.command(publishId, 'onStatus', 0, null, { level: 'error', code: 'NetStream.Publish.BadName', description: 'No camera in the module has this stream key' });
            this.emit('refused', k, peer);
            setTimeout(() => c.close(), 200);
            return;
          }
          // A new push for the same key wins: a camera that reconnects before its old connection times out.
          const old = this.publishers.get(k);
          if (old && old !== c) old.close();
          key = k;
          stream = s;
          this.publishers.set(k, c);
          socket.setTimeout(15_000, () => socket.destroy());
          s.setSource(`push from ${peer}`);
          c.userControl(0, publishId); // stream begin
          c.command(publishId, 'onStatus', 0, null, { level: 'status', code: 'NetStream.Publish.Start', description: `${name} is now published.` });
          this.emit('publish', k, peer);
          return;
        }
        case 'FCUnpublish':
        case 'deleteStream':
        case 'closeStream':
          if (stream) {
            stream.ended('The camera stopped pushing');
            this.publishers.delete(key);
            stream = null;
            this.emit('unpublish', key);
          }
          return;
        case 'play':
          c.command(m.streamId || 1, 'onStatus', 0, null, { level: 'error', code: 'NetStream.Play.Failed', description: 'This receiver takes pushed streams only' });
          setTimeout(() => c.close(), 200);
          return;
        default:
          if (txn) c.command(0, '_result', txn, null);
      }
    });

    c.on('message', (m) => {
      if (!stream || this.publishers.get(key) !== c) return;
      if (m.type !== MSG.VIDEO) return; // audio is not used
      const ok = parseVideoTag(
        m.timestamp,
        m.body,
        (cfg) => stream!.config(cfg.avcC),
        (f) => stream!.frame(f)
      );
      if (!ok) stream.setCodec(m.body[0]! & 0x80 ? 'HEVC (Enhanced RTMP)' : `codec ${m.body[0]! & 0x0f}`);
    });

    c.on('close', () => {
      this.conns.delete(c);
      if (stream && this.publishers.get(key) === c) {
        this.publishers.delete(key);
        stream.ended('The camera stopped pushing');
        this.emit('unpublish', key);
      }
    });
  }
}
