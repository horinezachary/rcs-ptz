// Panasonic AW integrated cameras (AW-HE, AW-UE, AK-UB) over their HTTP CGI: /cgi-bin/aw_ptz for movement and
// /cgi-bin/aw_cam for the picture, as in Panasonic's "HD/4K Integrated Camera Interface Specifications".
// Replies are short text ("pTS5050", "OGU:08"); "ER1"/"ER2"/"ER3" mean unsupported, busy, out of range.
// A camera with authentication on takes the user name and password (HTTP Basic).

import http from 'node:http';
import { CameraError, type Credentials, type Driver, type Identity, type Param, type Status, clamp } from './types.js';

const TIMEOUT_MS = 1500;
/** The camera wants about 130 ms between commands: closer ones come back ER2. */
const GAP_MS = 130;

export class PanasonicError extends CameraError {}

const AWB = [
  { value: 0, label: 'ATW' },
  { value: 1, label: 'AWB A' },
  { value: 2, label: 'AWB B' },
  { value: 4, label: '3200K' },
  { value: 5, label: '5600K' },
  { value: 9, label: 'VAR' }
];
const GAINS = [{ value: 0x80, label: 'Auto (AGC)' }, ...Array.from({ length: 13 }, (_, i) => ({ value: 0x08 + i * 3, label: `${i * 3} dB` }))];
const DETAIL = [
  { value: 0, label: 'Off' },
  { value: 1, label: 'Low' },
  { value: 2, label: 'High' }
];

const hex = (v: number, n: number) => v.toString(16).toUpperCase().padStart(n, '0');
const two = (v: number) => String(clamp(Math.round(v), 1, 99)).padStart(2, '0');

export class PanasonicDriver implements Driver {
  readonly protocol = 'panasonic' as const;
  private last = 0;
  private closed = false;
  /** Which R/B gain command this model answers: ORI/OBI (newer) or ORG/OBG (older). */
  private colorCmd: 'I' | 'G' | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly auth: () => Credentials | null
  ) {}

  /**
   * One request at a time, GAP_MS apart. Commands go ahead of reads, so a move never waits behind a poll; a
   * newer move replaces a move still waiting (key "move", "zoom").
   */
  private queue: { path: string; prio: number; key?: string; resolve(t: string): void; reject(e: Error): void }[] = [];
  private busy = false;

  private get(path: string, prio = 0, key?: string): Promise<string> {
    if (this.closed) return Promise.reject(new PanasonicError('Closed'));
    return new Promise((resolve, reject) => {
      if (key) {
        const old = this.queue.find((q) => q.key === key);
        if (old) {
          old.path = path;
          const prev = old.resolve;
          old.resolve = (t) => {
            prev(t);
            resolve(t);
          };
          const prevRej = old.reject;
          old.reject = (e) => {
            prevRej(e);
            reject(e);
          };
          return;
        }
      }
      this.queue.push({ path, prio, key, resolve, reject });
      this.queue.sort((a, b) => b.prio - a.prio);
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length && !this.closed) {
      const wait = this.last + GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const q = this.queue.shift();
      if (!q) break;
      this.last = Date.now();
      try {
        q.resolve(await this.fetch(q.path));
      } catch (e) {
        q.reject(e as Error);
      }
    }
    for (const q of this.queue.splice(0)) q.reject(new PanasonicError('Closed'));
    this.busy = false;
  }

  private fetch(path: string): Promise<string> {
    const a = this.auth();
    return new Promise((resolve, reject) => {
      const req = http.get(
        { host: this.host, port: this.port, path, timeout: TIMEOUT_MS, headers: a?.user ? { Authorization: 'Basic ' + Buffer.from(`${a.user}:${a.password}`).toString('base64') } : {} },
        (res) => {
          const parts: Buffer[] = [];
          res.on('data', (d: Buffer) => parts.push(d));
          res.on('end', () => {
            if (res.statusCode === 401) return reject(new PanasonicError('The camera wants a user name and password'));
            if (res.statusCode !== 200) return reject(new PanasonicError(`HTTP ${res.statusCode}`));
            const t = Buffer.concat(parts).toString('latin1').trim();
            if (/^ER[123]/.test(t)) return reject(new PanasonicError(t.startsWith('ER1') ? 'Not supported by this camera' : t.startsWith('ER2') ? 'Camera busy' : 'Out of range'));
            resolve(t);
          });
        }
      );
      req.on('timeout', () => req.destroy(new PanasonicError('No answer')));
      req.on('error', (e: NodeJS.ErrnoException) => reject(new PanasonicError(e.code === 'ECONNREFUSED' ? 'Connection refused' : e.message)));
    });
  }

  private ptz(c: string, prio = 0, key?: string): Promise<string> {
    return this.get(`/cgi-bin/aw_ptz?cmd=${encodeURIComponent('#' + c)}&res=1`, prio, key);
  }

  private cam(c: string, prio = 0): Promise<string> {
    return this.get(`/cgi-bin/aw_cam?cmd=${encodeURIComponent(c)}&res=1`, prio);
  }

  /** Commands: ahead of every read. */
  private async doPtz(c: string, key?: string): Promise<void> {
    await this.ptz(c, 2, key);
  }

  private async doCam(c: string): Promise<void> {
    await this.cam(c, 1);
  }

  /** "OGU:08" → "08" */
  private async q(c: string): Promise<string | undefined> {
    const r = await this.cam(c).catch(() => undefined);
    const i = r?.indexOf(':') ?? -1;
    return r && i >= 0 ? r.slice(i + 1) : undefined;
  }

  async identify(): Promise<Identity> {
    const model = (await this.q('QID')) ?? '';
    const fw = (await this.q('QSV')) ?? '';
    if (!model) {
      // Older models answer only aw_ptz: the power query proves it is there.
      await this.ptz('O');
    }
    return { vendor: 'Panasonic', model: model || 'AW camera', firmware: fw };
  }

  async status(): Promise<Status> {
    const p = await this.ptz('O');
    const s: Status = { power: p === 'p1' ? 'on' : p === 'p0' || p === 'p3' ? 'standby' : '' };
    const pos = await this.ptz('APC').catch(() => '');
    const m = /^aPC([0-9A-F]{4})([0-9A-F]{4})/i.exec(pos);
    if (m) {
      s.pan = parseInt(m[1]!, 16) - 0x8000;
      s.tilt = parseInt(m[2]!, 16) - 0x8000;
    }
    const z = /^gz([0-9A-F]{3})/i.exec(await this.ptz('GZ').catch(() => ''));
    if (z) s.zoom = clamp((parseInt(z[1]!, 16) - 0x555) / (0xfff - 0x555), 0, 1);
    const d = await this.ptz('D1').catch(() => '');
    if (/^d1[01]/.test(d)) s.focusAuto = d === 'd11';
    return s;
  }

  async picture(): Promise<Param[]> {
    const out: Param[] = [];
    const irisAuto = await this.q('QRS');
    const iris = await this.q('QRV');
    const gain = await this.q('QGU');
    const sh = await this.q('QSH');
    const awb = await this.q('QAW');
    let r: string | undefined, b: string | undefined;
    if (this.colorCmd !== 'G') {
      r = await this.q('QRI');
      b = await this.q('QBI');
      if (r !== undefined) this.colorCmd = 'I';
    }
    if (r === undefined) {
      r = await this.q('QRG');
      b = await this.q('QBG');
      if (r !== undefined) this.colorCmd = 'G';
    }
    const detail = await this.q('QDT');
    const d = await this.ptz('D1').catch(() => '');

    if (irisAuto !== undefined) out.push({ id: 'irisAuto', label: 'Iris mode', group: 'exposure', kind: 'enum', value: Number(irisAuto), options: [{ value: 1, label: 'Auto' }, { value: 0, label: 'Manual' }], text: irisAuto === '1' ? 'Auto' : 'Manual' });
    if (iris !== undefined) {
      const v = parseInt(iris, 16);
      out.push({ id: 'iris', label: 'Iris', group: 'exposure', kind: 'range', value: v, min: 0, max: 0x3ff, step: 16, text: `${Math.round((v / 0x3ff) * 100)}% open`, enabled: irisAuto !== '1', hint: irisAuto === '1' ? 'Set Iris mode to Manual' : undefined });
    }
    if (gain !== undefined) {
      const v = parseInt(gain, 16);
      out.push({ id: 'gain', label: 'Gain', group: 'exposure', kind: 'enum', value: v, options: GAINS, text: GAINS.find((g) => g.value === v)?.label ?? `${v - 8} dB` });
    }
    if (sh !== undefined) {
      const v = parseInt(sh, 16);
      out.push({ id: 'shutter', label: 'Shutter', group: 'exposure', kind: 'range', value: v, min: 0, max: 0x0b, step: 1, text: v === 0 ? 'Off' : `step ${v}` });
    }
    if (awb !== undefined) {
      const v = parseInt(awb, 16);
      out.push({ id: 'wb', label: 'White balance', group: 'color', kind: 'enum', value: v, options: AWB, text: AWB.find((x) => x.value === v)?.label ?? String(v) });
      out.push({ id: 'awb', label: 'Run AWB', group: 'color', kind: 'action', enabled: v === 1 || v === 2, hint: v === 1 || v === 2 ? 'Point at white, then press' : 'Set White balance to AWB A or B' });
    }
    const colour = (id: 'rgain' | 'bgain', raw: string | undefined, label: string) => {
      if (raw === undefined) return;
      const n = parseInt(raw, 16);
      const [lo, hi, mid] = this.colorCmd === 'I' ? [0x738, 0x8c8, 0x800] : [0x96, 0x168, 0xff];
      out.push({ id, label, group: 'color', kind: 'range', value: n - mid, min: lo - mid, max: hi - mid, step: this.colorCmd === 'I' ? 4 : 2, text: `${n - mid > 0 ? '+' : ''}${n - mid}` });
    };
    colour('rgain', r, 'R gain');
    colour('bgain', b, 'B gain');
    if (detail !== undefined) {
      const v = Number(detail);
      out.push({ id: 'detail', label: 'Detail', group: 'image', kind: 'enum', value: v, options: DETAIL, text: DETAIL.find((x) => x.value === v)?.label ?? String(v) });
    }
    if (/^d1[01]/.test(d)) {
      out.push({ id: 'focus', label: 'Focus', group: 'focus', kind: 'enum', value: d === 'd11' ? 'auto' : 'manual', options: [{ value: 'auto', label: 'Auto' }, { value: 'manual', label: 'Manual' }], text: d === 'd11' ? 'Auto' : 'Manual' });
      out.push({ id: 'af', label: 'One touch AF', group: 'focus', kind: 'action', enabled: d !== 'd11', hint: d !== 'd11' ? 'Focus once, then stay manual' : 'Set Focus to Manual' });
    }
    return out;
  }

  move(pan: number, tilt: number): Promise<void> {
    return this.doPtz(`PTS${two(50 + pan * 49)}${two(50 + tilt * 49)}`, 'move');
  }

  zoom(v: number): Promise<void> {
    return this.doPtz(`Z${two(50 + v * 49)}`, 'zoom');
  }

  focus(v: number): Promise<void> {
    return this.doPtz(`F${two(50 + v * 49)}`, 'focus');
  }

  home(): Promise<void> {
    return this.doPtz('APC80008000');
  }

  recall(n: number): Promise<void> {
    return this.doPtz(`R${String(clamp(n - 1, 0, 99)).padStart(2, '0')}`);
  }

  store(n: number): Promise<void> {
    return this.doPtz(`M${String(clamp(n - 1, 0, 99)).padStart(2, '0')}`);
  }

  async set(id: string, value: number | string): Promise<void> {
    const n = Math.round(Number(value));
    switch (id) {
      case 'irisAuto':
        await this.doCam(`ORS:${n ? 1 : 0}`);
        return;
      case 'iris':
        await this.doCam(`ORV:${hex(clamp(n, 0, 0x3ff), 3)}`);
        return;
      case 'gain':
        if (!GAINS.some((g) => g.value === n)) throw new PanasonicError('Unknown gain');
        await this.doCam(`OGU:${hex(n, 2)}`);
        return;
      case 'shutter':
        await this.doCam(`OSH:${hex(clamp(n, 0, 0x0b), 1)}`);
        return;
      case 'wb':
        if (!AWB.some((x) => x.value === n)) throw new PanasonicError('Unknown white balance mode');
        await this.doCam(`OAW:${n}`);
        return;
      case 'awb':
        await this.doCam('OWS');
        return;
      case 'rgain':
      case 'bgain': {
        const [lo, hi, mid] = this.colorCmd === 'G' ? [0x96, 0x168, 0xff] : [0x738, 0x8c8, 0x800];
        const c = this.colorCmd === 'G' ? (id === 'rgain' ? 'ORG' : 'OBG') : id === 'rgain' ? 'ORI' : 'OBI';
        await this.doCam(`${c}:${hex(clamp(n + mid, lo, hi), 3)}`);
        return;
      }
      case 'detail':
        await this.doCam(`ODT:${clamp(n, 0, 2)}`);
        return;
      case 'focus':
        await this.doPtz(value === 'auto' ? 'D11' : 'D10');
        return;
      case 'af':
        await this.doCam('OSE:69:1');
        return;
    }
    throw new PanasonicError(`This camera has no setting "${id}"`);
  }

  close(): void {
    this.closed = true;
  }
}
