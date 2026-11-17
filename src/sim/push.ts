// Pushes sim/cam.flv to an RTMP URL in a loop at real time, as a camera set to stream RTMP does: the
// simulator's way of feeding the module's receiver. Reconnects when the receiver goes away.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RtmpPublisher } from '../rtmp/client.js';

export interface Tag {
  ts: number;
  body: Buffer;
}

export function flvTags(file: Buffer): Tag[] {
  const tags: Tag[] = [];
  let at = file.readUInt32BE(5) + 4;
  while (at + 11 <= file.length) {
    const type = file[at]! & 0x1f;
    const size = file.readUIntBE(at + 1, 3);
    const ts = (file.readUIntBE(at + 4, 3) | (file[at + 7]! << 24)) >>> 0;
    if (at + 11 + size > file.length) break;
    if (type === 9) tags.push({ ts, body: file.subarray(at + 11, at + 11 + size) });
    at += 11 + size + 4;
  }
  return tags;
}

export const SIM_VIDEO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'sim', 'cam.flv');

export class SimPusher {
  private pub: RtmpPublisher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private tags: Tag[];
  connected = false;

  constructor(
    readonly url: string,
    file = SIM_VIDEO
  ) {
    this.tags = flvTags(readFileSync(file));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pub?.stop();
    this.pub = null;
    this.connected = false;
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    const pub = new RtmpPublisher(this.url);
    this.pub = pub;
    try {
      await pub.start();
    } catch {
      if (this.running) this.timer = setTimeout(() => void this.connect(), 2000);
      return;
    }
    this.connected = true;
    pub.on('close', () => {
      this.connected = false;
      if (this.timer) clearTimeout(this.timer);
      if (this.running && this.pub === pub) this.timer = setTimeout(() => void this.connect(), 2000);
    });
    const config = this.tags.find((t) => t.body[1] === 0)!;
    const frames = this.tags.filter((t) => t.body[1] === 1);
    const span = frames[frames.length - 1]!.ts + 40;
    const t0 = Date.now();
    pub.video(0, config.body);
    let i = 0;
    let loop = 0;
    const next = () => {
      if (!this.running || this.pub !== pub || !pub.ready) return;
      const f = frames[i]!;
      const ts = loop * span + f.ts;
      pub.video(ts, f.body);
      i++;
      if (i >= frames.length) {
        i = 0;
        loop++;
      }
      const due = t0 + loop * span + frames[i]!.ts - Date.now();
      this.timer = setTimeout(next, Math.max(0, due));
    };
    next();
  }
}
