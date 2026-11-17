// VISCA over IP. Two transports: Sony's framing over UDP 52381 (Sony, BirdDog and most cameras that say
// "VISCA over IP"), and raw VISCA over TCP (PTZOptics on 5678, and others). One request at a time; a newer
// move replaces a move still waiting, so the camera follows the keys without a backlog.
//
// Commands are from Sony's VISCA command lists (BRC/SRG series) as most VISCA cameras follow them. Which
// picture settings a camera has is found by asking: a setting whose inquiry errors or times out is left out.

import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import { CameraError, type Driver, type Identity, type Param, type Protocol, type Status, clamp, speedStep } from './types.js';

const TIMEOUT_MS = 800;
const ADDR = 0x81;

export class ViscaError extends CameraError {}

const ERRORS: Record<number, string> = {
  0x01: 'message length error',
  0x02: 'syntax error',
  0x03: 'command buffer full',
  0x04: 'command canceled',
  0x05: 'no socket',
  0x41: 'not executable now'
};

interface Item {
  payload: Buffer;
  inquiry: boolean;
  key?: string;
  started: boolean;
  resolve(b: Buffer): void;
  reject(e: Error): void;
}

/** One request in flight; replies matched by shape (ACK/completion/error, or 90 50 inquiry data). */
abstract class Link {
  private queue: Item[] = [];
  private current: Item | null = null;
  private timer: NodeJS.Timeout | null = null;
  closed = false;

  request(payload: Buffer, inquiry: boolean, key?: string): Promise<Buffer> {
    if (this.closed) return Promise.reject(new ViscaError('Closed'));
    return new Promise((resolve, reject) => {
      if (key) {
        const old = this.queue.find((q) => q.key === key && !q.started);
        if (old) {
          old.resolve(Buffer.alloc(0));
          this.queue.splice(this.queue.indexOf(old), 1);
        }
      }
      this.queue.push({ payload, inquiry, key, started: false, resolve, reject });
      this.next();
    });
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const q of [...this.queue, ...(this.current ? [this.current] : [])]) q.reject(new ViscaError('Closed'));
    this.queue = [];
    this.current = null;
  }

  protected abstract write(item: Item): void;

  private next(): void {
    if (this.current || !this.queue.length || this.closed) return;
    const item = this.queue.shift()!;
    item.started = true;
    this.current = item;
    this.timer = setTimeout(() => this.finish(new ViscaError('No answer')), TIMEOUT_MS);
    try {
      this.write(item);
    } catch (e) {
      this.finish(e as Error);
    }
  }

  protected finish(result: Error | Buffer): void {
    const item = this.current;
    if (!item) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current = null;
    if (result instanceof Error) item.reject(result);
    else item.resolve(result);
    this.next();
  }

  /** A whole VISCA reply (from 0x90 to 0xFF). */
  protected reply(r: Buffer): void {
    const item = this.current;
    if (!item || r.length < 3) return;
    const kind = r[1]! & 0xf0;
    if (kind === 0x60) return this.finish(new ViscaError(`Camera: ${ERRORS[r[2]!] ?? 'error ' + r[2]!.toString(16)}`));
    if (item.inquiry) {
      if (r[1] === 0x50 && r.length > 3) this.finish(r);
      return;
    }
    if (kind === 0x40 || kind === 0x50) this.finish(r);
  }

  failAll(why: string): void {
    if (this.current) this.finish(new ViscaError(why));
  }
}

class UdpLink extends Link {
  private sock: dgram.Socket;
  private seq = 0;
  private ready: Promise<void>;

  constructor(host: string, port: number) {
    super();
    this.sock = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
    this.sock.on('message', (m) => this.onMessage(m));
    this.sock.on('error', (e: NodeJS.ErrnoException) => this.failAll(e.code === 'ECONNREFUSED' ? 'Connection refused' : e.message));
    this.ready = new Promise((resolve) => this.sock.connect(port, host, () => resolve()));
    // Reset the camera's sequence counter (a control message: it changes nothing on the camera).
    void this.ready.then(() => this.send(0x0200, Buffer.from([0x01]), 0)).catch(() => {});
  }

  private send(type: number, payload: Buffer, seq: number): void {
    const h = Buffer.alloc(8);
    h.writeUInt16BE(type, 0);
    h.writeUInt16BE(payload.length, 2);
    h.writeUInt32BE(seq >>> 0, 4);
    this.sock.send(Buffer.concat([h, payload]));
  }

  protected write(item: Item): void {
    void this.ready.then(() => {
      if (this.closed) return;
      this.seq = (this.seq + 1) >>> 0;
      this.send(item.inquiry ? 0x0110 : 0x0100, item.payload, this.seq);
    });
  }

  private onMessage(m: Buffer): void {
    if (m.length < 8) return;
    const type = m.readUInt16BE(0);
    if (type === 0x0201) return; // control reply (sequence reset)
    if (type !== 0x0111) return;
    const seq = m.readUInt32BE(4);
    if (seq !== this.seq) return; // a late reply to a request that timed out
    this.reply(m.subarray(8));
  }

  override close(): void {
    super.close();
    try {
      this.sock.close();
    } catch {}
  }
}

class TcpLink extends Link {
  private sock: net.Socket | null = null;
  private buf = Buffer.alloc(0);

  constructor(
    private readonly host: string,
    private readonly port: number
  ) {
    super();
  }

  private connect(): net.Socket {
    if (this.sock && !this.sock.destroyed) return this.sock;
    const s = net.connect({ host: this.host, port: this.port });
    s.setNoDelay(true);
    this.buf = Buffer.alloc(0);
    s.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      for (;;) {
        const end = this.buf.indexOf(0xff);
        if (end < 0) break;
        const r = this.buf.subarray(0, end + 1);
        this.buf = this.buf.subarray(end + 1);
        this.reply(r);
      }
      if (this.buf.length > 4096) this.buf = Buffer.alloc(0);
    });
    s.on('error', (e: NodeJS.ErrnoException) => this.failAll(e.code === 'ECONNREFUSED' ? 'Connection refused' : e.message));
    s.on('close', () => {
      if (this.sock === s) this.sock = null;
    });
    this.sock = s;
    return s;
  }

  protected write(item: Item): void {
    this.connect().write(item.payload);
  }

  override close(): void {
    super.close();
    this.sock?.destroy();
    this.sock = null;
  }
}

const cmd = (...b: number[]) => Buffer.from([ADDR, ...b, 0xff]);
const nib = (v: number, n: number) => Array.from({ length: n }, (_, i) => (v >> (4 * (n - 1 - i))) & 0x0f);
const fromNib = (b: Buffer, at: number, n: number) => {
  let v = 0;
  for (let i = 0; i < n; i++) v = (v << 4) | (b[at + i]! & 0x0f);
  return v;
};
const s16 = (v: number) => (v & 0x8000 ? v - 0x10000 : v);

const AE: { value: number; label: string }[] = [
  { value: 0x00, label: 'Full auto' },
  { value: 0x03, label: 'Manual' },
  { value: 0x0a, label: 'Shutter priority' },
  { value: 0x0b, label: 'Iris priority' },
  { value: 0x0d, label: 'Bright' }
];
const WB: { value: number; label: string }[] = [
  { value: 0x00, label: 'Auto' },
  { value: 0x01, label: 'Indoor' },
  { value: 0x02, label: 'Outdoor' },
  { value: 0x03, label: 'One push' },
  { value: 0x04, label: 'ATW' },
  { value: 0x05, label: 'Manual' }
];

/** Direct-value settings with a 4-nibble (p q) payload: id → [command byte, max]. */
const DIRECT: Record<string, { code: number; max: number; label: string; group: Param['group'] }> = {
  iris: { code: 0x4b, max: 0x11, label: 'Iris', group: 'exposure' },
  gain: { code: 0x4c, max: 0x0f, label: 'Gain', group: 'exposure' },
  shutter: { code: 0x4a, max: 0x15, label: 'Shutter', group: 'exposure' },
  rgain: { code: 0x43, max: 0xff, label: 'R gain', group: 'color' },
  bgain: { code: 0x44, max: 0xff, label: 'B gain', group: 'color' },
  aperture: { code: 0x42, max: 0x0f, label: 'Detail (sharpness)', group: 'image' },
  brightness: { code: 0x4d, max: 0x1f, label: 'Bright level', group: 'exposure' }
};

export interface ViscaOptions {
  host: string;
  port: number;
  protocol: Protocol;
  brand: string;
  /** BirdDog: read its name and firmware from the REST API on this port (a GET; 8080). */
  restPort?: number;
}

export class ViscaDriver implements Driver {
  readonly protocol: Protocol;
  private link: Link;

  constructor(private readonly o: ViscaOptions) {
    this.protocol = o.protocol;
    this.link = o.protocol === 'visca-tcp' ? new TcpLink(o.host, o.port) : new UdpLink(o.host, o.port);
  }

  private inq(...b: number[]): Promise<Buffer> {
    return this.link.request(Buffer.from([ADDR, 0x09, ...b, 0xff]), true);
  }

  private async send(payload: Buffer, key?: string): Promise<void> {
    await this.link.request(payload, false, key);
  }

  async identify(): Promise<Identity> {
    const r = await this.inq(0x00, 0x02);
    const vendor = r.length >= 10 ? r.readUInt16BE(2) : 0;
    const model = r.length >= 10 ? r.readUInt16BE(4) : 0;
    const rom = r.length >= 10 ? r.readUInt16BE(6) : 0;
    const id: Identity = {
      vendor: vendor === 1 ? 'Sony' : this.o.brand === 'birddog' ? 'BirdDog' : this.o.brand === 'ptzoptics' ? 'PTZOptics' : `VISCA vendor ${vendor.toString(16).padStart(4, '0')}`,
      model: `model ${model.toString(16).padStart(4, '0')}`,
      firmware: rom ? rom.toString(16) : ''
    };
    if (this.o.brand === 'birddog') {
      const about = await birddogAbout(this.o.host, this.o.restPort ?? 8080).catch(() => null);
      if (about) Object.assign(id, about);
    }
    return id;
  }

  async status(): Promise<Status> {
    const s: Status = { power: '' };
    const p = await this.inq(0x04, 0x00);
    s.power = p[2] === 0x02 ? 'on' : p[2] === 0x03 ? 'standby' : '';
    const pt = await this.inq(0x06, 0x12).catch(() => null);
    if (pt && pt.length >= 11) {
      s.pan = s16(fromNib(pt, 2, 4));
      s.tilt = s16(fromNib(pt, 6, 4));
    }
    const z = await this.inq(0x04, 0x47).catch(() => null);
    if (z && z.length >= 7) s.zoom = clamp(fromNib(z, 2, 4) / 0x4000, 0, 1);
    const f = await this.inq(0x04, 0x38).catch(() => null);
    if (f && f.length >= 4) s.focusAuto = f[2] === 0x02;
    return s;
  }

  async picture(): Promise<Param[]> {
    const out: Param[] = [];
    const one = async (b: number) => (await this.inq(0x04, b).catch(() => null))?.[2];
    const ae = await one(0x39);
    const wb = await one(0x35);
    const direct: Record<string, number | undefined> = {};
    for (const [id, d] of Object.entries(DIRECT)) {
      const r = await this.inq(0x04, d.code).catch(() => null);
      direct[id] = r && r.length >= 7 ? fromNib(r, 2, 4) : undefined;
    }
    const sat = await this.inq(0x04, 0x49).catch(() => null);
    const af = await one(0x38);

    const manual = ae === 0x03;
    if (ae !== undefined) out.push({ id: 'ae', label: 'Exposure mode', group: 'exposure', kind: 'enum', value: ae, options: AE, text: AE.find((x) => x.value === ae)?.label ?? `0x${ae.toString(16)}` });
    const range = (id: string, enabled: boolean, hint: string) => {
      const v = direct[id];
      if (v === undefined) return;
      const d = DIRECT[id]!;
      out.push({ id, label: d.label, group: d.group, kind: 'range', value: v, min: 0, max: d.max, step: 1, text: id === 'rgain' || id === 'bgain' ? String(v) : `step ${v}`, enabled, hint: enabled ? undefined : hint });
    };
    range('iris', ae === undefined || manual || ae === 0x0b, 'Set Exposure mode to Manual or Iris priority');
    range('gain', ae === undefined || manual, 'Set Exposure mode to Manual');
    range('shutter', ae === undefined || manual || ae === 0x0a, 'Set Exposure mode to Manual or Shutter priority');
    range('brightness', ae === 0x0d, 'Set Exposure mode to Bright');
    if (wb !== undefined) out.push({ id: 'wb', label: 'White balance', group: 'color', kind: 'enum', value: wb, options: WB, text: WB.find((x) => x.value === wb)?.label ?? `0x${wb.toString(16)}` });
    if (wb !== undefined) out.push({ id: 'awb', label: 'One push white balance', group: 'color', kind: 'action', enabled: wb === 0x03, hint: wb === 0x03 ? 'Point at white, then press' : 'Set White balance to One push' });
    range('rgain', wb === undefined || wb === 0x05, 'Set White balance to Manual');
    range('bgain', wb === undefined || wb === 0x05, 'Set White balance to Manual');
    if (sat && sat.length >= 7) {
      const v = sat[5]! & 0x0f;
      out.push({ id: 'saturation', label: 'Colour gain (saturation)', group: 'color', kind: 'range', value: v, min: 0, max: 0x0e, step: 1, text: `step ${v}`, enabled: true });
    }
    range('aperture', true, '');
    if (af !== undefined) {
      out.push({ id: 'focus', label: 'Focus', group: 'focus', kind: 'enum', value: af === 0x02 ? 'auto' : 'manual', options: [{ value: 'auto', label: 'Auto' }, { value: 'manual', label: 'Manual' }], text: af === 0x02 ? 'Auto' : 'Manual' });
      out.push({ id: 'af', label: 'One push focus', group: 'focus', kind: 'action', enabled: af !== 0x02, hint: af !== 0x02 ? 'Focus once, then stay manual' : 'Set Focus to Manual' });
    }
    return out;
  }

  move(pan: number, tilt: number): Promise<void> {
    const ps = speedStep(pan, 0x18) || 1;
    const ts = speedStep(tilt, 0x17) || 1;
    const pd = pan < 0 ? 0x01 : pan > 0 ? 0x02 : 0x03;
    const td = tilt > 0 ? 0x01 : tilt < 0 ? 0x02 : 0x03;
    return this.send(cmd(0x01, 0x06, 0x01, ps, ts, pd, td), 'move');
  }

  zoom(v: number): Promise<void> {
    const p = clamp(Math.round(Math.abs(v) * 7), 0, 7);
    return this.send(cmd(0x01, 0x04, 0x07, v === 0 ? 0x00 : (v > 0 ? 0x20 : 0x30) | p), 'zoom');
  }

  focus(v: number): Promise<void> {
    const p = clamp(Math.round(Math.abs(v) * 7), 0, 7);
    return this.send(cmd(0x01, 0x04, 0x08, v === 0 ? 0x00 : (v > 0 ? 0x20 : 0x30) | p), 'focus');
  }

  home(): Promise<void> {
    return this.send(cmd(0x01, 0x06, 0x04));
  }

  recall(n: number): Promise<void> {
    return this.send(cmd(0x01, 0x04, 0x3f, 0x02, clamp(n - 1, 0, 0xfe)));
  }

  store(n: number): Promise<void> {
    return this.send(cmd(0x01, 0x04, 0x3f, 0x01, clamp(n - 1, 0, 0xfe)));
  }

  async set(id: string, value: number | string): Promise<void> {
    const d = DIRECT[id];
    if (d) return this.send(cmd(0x01, 0x04, d.code, 0, 0, ...nib(clamp(Math.round(Number(value)), 0, d.max), 2)));
    switch (id) {
      case 'ae':
        if (!AE.some((x) => x.value === value)) throw new CameraError('Unknown exposure mode');
        return this.send(cmd(0x01, 0x04, 0x39, Number(value)));
      case 'wb':
        if (!WB.some((x) => x.value === value)) throw new CameraError('Unknown white balance mode');
        return this.send(cmd(0x01, 0x04, 0x35, Number(value)));
      case 'awb':
        return this.send(cmd(0x01, 0x04, 0x10, 0x05));
      case 'saturation':
        return this.send(cmd(0x01, 0x04, 0x49, 0, 0, 0, clamp(Math.round(Number(value)), 0, 0x0e)));
      case 'focus':
        return this.send(cmd(0x01, 0x04, 0x38, value === 'auto' ? 0x02 : 0x03));
      case 'af':
        return this.send(cmd(0x01, 0x04, 0x18, 0x01));
    }
    throw new CameraError(`This camera has no setting "${id}"`);
  }

  close(): void {
    this.link.close();
  }
}

/** BirdDog's REST API: GET /about has the name and firmware. Read only. */
function birddogAbout(host: string, port: number): Promise<Partial<Identity> | null> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/about', timeout: 1500 }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (d: Buffer) => parts.push(d));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(parts).toString('utf8'));
          resolve({ vendor: 'BirdDog', model: String(j.HardwareVersion ?? j.Model ?? j.HostName ?? 'BirdDog'), firmware: String(j.FirmwareVersion ?? j.Version ?? '') });
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}
