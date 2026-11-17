// A simulated PTZ camera for development and tests. One camera answers every protocol the module speaks, each
// on its own port: VISCA over IP (Sony framing, UDP), VISCA over TCP, Panasonic AW HTTP CGI, ONVIF (device,
// media, PTZ and imaging), BirdDog's GET /about, and Sony's discovery on UDP 52380 when asked. It moves while a
// move is on, keeps presets and picture settings, and records every command (inquiries are not commands).
// Nothing here talks to real equipment.

import crypto from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { checkSecurity, envelope, fault } from '../onvif/soap.js';
import { find, parseXml, text } from '../onvif/xml.js';

export interface SimCommand {
  protocol: string;
  what: string;
}

export interface SimPorts {
  viscaUdp: number;
  viscaTcp: number;
  panasonic: number;
  onvif: number;
  birddog: number;
  /** Sony and PTZOptics web CGI (the RTMP setting), with Digest login. */
  web: number;
}

/** The camera's own RTMP push setting, as the web APIs set it. */
export interface SimRtmp {
  url: string;
  key: string;
  enabled: boolean;
}

export class SimCamera {
  // live state
  power = true;
  pan = 0; // -1..1
  tilt = 0;
  zoom = 0; // 0..1
  focus = 0.5;
  vel = { pan: 0, tilt: 0, zoom: 0, focus: 0 };
  focusAuto = true;
  ae = 0x00;
  iris = 0x0b;
  gain = 0x04;
  shutter = 0x0a;
  wb = 0x00;
  rgain = 0x80;
  bgain = 0x80;
  aperture = 0x05;
  saturation = 0x04;
  brightness = 0x0f;
  presets = new Map<number, { pan: number; tilt: number; zoom: number }>();
  commands: SimCommand[] = [];
  inquiries = 0;
  /** Basic auth for Panasonic and WS-Security for ONVIF, when set. */
  login: { user: string; password: string } | null = null;
  /** The camera's RTMP push destination. */
  rtmp: SimRtmp = { url: '', key: '', enabled: false };
  /** Called when the RTMP destination changes and streaming is on, with the full push URL. */
  onRtmp: ((url: string) => void) | null = null;

  private udp: dgram.Socket | null = null;
  private tcp: net.Server | null = null;
  private httpServers: http.Server[] = [];
  private discovery: dgram.Socket | null = null;
  private tick: NodeJS.Timeout | null = null;
  private last = Date.now();

  constructor(
    readonly name = 'Sim PTZ',
    readonly model = 'SIM-PTZ1'
  ) {}

  private cmd(protocol: string, what: string): void {
    this.commands.push({ protocol, what });
  }

  private step(): void {
    const now = Date.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    const c = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
    this.pan = c(this.pan + this.vel.pan * dt * 0.5);
    this.tilt = c(this.tilt + this.vel.tilt * dt * 0.5);
    this.zoom = c(this.zoom + this.vel.zoom * dt * 0.3, 0, 1);
    this.focus = c(this.focus + this.vel.focus * dt * 0.3, 0, 1);
  }

  get moving(): boolean {
    return !!(this.vel.pan || this.vel.tilt || this.vel.zoom || this.vel.focus);
  }

  async listen(ports: Partial<SimPorts> = {}, host = '127.0.0.1'): Promise<SimPorts> {
    this.tick = setInterval(() => this.step(), 50);
    this.tick.unref?.();
    const udp = dgram.createSocket('udp4');
    udp.on('message', (m, r) => this.onUdp(m, r));
    await new Promise<void>((res) => udp.bind(ports.viscaUdp ?? 0, host, () => res()));
    this.udp = udp;
    const tcp = net.createServer((s) => this.onTcp(s));
    await new Promise<void>((res) => tcp.listen(ports.viscaTcp ?? 0, host, () => res()));
    this.tcp = tcp;
    const http1 = http.createServer((q, s) => this.onPanasonic(q, s));
    const http2 = http.createServer((q, s) => void this.onOnvif(q, s));
    const http3 = http.createServer((q, s) => this.onBirddog(q, s));
    const http4 = http.createServer((q, s) => this.onWeb(q, s));
    for (const [srv, p] of [
      [http1, ports.panasonic],
      [http2, ports.onvif],
      [http3, ports.birddog],
      [http4, ports.web]
    ] as const) {
      await new Promise<void>((res) => srv.listen(p ?? 0, host, () => res()));
      this.httpServers.push(srv);
    }
    return {
      viscaUdp: (udp.address() as AddressInfo).port,
      viscaTcp: (tcp.address() as AddressInfo).port,
      panasonic: (http1.address() as AddressInfo).port,
      onvif: (http2.address() as AddressInfo).port,
      birddog: (http3.address() as AddressInfo).port,
      web: (http4.address() as AddressInfo).port
    };
  }

  /** Answers Sony's "ENQ:network" discovery on this UDP port. */
  async listenDiscovery(port = 52380, ip = '127.0.0.1'): Promise<void> {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('message', (m, r) => {
      if (!m.toString('latin1').includes('ENQ:network')) return;
      const reply = Buffer.from(`\x02MAC:02-00-00-00-00-01\xffINFO:SIM\xffMODEL:${this.model}\xffSOFTVERSION:1.00\xffIPADR:${ip}\xffMASK:255.255.255.0\xffNAME:${this.name}\xff\x03`, 'latin1');
      s.send(reply, r.port, r.address);
    });
    await new Promise<void>((res) => s.bind(port, () => res()));
    this.discovery = s;
  }

  async close(): Promise<void> {
    if (this.tick) clearInterval(this.tick);
    const udp = this.udp,
      disc = this.discovery,
      tcp = this.tcp;
    this.udp = this.discovery = null;
    this.tcp = null;
    udp?.close();
    disc?.close();
    await new Promise<void>((r) => (tcp ? tcp.close(() => r()) : r()));
    for (const s of this.httpServers) {
      s.closeAllConnections?.();
      await new Promise<void>((r) => s.close(() => r()));
    }
    this.httpServers = [];
  }

  // ---- VISCA ------------------------------------------------------------------------------------

  private onUdp(m: Buffer, r: dgram.RemoteInfo): void {
    if (m.length < 8) return;
    const type = m.readUInt16BE(0);
    const seq = m.readUInt32BE(4);
    const send = (payload: Buffer, t = 0x0111) => {
      const h = Buffer.alloc(8);
      h.writeUInt16BE(t, 0);
      h.writeUInt16BE(payload.length, 2);
      h.writeUInt32BE(seq, 4);
      this.udp?.send(Buffer.concat([h, payload]), r.port, r.address);
    };
    if (type === 0x0200) return send(Buffer.from([0x01]), 0x0201);
    for (const reply of this.visca(m.subarray(8), 'visca-udp')) send(reply);
  }

  private onTcp(s: net.Socket): void {
    let buf = Buffer.alloc(0);
    s.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const end = buf.indexOf(0xff);
        if (end < 0) break;
        const msg = buf.subarray(0, end + 1);
        buf = buf.subarray(end + 1);
        for (const r of this.visca(msg, 'visca-tcp')) s.write(r);
      }
    });
    s.on('error', () => {});
  }

  /** One VISCA message in, its replies out. */
  visca(p: Buffer, proto: string): Buffer[] {
    this.step();
    const ack = Buffer.from([0x90, 0x41, 0xff]);
    const done = Buffer.from([0x90, 0x51, 0xff]);
    const err = (code: number) => [Buffer.from([0x90, 0x60, code, 0xff])];
    const data = (...b: number[]) => [Buffer.from([0x90, 0x50, ...b, 0xff])];
    const nib4 = (v: number) => [(v >> 12) & 15, (v >> 8) & 15, (v >> 4) & 15, v & 15];
    const pq = (v: number) => [0, 0, (v >> 4) & 15, v & 15];
    const at = (i: number) => p[i] ?? -1;
    if (at(0) !== 0x81) return err(0x02);
    if (at(1) === 0x09) {
      this.inquiries++;
      const k = (at(2) << 8) | at(3);
      switch (k) {
        case 0x0002:
          return data(0x00, 0x01, 0x05, 0x19, 0x01, 0x00, 0x02);
        case 0x0400:
          return data(this.power ? 0x02 : 0x03);
        case 0x0612: {
          const pv = Math.round(this.pan * 0x0990) & 0xffff;
          const tv = Math.round(this.tilt * 0x0510) & 0xffff;
          return data(...nib4(pv), ...nib4(tv));
        }
        case 0x0447:
          return data(...nib4(Math.round(this.zoom * 0x4000)));
        case 0x0438:
          return data(this.focusAuto ? 0x02 : 0x03);
        case 0x0439:
          return data(this.ae);
        case 0x0435:
          return data(this.wb);
        case 0x044b:
          return data(...pq(this.iris));
        case 0x044c:
          return data(...pq(this.gain));
        case 0x044a:
          return data(...pq(this.shutter));
        case 0x0443:
          return data(...pq(this.rgain));
        case 0x0444:
          return data(...pq(this.bgain));
        case 0x0442:
          return data(...pq(this.aperture));
        case 0x044d:
          return data(...pq(this.brightness));
        case 0x0449:
          return data(0, 0, 0, this.saturation);
      }
      return err(0x02);
    }
    if (at(1) !== 0x01) return err(0x02);
    const k = (at(2) << 8) | at(3);
    const pqv = () => ((at(6) & 15) << 4) | (at(7) & 15);
    let what = '';
    switch (k) {
      case 0x0601: {
        const ps = at(4) / 0x18;
        const ts = at(5) / 0x17;
        this.vel.pan = at(6) === 1 ? -ps : at(6) === 2 ? ps : 0;
        this.vel.tilt = at(7) === 1 ? ts : at(7) === 2 ? -ts : 0;
        what = this.vel.pan || this.vel.tilt ? `pan-tilt ${this.vel.pan.toFixed(2)} ${this.vel.tilt.toFixed(2)}` : 'pan-tilt stop';
        break;
      }
      case 0x0604:
        this.pan = 0;
        this.tilt = 0;
        what = 'home';
        break;
      case 0x0407: {
        const v = at(4);
        this.vel.zoom = v === 0 ? 0 : (v >> 4 === 2 ? 1 : -1) * ((v & 15) + 1) / 8;
        what = v === 0 ? 'zoom stop' : `zoom ${this.vel.zoom.toFixed(2)}`;
        break;
      }
      case 0x0408: {
        const v = at(4);
        this.vel.focus = v === 0 ? 0 : (v >> 4 === 2 ? 1 : -1) * ((v & 15) + 1) / 8;
        what = v === 0 ? 'focus stop' : `focus ${this.vel.focus.toFixed(2)}`;
        break;
      }
      case 0x043f: {
        const n = at(5) + 1;
        if (at(4) === 0x01) {
          this.presets.set(n, { pan: this.pan, tilt: this.tilt, zoom: this.zoom });
          what = `store ${n}`;
        } else {
          const pr = this.presets.get(n);
          if (pr) Object.assign(this, pr);
          what = `recall ${n}`;
        }
        break;
      }
      case 0x0438:
        this.focusAuto = at(4) === 0x02;
        what = `focus ${this.focusAuto ? 'auto' : 'manual'}`;
        break;
      case 0x0418:
        what = 'one push af';
        break;
      case 0x0439:
        this.ae = at(4);
        what = `ae ${at(4)}`;
        break;
      case 0x0435:
        this.wb = at(4);
        what = `wb ${at(4)}`;
        break;
      case 0x0410:
        what = 'one push wb';
        break;
      case 0x044b:
        this.iris = pqv();
        what = `iris ${this.iris}`;
        break;
      case 0x044c:
        this.gain = pqv();
        what = `gain ${this.gain}`;
        break;
      case 0x044a:
        this.shutter = pqv();
        what = `shutter ${this.shutter}`;
        break;
      case 0x0443:
        this.rgain = pqv();
        what = `rgain ${this.rgain}`;
        break;
      case 0x0444:
        this.bgain = pqv();
        what = `bgain ${this.bgain}`;
        break;
      case 0x0442:
        this.aperture = pqv();
        what = `aperture ${this.aperture}`;
        break;
      case 0x044d:
        this.brightness = pqv();
        what = `brightness ${this.brightness}`;
        break;
      case 0x0449:
        this.saturation = at(7) & 15;
        what = `saturation ${this.saturation}`;
        break;
      default:
        return err(0x02);
    }
    this.cmd(proto, what);
    return [ack, done];
  }

  // ---- Panasonic ----------------------------------------------------------------------------------

  private authOk(req: http.IncomingMessage): boolean {
    if (!this.login) return true;
    const h = req.headers.authorization ?? '';
    return h === 'Basic ' + Buffer.from(`${this.login.user}:${this.login.password}`).toString('base64');
  }

  private onPanasonic(req: http.IncomingMessage, res: http.ServerResponse): void {
    const u = new URL(req.url ?? '/', 'http://x');
    const reply = (t: string, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(t);
    };
    if (!this.authOk(req)) return reply('', 401);
    this.step();
    const c = u.searchParams.get('cmd') ?? '';
    const hex = (v: number, n: number) => v.toString(16).toUpperCase().padStart(n, '0');
    if (u.pathname === '/cgi-bin/aw_ptz') {
      const m = c.replace(/^#/, '');
      if (m === 'O') return (this.inquiries++, reply(this.power ? 'p1' : 'p0'));
      if (m === 'APC') return (this.inquiries++, reply(`aPC${hex(Math.round(0x8000 + this.pan * 0x2000), 4)}${hex(Math.round(0x8000 + this.tilt * 0x1000), 4)}`));
      if (m === 'GZ') return (this.inquiries++, reply(`gz${hex(Math.round(0x555 + this.zoom * (0xfff - 0x555)), 3)}`));
      if (m === 'D1') return (this.inquiries++, reply(this.focusAuto ? 'd11' : 'd10'));
      let r: RegExpExecArray | null;
      if ((r = /^PTS(\d\d)(\d\d)$/.exec(m))) {
        this.vel.pan = (Number(r[1]) - 50) / 49;
        this.vel.tilt = (Number(r[2]) - 50) / 49;
        this.cmd('panasonic', this.vel.pan || this.vel.tilt ? `pan-tilt ${this.vel.pan.toFixed(2)} ${this.vel.tilt.toFixed(2)}` : 'pan-tilt stop');
        return reply(`pTS${r[1]}${r[2]}`);
      }
      if ((r = /^Z(\d\d)$/.exec(m))) {
        this.vel.zoom = (Number(r[1]) - 50) / 49;
        this.cmd('panasonic', this.vel.zoom ? `zoom ${this.vel.zoom.toFixed(2)}` : 'zoom stop');
        return reply(`zS${r[1]}`);
      }
      if ((r = /^F(\d\d)$/.exec(m))) {
        this.vel.focus = (Number(r[1]) - 50) / 49;
        this.cmd('panasonic', this.vel.focus ? `focus ${this.vel.focus.toFixed(2)}` : 'focus stop');
        return reply(`fS${r[1]}`);
      }
      if (m === 'APC80008000') {
        this.pan = this.tilt = 0;
        this.cmd('panasonic', 'home');
        return reply('aPC80008000');
      }
      if ((r = /^([RM])(\d\d)$/.exec(m))) {
        const n = Number(r[2]) + 1;
        if (r[1] === 'M') this.presets.set(n, { pan: this.pan, tilt: this.tilt, zoom: this.zoom });
        else Object.assign(this, this.presets.get(n) ?? {});
        this.cmd('panasonic', `${r[1] === 'M' ? 'store' : 'recall'} ${n}`);
        return reply(`${r[1] === 'M' ? 's' : 's'}${r[2]}`);
      }
      if (m === 'D11' || m === 'D10') {
        this.focusAuto = m === 'D11';
        this.cmd('panasonic', `focus ${this.focusAuto ? 'auto' : 'manual'}`);
        return reply(`d1${this.focusAuto ? 1 : 0}`);
      }
      return reply('ER1:' + m);
    }
    // RTMP push (AW-UE4/UE20/HE20 supplement): set and read need the admin login, start/stop/status are Live.
    if (u.pathname === '/cgi-bin/set_rtmp_param') {
      if (this.login && !req.headers.authorization) return reply('', 401);
      const type = u.searchParams.get('type');
      this.setRtmp({ url: u.searchParams.get('url') ?? '', key: type === '1' ? (u.searchParams.get('key') ?? '') : '' });
      this.cmd('panasonic', `RTMP ${this.rtmp.url} ${this.rtmp.key}`);
      return reply('OK');
    }
    if (u.pathname === '/cgi-bin/get_rtmp_param') return (this.inquiries++, reply(`type=1\r\nurl=${this.rtmp.url}\r\nkey=${this.rtmp.key}\r\n`));
    if (u.pathname === '/cgi-bin/get_rtmp_status') return (this.inquiries++, reply(`status=${this.rtmp.enabled ? 1 : 0}\r\n`));
    if (u.pathname === '/cgi-bin/rtmp_ctrl') {
      const c2 = u.searchParams.get('cmd');
      if (c2 !== 'start' && c2 !== 'stop') return reply('', 400);
      this.cmd('panasonic', `RTMP ${c2}`);
      this.setRtmp({ enabled: c2 === 'start' });
      return reply('OK');
    }
    if (u.pathname === '/cgi-bin/aw_cam') {
      const q: Record<string, () => string> = {
        QID: () => `OID:${this.model}`,
        QSV: () => 'OSV:1.00-00-0.00',
        QRS: () => `ORS:${this.ae === 0 ? 1 : 0}`,
        QRV: () => `ORV:${hex(Math.round((this.iris / 0x11) * 0x3ff), 3)}`,
        QGU: () => `OGU:${hex(this.ae === 0 ? 0x80 : 0x08 + this.gain * 3, 2)}`,
        QSH: () => `OSH:${hex(Math.min(11, this.shutter), 1)}`,
        QAW: () => `OAW:${this.wb === 5 ? 9 : 0}`,
        QRI: () => `ORI:${hex(0x800 + (this.rgain - 0x80), 3)}`,
        QBI: () => `OBI:${hex(0x800 + (this.bgain - 0x80), 3)}`,
        QDT: () => `ODT:${Math.min(2, this.aperture >> 2)}`
      };
      if (q[c]) {
        this.inquiries++;
        return reply(q[c]!());
      }
      const [k, v = ''] = c.split(':');
      const n = parseInt(v, 16);
      const set: Record<string, () => void> = {
        ORS: () => (this.ae = v === '1' ? 0 : 3),
        ORV: () => (this.iris = Math.round((n / 0x3ff) * 0x11)),
        OGU: () => (n === 0x80 ? (this.ae = 0) : ((this.ae = 3), (this.gain = Math.round((n - 8) / 3)))),
        OSH: () => (this.shutter = n),
        OAW: () => (this.wb = v === '9' ? 5 : 0),
        OWS: () => {},
        ORI: () => (this.rgain = n - 0x800 + 0x80),
        OBI: () => (this.bgain = n - 0x800 + 0x80),
        ODT: () => (this.aperture = Number(v) * 4),
        OSE: () => {}
      };
      if (set[k!]) {
        set[k!]!();
        this.cmd('panasonic', c);
        return reply(c);
      }
      return reply('ER1:' + c);
    }
    reply('', 404);
  }

  // ---- BirdDog ------------------------------------------------------------------------------------

  // ---- Sony and PTZOptics web CGI (RTMP only) ---------------------------------------------------------

  private setRtmp(change: Partial<SimRtmp>): void {
    const before = JSON.stringify(this.rtmp);
    this.rtmp = { ...this.rtmp, ...change };
    if (JSON.stringify(this.rtmp) !== before && this.rtmp.enabled && this.rtmp.url) {
      this.onRtmp?.(this.rtmp.key ? `${this.rtmp.url.replace(/\/$/, '')}/${this.rtmp.key}` : this.rtmp.url);
    }
  }

  private readonly nonce = crypto.randomBytes(8).toString('hex');

  /** HTTP Digest (MD5, qop=auth), as Sony and PTZOptics cameras ask. */
  private digestOk(req: http.IncomingMessage): boolean {
    if (!this.login) return true;
    const h = req.headers.authorization ?? '';
    if (!/^Digest /i.test(h)) return false;
    const p: Record<string, string> = {};
    for (const m of h.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) p[m[1]!] = m[2] ?? m[3] ?? '';
    const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
    const ha1 = md5(`${this.login.user}:sim:${this.login.password}`);
    const ha2 = md5(`${req.method}:${p.uri}`);
    return p.username === this.login.user && p.uri === req.url && p.nonce === this.nonce && p.response === md5(`${ha1}:${this.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
  }

  private onWeb(req: http.IncomingMessage, res: http.ServerResponse): void {
    const reply = (t: string, status = 200) => {
      res.writeHead(status, status === 401 ? { 'WWW-Authenticate': `Digest realm="sim", nonce="${this.nonce}", qop="auth"` } : { 'Content-Type': 'text/plain' });
      res.end(t);
    };
    if (!this.digestOk(req)) return reply('', 401);
    const u = new URL(req.url ?? '/', 'http://x');
    // Sony (SRG-XP1/XB25 CGI Command List): rtmp.cgi sets, inquiry.cgi?inqjs=rtmp reads.
    if (u.pathname === '/command/rtmp.cgi' && req.method === 'GET') {
      const url = u.searchParams.get('RTMPURL');
      const en = u.searchParams.get('RTMPEnable');
      this.cmd('sony-cgi', `RTMP ${url ?? ''} ${en ?? ''}`.trim());
      this.setRtmp({ ...(url !== null ? { url, key: '' } : {}), ...(en === 'on' || en === 'off' ? { enabled: en === 'on' } : {}) });
      return reply('');
    }
    if (u.pathname === '/command/inquiry.cgi' && u.searchParams.get('inqjs') === 'rtmp') {
      this.inquiries++;
      return reply(`var RTMPURL="${this.rtmp.url}";\nvar RTMPEnable="${this.rtmp.enabled ? 'on' : 'off'}";\nvar RTMPStatus="${this.rtmp.enabled ? 'Connection success' : 'RTMP disable'}";\n`);
    }
    // PTZOptics (docs.ptzoptics.com HTTP API): POST param.cgi?post_network_other_conf&rtmp1_*=
    if (u.pathname === '/cgi-bin/param.cgi' && req.method === 'POST' && u.search.startsWith('?post_network_other_conf&')) {
      const v = (k: string) => u.searchParams.get(k);
      this.cmd('ptzoptics-cgi', `RTMP ${u.search.slice('?post_network_other_conf&'.length)}`);
      if (v('rtmp1_mrl') !== null) this.setRtmp({ url: v('rtmp1_mrl')! });
      if (v('rtmp1_key') !== null) this.setRtmp({ key: v('rtmp1_key')! });
      if (v('rtmp1_en') !== null) this.setRtmp({ enabled: v('rtmp1_en') === '1' });
      return reply('');
    }
    reply('', 404);
  }

  private onBirddog(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url === '/about') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ HostName: this.name, FirmwareVersion: '5.5.110', HardwareVersion: this.model, Format: '1080p59.94' }));
    }
    res.writeHead(404);
    res.end();
  }

  // ---- ONVIF ---------------------------------------------------------------------------------------

  private async onOnvif(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parts: Buffer[] = [];
    for await (const d of req) parts.push(d as Buffer);
    const send = (status: number, x: string) => {
      res.writeHead(status, { 'Content-Type': 'application/soap+xml' });
      res.end(x);
    };
    let doc;
    try {
      doc = parseXml(Buffer.concat(parts).toString('utf8'));
    } catch {
      return send(400, fault('Sender', 'ter:WellFormed', 'Bad XML'));
    }
    const op = find(doc, 'Body')?.children[0];
    if (!op) return send(400, fault('Sender', 'ter:InvalidArgVal', 'Empty'));
    if (this.login && op.name !== 'GetSystemDateAndTime' && !checkSecurity(doc, this.login.user, this.login.password)) return send(400, fault('Sender', 'ter:NotAuthorized', 'Sender not authorized'));
    this.step();
    const port = (req.socket.localPort ?? 80).toString();
    const base = `http://127.0.0.1:${port}/onvif`;
    const ok = (x: string) => send(200, envelope(x));
    const c = (v: number) => Math.max(-1, Math.min(1, v));
    switch (op.name) {
      case 'GetSystemDateAndTime': {
        this.inquiries++;
        const d = new Date();
        return ok(`<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:UTCDateTime><tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`);
      }
      case 'GetCapabilities':
        this.inquiries++;
        return ok(`<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Media><tt:XAddr>${base}/media</tt:XAddr></tt:Media><tt:PTZ><tt:XAddr>${base}/ptz</tt:XAddr></tt:PTZ><tt:Imaging><tt:XAddr>${base}/imaging</tt:XAddr></tt:Imaging></tds:Capabilities></tds:GetCapabilitiesResponse>`);
      case 'GetDeviceInformation':
        this.inquiries++;
        return ok(`<tds:GetDeviceInformationResponse><tds:Manufacturer>SimCam</tds:Manufacturer><tds:Model>${this.model}</tds:Model><tds:FirmwareVersion>2.1</tds:FirmwareVersion><tds:SerialNumber>SIM1</tds:SerialNumber></tds:GetDeviceInformationResponse>`);
      case 'GetProfiles':
        this.inquiries++;
        return ok(`<trt:GetProfilesResponse><trt:Profiles token="P1"><tt:Name>main</tt:Name><tt:VideoSourceConfiguration token="V1"><tt:SourceToken>VS1</tt:SourceToken></tt:VideoSourceConfiguration><tt:PTZConfiguration token="Z1"/></trt:Profiles></trt:GetProfilesResponse>`);
      case 'GetStreamUri':
        this.inquiries++;
        return ok(`<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://127.0.0.1:554/sim</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>`);
      case 'GetStatus':
        this.inquiries++;
        return ok(`<tptz:GetStatusResponse><tptz:PTZStatus><tt:Position><tt:PanTilt x="${this.pan.toFixed(3)}" y="${this.tilt.toFixed(3)}"/><tt:Zoom x="${this.zoom.toFixed(3)}"/></tt:Position></tptz:PTZStatus></tptz:GetStatusResponse>`);
      case 'GetPresets':
        this.inquiries++;
        return ok(`<tptz:GetPresetsResponse>${[...this.presets.keys()].sort((a, b) => a - b).map((n) => `<tptz:Preset token="${n}"><tt:Name>${n}</tt:Name></tptz:Preset>`).join('')}</tptz:GetPresetsResponse>`);
      case 'GetOptions':
        this.inquiries++;
        return ok(
          `<timg:GetOptionsResponse><timg:ImagingOptions><tt:Brightness><tt:Min>0</tt:Min><tt:Max>100</tt:Max></tt:Brightness><tt:ColorSaturation><tt:Min>0</tt:Min><tt:Max>100</tt:Max></tt:ColorSaturation><tt:Contrast><tt:Min>0</tt:Min><tt:Max>100</tt:Max></tt:Contrast><tt:Sharpness><tt:Min>0</tt:Min><tt:Max>100</tt:Max></tt:Sharpness>` +
            `<tt:Exposure><tt:Mode>AUTO</tt:Mode><tt:Mode>MANUAL</tt:Mode><tt:Gain><tt:Min>0</tt:Min><tt:Max>36</tt:Max></tt:Gain><tt:Iris><tt:Min>-22</tt:Min><tt:Max>0</tt:Max></tt:Iris><tt:ExposureTime><tt:Min>100</tt:Min><tt:Max>40000</tt:Max></tt:ExposureTime></tt:Exposure>` +
            `<tt:WhiteBalance><tt:Mode>AUTO</tt:Mode><tt:Mode>MANUAL</tt:Mode><tt:YrGain><tt:Min>0</tt:Min><tt:Max>255</tt:Max></tt:YrGain><tt:YbGain><tt:Min>0</tt:Min><tt:Max>255</tt:Max></tt:YbGain></tt:WhiteBalance><tt:Focus><tt:AutoFocusModes>AUTO</tt:AutoFocusModes><tt:AutoFocusModes>MANUAL</tt:AutoFocusModes></tt:Focus></timg:ImagingOptions></timg:GetOptionsResponse>`
        );
      case 'GetImagingSettings':
        this.inquiries++;
        return ok(
          `<timg:GetImagingSettingsResponse><timg:ImagingSettings><tt:Brightness>${this.brightness * 3}</tt:Brightness><tt:ColorSaturation>${this.saturation * 7}</tt:ColorSaturation><tt:Contrast>50</tt:Contrast><tt:Sharpness>${this.aperture * 6}</tt:Sharpness>` +
            `<tt:Exposure><tt:Mode>${this.ae === 3 ? 'MANUAL' : 'AUTO'}</tt:Mode><tt:Gain>${this.gain * 3}</tt:Gain><tt:Iris>${this.iris - 0x11}</tt:Iris><tt:ExposureTime>${this.shutter * 1000}</tt:ExposureTime></tt:Exposure>` +
            `<tt:WhiteBalance><tt:Mode>${this.wb === 5 ? 'MANUAL' : 'AUTO'}</tt:Mode><tt:CrGain>${this.rgain}</tt:CrGain><tt:CbGain>${this.bgain}</tt:CbGain></tt:WhiteBalance><tt:Focus><tt:AutoFocusMode>${this.focusAuto ? 'AUTO' : 'MANUAL'}</tt:AutoFocusMode></tt:Focus></timg:ImagingSettings></timg:GetImagingSettingsResponse>`
        );
      case 'SetImagingSettings': {
        const s = find(op, 'ImagingSettings');
        const n = (...p: string[]) => Number(text(s, ...p));
        if (text(s, 'Brightness')) this.brightness = Math.round(n('Brightness') / 3);
        if (text(s, 'ColorSaturation')) this.saturation = Math.round(n('ColorSaturation') / 7);
        if (text(s, 'Sharpness')) this.aperture = Math.round(n('Sharpness') / 6);
        if (text(s, 'Exposure', 'Mode')) this.ae = text(s, 'Exposure', 'Mode') === 'MANUAL' ? 3 : 0;
        if (text(s, 'Exposure', 'Gain')) this.gain = Math.round(n('Exposure', 'Gain') / 3);
        if (text(s, 'Exposure', 'Iris')) this.iris = n('Exposure', 'Iris') + 0x11;
        if (text(s, 'WhiteBalance', 'Mode')) this.wb = text(s, 'WhiteBalance', 'Mode') === 'MANUAL' ? 5 : 0;
        if (text(s, 'WhiteBalance', 'CrGain')) this.rgain = n('WhiteBalance', 'CrGain');
        if (text(s, 'WhiteBalance', 'CbGain')) this.bgain = n('WhiteBalance', 'CbGain');
        if (text(s, 'Focus', 'AutoFocusMode')) this.focusAuto = text(s, 'Focus', 'AutoFocusMode') === 'AUTO';
        this.cmd('onvif', 'SetImagingSettings');
        return ok('<timg:SetImagingSettingsResponse/>');
      }
      case 'ContinuousMove': {
        const pt = find(op, 'PanTilt');
        const z = find(op, 'Zoom');
        this.vel.pan = c(Number(pt?.attrs.x ?? 0));
        this.vel.tilt = c(Number(pt?.attrs.y ?? 0));
        this.vel.zoom = c(Number(z?.attrs.x ?? 0));
        this.cmd('onvif', `move ${this.vel.pan.toFixed(2)} ${this.vel.tilt.toFixed(2)} ${this.vel.zoom.toFixed(2)}`);
        return ok('<tptz:ContinuousMoveResponse/>');
      }
      case 'Stop':
        if (/imaging/.test(req.url ?? '')) {
          this.vel.focus = 0;
          this.cmd('onvif', 'focus stop');
          return ok('<timg:StopResponse/>');
        }
        this.vel.pan = this.vel.tilt = this.vel.zoom = 0;
        this.cmd('onvif', 'stop');
        return ok('<tptz:StopResponse/>');
      case 'GotoHomePosition':
        this.pan = this.tilt = 0;
        this.cmd('onvif', 'home');
        return ok('<tptz:GotoHomePositionResponse/>');
      case 'GotoPreset': {
        const n = Number(text(op, 'PresetToken'));
        Object.assign(this, this.presets.get(n) ?? {});
        this.cmd('onvif', `recall ${n}`);
        return ok('<tptz:GotoPresetResponse/>');
      }
      case 'SetPreset': {
        const n = Number(text(op, 'PresetToken') || text(op, 'PresetName'));
        this.presets.set(n, { pan: this.pan, tilt: this.tilt, zoom: this.zoom });
        this.cmd('onvif', `store ${n}`);
        return ok(`<tptz:SetPresetResponse><tptz:PresetToken>${n}</tptz:PresetToken></tptz:SetPresetResponse>`);
      }
      case 'Move': {
        const sp = Number(text(op, 'Speed'));
        this.vel.focus = -sp;
        this.cmd('onvif', `focus ${(-sp).toFixed(2)}`);
        return ok('<timg:MoveResponse/>');
      }
    }
    send(400, fault('Receiver', 'ter:ActionNotSupported', op.name));
  }
}
