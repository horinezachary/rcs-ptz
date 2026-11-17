// One camera in the module: its driver for movement and the picture, the readings polled from it, and its
// live stream. Everything read from the camera lives here, in memory only: the module's config holds only
// the entry (address, protocol, how its video arrives), never anything the camera reports.

import { EventEmitter } from 'node:events';
import { OnvifDriver } from './cameras/onvif.js';
import { PanasonicDriver } from './cameras/panasonic.js';
import { type Brand, type Credentials, type Driver, type Identity, type Param, type Protocol, PROTOCOLS, type Status } from './cameras/types.js';
import { ViscaDriver } from './cameras/visca.js';
import { pullerFor, type Puller } from './video/pull.js';
import { LiveStream, type StreamInfo } from './video/stream.js';

export type VideoMode = 'push' | 'pull' | 'none';

export interface CameraEntry {
  id: string;
  name: string;
  brand: Brand;
  protocol: Protocol;
  host: string;
  /** 0: the protocol's usual port. */
  port: number;
  video: { mode: VideoMode; url: string; key: string };
  invertPan: boolean;
  invertTilt: boolean;
}

export interface CameraView {
  id: string;
  name: string;
  brand: Brand;
  protocol: Protocol;
  host: string;
  port: number;
  reachable: boolean;
  /** Has it answered at least once since the module started? */
  read: boolean;
  lastError: string;
  identity: Identity | null;
  status: Status | null;
  picture: Param[];
  stream: StreamInfo;
  videoMode: VideoMode;
}

const pollMs = () => Number(process.env.RCS_PTZ_POLL_MS) || 2000;

export const portOf = (e: CameraEntry) => e.port || PROTOCOLS[e.protocol].port;

export function makeDriver(e: CameraEntry, creds: () => Credentials | null): Driver {
  const port = portOf(e);
  switch (e.protocol) {
    case 'panasonic':
      return new PanasonicDriver(e.host, port, creds);
    case 'onvif':
      return new OnvifDriver(e.host, port, creds);
    default:
      return new ViscaDriver({ host: e.host, port, protocol: e.protocol, brand: e.brand });
  }
}

export class Camera extends EventEmitter {
  readonly driver: Driver;
  readonly stream: LiveStream;
  private puller: Puller | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private polling = false;
  private pictureWanted = false;
  private pictureAt = 0;
  private watched = false;
  view: CameraView;

  constructor(
    readonly entry: CameraEntry,
    creds: () => Credentials | null,
    driver?: Driver
  ) {
    super();
    this.driver = driver ?? makeDriver(entry, creds);
    this.stream = new LiveStream(entry.id);
    this.stream.on('change', () => this.emit('change'));
    this.view = {
      id: entry.id,
      name: entry.name,
      brand: entry.brand,
      protocol: entry.protocol,
      host: entry.host,
      port: portOf(entry),
      reachable: false,
      read: false,
      lastError: '',
      identity: null,
      status: null,
      picture: [],
      stream: this.stream.info(),
      videoMode: entry.video.mode
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.puller?.stop();
    this.puller = null;
    this.driver.close();
    this.stream.ended('Stopped');
    this.stream.dispose();
    this.removeAllListeners();
  }

  /** Someone shows the Picture page for this camera: read the picture settings often. */
  wantPicture(on: boolean): void {
    if (on === this.pictureWanted) return;
    this.pictureWanted = on;
    if (on) this.pictureAt = 0;
  }

  /** A pulled stream runs only while someone watches it (the panel, a web view, an RTSP client). */
  setWatched(on: boolean): void {
    this.watched = on;
    if (this.entry.video.mode !== 'pull') return;
    if (on && !this.puller) {
      this.puller = pullerFor(this.entry.video.url, this.stream);
      if (!this.puller) this.stream.setError('The stream address must start with rtmp://, http:// or https://');
      this.puller?.start();
    } else if (!on && this.puller) {
      this.puller.stop();
      this.puller = null;
      this.stream.ended('Not watched');
    }
  }

  get isWatched(): boolean {
    return this.watched;
  }

  /** Reads: identity once, status every poll, the picture when wanted (and now and then otherwise). */
  async poll(): Promise<void> {
    if (this.polling || !this.running) return;
    this.polling = true;
    if (this.timer) clearTimeout(this.timer);
    try {
      if (!this.view.identity) this.view.identity = await this.driver.identify();
      this.view.status = await this.driver.status();
      const every = this.pictureWanted ? pollMs() : pollMs() * 8;
      if (Date.now() - this.pictureAt >= every) {
        this.pictureAt = Date.now();
        this.view.picture = await this.driver.picture();
      }
      this.view.reachable = true;
      this.view.read = true;
      this.view.lastError = '';
    } catch (e) {
      this.view.reachable = false;
      this.view.lastError = (e as Error).message;
    } finally {
      this.polling = false;
      if (this.running) {
        this.timer = setTimeout(() => void this.poll(), pollMs());
        this.timer.unref?.();
        this.emit('change');
      }
    }
  }

  /** Reads the picture settings again now (after a change, so the page shows what the camera took). */
  async refreshPicture(): Promise<void> {
    try {
      this.view.picture = await this.driver.picture();
      this.pictureAt = Date.now();
      this.emit('change');
    } catch {}
  }

  snapshot(): CameraView {
    this.view.stream = this.stream.info();
    return this.view;
  }
}
