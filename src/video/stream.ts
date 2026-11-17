// A camera's live picture inside the module: H.264 frames from whoever feeds it (a camera pushing RTMP to
// the unit, or the module pulling RTMP or HTTP-FLV), handed on unchanged to whoever watches it (the panel and
// web view as fragmented MP4, the ONVIF bridge as RTSP). Nothing is decoded or re-encoded, so a Pi copes.

import { EventEmitter } from 'node:events';
import { avcSize, type AvcFrame } from './flv.js';

export interface StreamInfo {
  live: boolean;
  /** Where the picture comes from now: "push from 10.0.0.21", "pull rtmp://…". */
  from: string;
  width: number;
  height: number;
  fps: number;
  kbps: number;
  /** Why there is no picture, when there is none. */
  error: string;
  /** Not H.264: the stream arrives but can't be shown. */
  codec: string;
}

/** No frame for this long: the picture is gone. */
export const STALE_MS = 5000;
/** A GOP longer than this is cut off (a camera with keyframes minutes apart). */
const MAX_GOP = 600;

/** Emits 'config' (avcC), 'frame' (AvcFrame), 'change' when its info changes. */
export class LiveStream extends EventEmitter {
  avcC: Buffer | null = null;
  width = 0;
  height = 0;
  /** Frames since the last keyframe, for a viewer who joins now. */
  gop: AvcFrame[] = [];
  from = '';
  error = '';
  codec = '';
  private lastAt = 0;
  private times: number[] = [];
  private bytes: { t: number; n: number }[] = [];
  private staleTimer: NodeJS.Timeout | null = null;

  constructor(readonly key: string) {
    super();
    this.setMaxListeners(50);
  }

  get live(): boolean {
    return !!this.avcC && Date.now() - this.lastAt < STALE_MS;
  }

  info(): StreamInfo {
    const now = Date.now();
    const recent = this.times.filter((t) => now - t < 2000);
    const kb = this.bytes.filter((b) => now - b.t < 2000).reduce((a, b) => a + b.n, 0);
    return {
      live: this.live,
      from: this.from,
      width: this.width,
      height: this.height,
      fps: this.live ? Math.round(recent.length / 2) : 0,
      kbps: this.live ? Math.round((kb * 8) / 2000) : 0,
      error: this.live ? '' : this.error,
      codec: this.codec
    };
  }

  setSource(from: string): void {
    if (this.from === from) return;
    this.from = from;
    this.emit('change');
  }

  setError(error: string): void {
    if (this.error === error) return;
    this.error = error;
    this.emit('change');
  }

  setCodec(codec: string): void {
    if (this.codec === codec) return;
    this.codec = codec;
    this.emit('change');
  }

  config(avcC: Buffer): void {
    if (this.avcC && this.avcC.equals(avcC)) return;
    this.avcC = avcC;
    const size = avcSize(avcC);
    this.width = size?.width ?? 1280;
    this.height = size?.height ?? 720;
    this.gop = [];
    this.codec = '';
    this.emit('config', avcC);
    this.emit('change');
  }

  frame(f: AvcFrame): void {
    if (!this.avcC) return;
    const wasLive = this.live;
    const now = Date.now();
    this.lastAt = now;
    this.times.push(now);
    this.bytes.push({ t: now, n: f.data.length });
    if (this.times.length > 240) this.times.splice(0, this.times.length - 240);
    if (this.bytes.length > 240) this.bytes.splice(0, this.bytes.length - 240);
    if (f.key) this.gop = [];
    if (!f.key && !this.gop.length) return; // can't be decoded until a keyframe
    if (this.gop.length < MAX_GOP) this.gop.push(f);
    this.emit('frame', f);
    if (!wasLive) {
      this.error = '';
      this.emit('change');
    }
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => this.emit('change'), STALE_MS + 50);
    this.staleTimer.unref?.();
  }

  /** The feeder went away: keep the config (a camera that comes back sends it again) but drop the frames. */
  ended(why: string): void {
    this.gop = [];
    this.lastAt = 0;
    this.error = why;
    this.emit('change');
  }

  dispose(): void {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.removeAllListeners();
  }
}
