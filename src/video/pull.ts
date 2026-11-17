// Pulling a camera's picture from somewhere else: rtmp:// from a media server, or http(s):// HTTP-FLV (some
// cameras and every nginx-flv/SRS server offer it). A pushed stream needs none of this: the RTMP receiver
// feeds it.

import http from 'node:http';
import https from 'node:https';
import { RtmpPuller } from '../rtmp/client.js';
import { FlvReader } from './flv.js';
import type { LiveStream } from './stream.js';

export interface Puller {
  start(): void;
  stop(): void;
}

const RETRY_MS = 3000;
const STALL_MS = 10_000;

export class FlvPuller implements Puller {
  private req: http.ClientRequest | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stall: NodeJS.Timeout | null = null;
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
    this.open();
  }

  stop(): void {
    this.running = false;
    this.close();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  private close(): void {
    if (this.stall) clearTimeout(this.stall);
    this.stall = null;
    this.req?.destroy();
    this.req = null;
  }

  private again(why: string): void {
    this.close();
    this.stream.ended(why);
    if (!this.running || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.running) this.open();
    }, RETRY_MS);
  }

  private kick(): void {
    if (this.stall) clearTimeout(this.stall);
    this.stall = setTimeout(() => this.again('The stream stalled'), STALL_MS);
  }

  private open(): void {
    let u: URL;
    try {
      u = new URL(this.url);
    } catch {
      return this.again('Not a valid address');
    }
    this.stream.setSource(`pull ${u.protocol}//${u.host}${u.pathname}`);
    let first = -1;
    this.base = this.last + 40;
    const reader = new FlvReader(
      (c) => this.stream.config(c.avcC),
      (f) => {
        if (first < 0) first = f.dts;
        const dts = this.base + (f.dts - first);
        this.last = dts;
        this.stream.frame({ ...f, dts });
      }
    );
    const get = u.protocol === 'https:' ? https.get : http.get;
    const req = get(u, { headers: { Accept: 'video/x-flv' }, rejectUnauthorized: false }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return this.again(`HTTP ${res.statusCode}`);
      }
      this.kick();
      res.on('data', (chunk: Buffer) => {
        this.kick();
        try {
          reader.push(chunk);
        } catch (e) {
          this.again((e as Error).message);
        }
      });
      res.on('end', () => this.again('The stream ended'));
      res.on('error', (e) => this.again(e.message));
    });
    req.on('error', (e: NodeJS.ErrnoException) => this.again(e.code === 'ECONNREFUSED' ? 'Connection refused' : e.message));
    this.req = req;
  }
}

export function pullerFor(url: string, stream: LiveStream): Puller | null {
  if (/^rtmp:\/\//i.test(url)) return new RtmpPuller(url, stream);
  if (/^https?:\/\//i.test(url)) return new FlvPuller(url, stream);
  return null;
}
