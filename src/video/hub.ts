// Who is watching which camera on the panel and in web views. A view asks for the cameras it shows every few
// seconds; each camera's stream is repackaged as fragmented MP4 (no transcoding) and sent in UI messages. A
// viewer that hasn't asked again for a while gets nothing more, and a pulled stream nobody watches stops.

import { fragment, initSegment, mimeOf } from './fmp4.js';
import type { AvcFrame } from './flv.js';
import type { LiveStream } from './stream.js';

/** A viewer that hasn't asked again for this long has gone. */
export const VIEWER_TTL_MS = 15_000;
/** UI messages are capped at 64 KB: send fragments in base64 parts below that. */
export const PART_BYTES = 40_000;
/** A viewer this many messages behind skips ahead to the next keyframe. */
const MAX_BEHIND = 60;
const DEFAULT_MS = 33;

interface Viewer {
  seen: number;
  behind: number;
  chain: Promise<void>;
  skip: boolean;
  /** Has this viewer had the init segment for the stream's current config? */
  inited: boolean;
}

/** One camera's stream as fMP4: frames go out one behind so each knows its duration. */
class Feed {
  viewers = new Map<string, Viewer>();
  seq = 1;
  pending: AvcFrame | null = null;
  /** Rebases timestamps so they keep rising when a camera reconnects and starts again from 0. */
  offset = 0;
  lastOut = -1;
  init: { mime: string; data: Buffer } | null = null;
  private onConfig = () => this.configure();
  private onFrame = (f: AvcFrame) => this.frame(f);

  constructor(
    readonly cam: string,
    readonly stream: LiveStream,
    private readonly out: (f: Feed, clientId: string, v: Viewer, head: Record<string, unknown>, data: Buffer) => void
  ) {
    stream.on('config', this.onConfig);
    stream.on('frame', this.onFrame);
    if (stream.avcC) this.configure();
  }

  dispose(): void {
    this.stream.off('config', this.onConfig);
    this.stream.off('frame', this.onFrame);
  }

  private configure(): void {
    const avcC = this.stream.avcC!;
    this.init = { mime: mimeOf(avcC), data: initSegment(avcC, this.stream.width || 1280, this.stream.height || 720) };
    this.pending = null;
    for (const [id, v] of this.viewers) this.sendInit(id, v);
  }

  sendInit(id: string, v: Viewer): void {
    if (!this.init) return;
    v.inited = true;
    v.skip = true; // until the next keyframe
    this.out(this, id, v, { kind: 'init', mime: this.init.mime, seq: 0 }, this.init.data);
  }

  /** A late joiner: init, then the GOP so far (all but its newest frame, which goes out with the next one). */
  join(id: string, v: Viewer): void {
    if (!this.init) return;
    this.sendInit(id, v);
    const gop = this.pending ? this.stream.gop.slice(0, -1) : [];
    for (let i = 0; i < gop.length; i++) {
      const f = gop[i]!;
      const next = gop[i + 1] ?? this.stream.gop[i + 1];
      this.emit({ ...f, dts: f.dts + this.offset }, next ? next.dts - f.dts : DEFAULT_MS, [[id, v]]);
    }
  }

  private fix(f: AvcFrame): AvcFrame {
    let dts = f.dts + this.offset;
    if (dts <= this.lastOut) {
      this.offset += this.lastOut + DEFAULT_MS - dts;
      dts = this.lastOut + DEFAULT_MS;
    }
    return { ...f, dts };
  }

  private frame(f: AvcFrame): void {
    const g = this.fix(f);
    const p = this.pending;
    this.pending = g;
    this.lastOut = g.dts;
    if (!p) return;
    const gap = g.dts - p.dts;
    this.emit(p, gap > 0 && gap < 2000 ? gap : DEFAULT_MS, [...this.viewers]);
  }

  private emit(f: AvcFrame, duration: number, to: [string, Viewer][]): void {
    const seq = this.seq++;
    const data = fragment(seq, f, duration);
    for (const [id, v] of to) {
      if (!v.inited) continue;
      if (v.behind > MAX_BEHIND) v.skip = true;
      if (v.skip && !f.key) continue;
      v.skip = false;
      this.out(this, id, v, { kind: 'seg', seq, key: f.key }, data);
    }
  }
}

export type Send = (message: unknown, clientId: string) => Promise<void>;

export class VideoHub {
  private feeds = new Map<string, Feed>();
  private timer: NodeJS.Timeout;

  constructor(
    private readonly send: Send,
    /** The stream for a camera id, or null when it has none; asked when someone wants it. */
    private readonly streamOf: (cam: string) => LiveStream | null,
    /** Called with the camera ids someone is watching now, so pulled streams run only then. */
    private readonly onWatched: (cams: Set<string>) => void = () => {},
    private readonly now = () => Date.now()
  ) {
    this.timer = setInterval(() => this.prune(), 5000);
    this.timer.unref?.();
  }

  /** The cameras this viewer shows now; any it had before and doesn't list stop for it. */
  want(clientId: string, cams: string[]): void {
    const wanted = new Set(cams);
    for (const [k, f] of this.feeds) if (!wanted.has(k)) f.viewers.delete(clientId);
    for (const cam of wanted) {
      const stream = this.streamOf(cam);
      if (!stream) continue;
      let f = this.feeds.get(cam);
      if (f && f.stream !== stream) {
        f.dispose();
        this.feeds.delete(cam);
        f = undefined;
      }
      if (!f) {
        f = new Feed(cam, stream, (feed, id, v, head, data) => this.queue(feed, id, v, head, data));
        this.feeds.set(cam, f);
      }
      const v = f.viewers.get(clientId);
      if (v) {
        v.seen = this.now();
        if (!v.inited) f.join(clientId, v);
        continue;
      }
      const nv: Viewer = { seen: this.now(), behind: 0, chain: Promise.resolve(), skip: true, inited: false };
      f.viewers.set(clientId, nv);
      f.join(clientId, nv);
    }
    this.prune();
  }

  drop(clientId: string): void {
    for (const f of this.feeds.values()) f.viewers.delete(clientId);
    this.prune();
  }

  watched(): Set<string> {
    return new Set([...this.feeds.keys()]);
  }

  stop(): void {
    clearInterval(this.timer);
    for (const f of this.feeds.values()) f.dispose();
    this.feeds.clear();
  }

  private prune(): void {
    const t = this.now();
    for (const [k, f] of this.feeds) {
      for (const [id, v] of f.viewers) if (t - v.seen > VIEWER_TTL_MS) f.viewers.delete(id);
      if (!f.viewers.size) {
        f.dispose();
        this.feeds.delete(k);
      }
    }
    this.onWatched(this.watched());
  }

  private queue(f: Feed, clientId: string, v: Viewer, head: Record<string, unknown>, data: Buffer): void {
    const parts = Math.max(1, Math.ceil(data.length / PART_BYTES));
    for (let part = 0; part < parts; part++) {
      const message = { type: 'video', cam: f.cam, ...head, part, parts, data: data.subarray(part * PART_BYTES, (part + 1) * PART_BYTES).toString('base64') };
      v.behind++;
      v.chain = v.chain
        .then(() => this.send(message, clientId))
        .catch(() => {})
        .finally(() => {
          v.behind--;
        });
    }
  }
}
