// Scan network: finds PTZ cameras on the unit's subnets. Everything here only asks; nothing is changed on any
// device, and nothing is added until the operator picks it.
//
//   ONVIF          WS-Discovery Probe to 239.255.255.250:3702 (NetworkVideoTransmitter)
//   Sony VISCA     "ENQ:network" broadcast to UDP 52380, as Sony's IP setup tools do
//   NDI (BirdDog)  mDNS query for _ndi._tcp.local
//   Each address   on each /24 (or the one given): VISCA version inquiry on UDP 52381, a TCP connect to 5678
//                  (VISCA over TCP), the Panasonic power query on HTTP 80, BirdDog's GET /about on 8080

import { randomUUID } from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import type { Brand, Protocol } from './cameras/types.js';
import { findAll, parseXml, text } from './onvif/xml.js';

export interface Found {
  host: string;
  brand: Brand;
  protocol: Protocol;
  port: number;
  name: string;
  model: string;
  /** How it was found, for the list. */
  via: string[];
}

export interface ScanOptions {
  /** "10.0.0.0/24", "10.0.0.7" or empty for every /24 the unit is on. */
  target?: string;
  timeoutMs?: number;
  /** Ports, for tests against a simulator. */
  ports?: Partial<{ viscaUdp: number; viscaTcp: number; panasonic: number; birddog: number; sonyDiscovery: number; wsd: number; mdns: number }>;
  /** Leave out the multicast and broadcast parts (tests). */
  unicastOnly?: boolean;
}

const PORTS = { viscaUdp: 52381, viscaTcp: 5678, panasonic: 80, birddog: 8080, sonyDiscovery: 52380, wsd: 3702, mdns: 5353 };

/** Addresses to probe one by one. */
export function targets(target = ''): string[] {
  const t = target.trim();
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)(?:\/(\d+))?$/.exec(t);
  if (m) {
    const bits = m[5] === undefined ? 32 : Math.max(22, Math.min(32, Number(m[5])));
    const base = ((+m[1]! << 24) | (+m[2]! << 16) | (+m[3]! << 8) | +m[4]!) >>> 0;
    const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
    const net0 = (base & mask) >>> 0;
    const n = 2 ** (32 - bits);
    const out: string[] = [];
    for (let i = n === 1 ? 0 : 1; i < (n === 1 ? 1 : n - 1); i++) {
      const a = (net0 + i) >>> 0;
      out.push(`${a >>> 24}.${(a >> 16) & 255}.${(a >> 8) & 255}.${a & 255}`);
    }
    return out;
  }
  if (t) return [];
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const p = a.address.split('.');
      for (let i = 1; i < 255; i++) out.add(`${p[0]}.${p[1]}.${p[2]}.${i}`);
    }
  }
  return [...out];
}

function broadcasts(): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((x, i) => (x | (~mask[i]! & 255)) & 255).join('.'));
    }
  }
  return [...out];
}

export async function scan(o: ScanOptions = {}): Promise<Found[]> {
  const ports = { ...PORTS, ...o.ports };
  const timeout = o.timeoutMs ?? 2500;
  const found = new Map<string, Found>();
  const add = (f: Omit<Found, 'via'> & { via: string }) => {
    const prev = found.get(f.host);
    if (!prev) return void found.set(f.host, { ...f, via: [f.via] });
    // Keep the most specific: a brand beats a generic finding, a name and model fill in.
    const rank = (b: Brand) => (b === 'visca' || b === 'onvif' ? 0 : 1);
    if (rank(f.brand) > rank(prev.brand)) Object.assign(prev, { brand: f.brand, protocol: f.protocol, port: f.port });
    if (!prev.name && f.name) prev.name = f.name;
    if (!prev.model && f.model) prev.model = f.model;
    if (!prev.via.includes(f.via)) prev.via.push(f.via);
  };
  const list = targets(o.target);
  const jobs: Promise<void>[] = [probeEach(list, ports, Math.min(timeout, 1200), add)];
  if (!o.unicastOnly) jobs.push(wsDiscovery(ports.wsd, timeout, add), sonyDiscovery(ports.sonyDiscovery, timeout, add), mdnsNdi(ports.mdns, timeout, add));
  await Promise.all(jobs.map((j) => j.catch(() => {})));
  return [...found.values()].sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}

type Add = (f: Omit<Found, 'via'> & { via: string }) => void;

function wsDiscovery(port: number, timeout: number, add: Add): Promise<void> {
  return new Promise((resolve) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const id = randomUUID();
    const probe =
      `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">` +
      `<s:Header><a:Action s:mustUnderstand="1">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action><a:MessageID>urn:uuid:${id}</a:MessageID><a:To s:mustUnderstand="1">urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To></s:Header>` +
      `<s:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></s:Body></s:Envelope>`;
    s.on('message', (m, r) => {
      try {
        const doc = parseXml(m.toString('utf8'));
        for (const pm of findAll(doc, 'ProbeMatch')) {
          const xaddr = text(pm, 'XAddrs').split(/\s+/)[0] ?? '';
          let host = r.address;
          let p = 80;
          try {
            const u = new URL(xaddr);
            host = u.hostname;
            p = Number(u.port) || 80;
          } catch {}
          const scopes = text(pm, 'Scopes');
          const name = decodeURIComponent(/onvif:\/\/www\.onvif\.org\/name\/(\S+)/.exec(scopes)?.[1] ?? '').replace(/_/g, ' ');
          const hw = decodeURIComponent(/onvif:\/\/www\.onvif\.org\/hardware\/(\S+)/.exec(scopes)?.[1] ?? '');
          add({ host, brand: 'onvif', protocol: 'onvif', port: p, name, model: hw, via: 'ONVIF' });
        }
      } catch {}
    });
    s.on('error', () => resolve());
    s.bind(0, () => {
      try {
        s.send(probe, port, '239.255.255.250');
      } catch {}
      setTimeout(() => {
        s.close();
        resolve();
      }, timeout);
    });
  });
}

/** Sony's discovery: reply fields are NAME:value, separated by 0xFF. */
export function parseSonyReply(m: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of m.toString('latin1').replace(/^\x02|\x03$/g, '').split('\xff')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

function sonyDiscovery(port: number, timeout: number, add: Add): Promise<void> {
  return new Promise((resolve) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('message', (m, r) => {
      const f = parseSonyReply(m);
      if (!f.MAC && !f.MODEL) return;
      add({ host: f.IPADR || r.address, brand: 'sony', protocol: 'visca-udp', port: 52381, name: f.NAME ?? '', model: f.MODEL ?? '', via: 'Sony discovery' });
    });
    s.on('error', () => resolve());
    s.bind(0, () => {
      s.setBroadcast(true);
      const q = Buffer.from('\x02ENQ:network\xff\x03', 'latin1');
      for (const b of broadcasts()) s.send(q, port, b, () => {});
      setTimeout(() => {
        s.close();
        resolve();
      }, timeout);
    });
  });
}

/** One mDNS PTR question for _ndi._tcp.local; NDI senders (BirdDog among them) answer with their names. */
function mdnsNdi(port: number, timeout: number, add: Add): Promise<void> {
  return new Promise((resolve) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const q = Buffer.concat([
      Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
      ...'_ndi._tcp.local'.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])),
      Buffer.from([0, 0, 12, 0, 1])
    ]);
    s.on('message', (m, r) => {
      const names = dnsNames(m);
      const ndi = names.find((n) => /_ndi\._tcp/i.test(n) && !/^_ndi/i.test(n));
      if (!ndi) return;
      const name = ndi.replace(/\._ndi\._tcp\.local\.?$/i, '');
      const bird = /birddog|^bd-|P\d{3}/i.test(name);
      if (!bird) return; // other NDI senders aren't PTZ cameras we can drive from this alone
      add({ host: r.address, brand: 'birddog', protocol: 'visca-udp', port: 52381, name, model: '', via: 'NDI' });
    });
    s.on('error', () => resolve());
    s.bind(0, () => {
      s.send(q, port, '224.0.0.251', () => {});
      setTimeout(() => {
        s.close();
        resolve();
      }, timeout);
    });
  });
}

/** Every name in a DNS message's answers (labels with compression). */
function dnsNames(m: Buffer): string[] {
  const out: string[] = [];
  const name = (at: number, depth = 0): [string, number] => {
    const labels: string[] = [];
    let end = -1;
    while (at < m.length && depth < 20) {
      const len = m[at]!;
      if (len === 0) {
        at++;
        break;
      }
      if ((len & 0xc0) === 0xc0) {
        if (end < 0) end = at + 2;
        at = ((len & 0x3f) << 8) | m[at + 1]!;
        depth++;
        continue;
      }
      labels.push(m.toString('utf8', at + 1, at + 1 + len));
      at += 1 + len;
    }
    return [labels.join('.'), end >= 0 ? end : at];
  };
  try {
    const qd = m.readUInt16BE(4);
    const an = m.readUInt16BE(6) + m.readUInt16BE(8) + m.readUInt16BE(10);
    let at = 12;
    for (let i = 0; i < qd; i++) at = name(at)[1] + 4;
    for (let i = 0; i < an && at < m.length; i++) {
      const [n, next] = name(at);
      const type = m.readUInt16BE(next);
      const rdlen = m.readUInt16BE(next + 8);
      out.push(n);
      if (type === 12) out.push(name(next + 10)[0]);
      at = next + 10 + rdlen;
    }
  } catch {}
  return out;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!).catch(() => {});
    })
  );
}

function tcpOpen(host: string, port: number, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeout, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

function httpGet(host: string, port: number, path: string, timeout: number): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path, timeout }, (res) => {
      const parts: Buffer[] = [];
      let n = 0;
      res.on('data', (d: Buffer) => {
        n += d.length;
        if (n < 65536) parts.push(d);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8') }));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

async function probeEach(list: string[], ports: typeof PORTS, timeout: number, add: Add): Promise<void> {
  // VISCA over IP: one socket, a version inquiry to every address; whoever answers speaks VISCA.
  const udp = dgram.createSocket('udp4');
  udp.on('message', (m, r) => {
    if (m.length < 8 || m.readUInt16BE(0) !== 0x0111) return;
    const p = m.subarray(8);
    const vendor = p.length >= 10 && p[1] === 0x50 ? p.readUInt16BE(2) : -1;
    add({ host: r.address, brand: vendor === 1 ? 'sony' : 'visca', protocol: 'visca-udp', port: ports.viscaUdp, name: '', model: vendor === 1 ? `Sony model ${p.readUInt16BE(4).toString(16)}` : '', via: 'VISCA over IP' });
  });
  udp.on('error', () => {});
  await new Promise<void>((r) => udp.bind(0, () => r()));
  const inq = Buffer.from([0x01, 0x10, 0x00, 0x05, 0, 0, 0, 1, 0x81, 0x09, 0x00, 0x02, 0xff]);
  for (const host of list) udp.send(inq, ports.viscaUdp, host, () => {});

  await pool(list, 48, async (host) => {
    const [tcp, pana, bird] = await Promise.all([
      tcpOpen(host, ports.viscaTcp, timeout),
      httpGet(host, ports.panasonic, '/cgi-bin/aw_ptz?cmd=%23O&res=1', timeout),
      httpGet(host, ports.birddog, '/about', timeout)
    ]);
    if (pana?.status === 200 && /^p[013]\b/.test(pana.body.trim())) add({ host, brand: 'panasonic', protocol: 'panasonic', port: ports.panasonic, name: '', model: '', via: 'Panasonic HTTP' });
    if (bird?.status === 200) {
      try {
        const j = JSON.parse(bird.body);
        if (j && typeof j === 'object' && ('FirmwareVersion' in j || 'HostName' in j)) add({ host, brand: 'birddog', protocol: 'visca-udp', port: ports.viscaUdp, name: String(j.HostName ?? ''), model: String(j.HardwareVersion ?? ''), via: 'BirdDog API' });
      } catch {}
    }
    if (tcp) add({ host, brand: 'ptzoptics', protocol: 'visca-tcp', port: ports.viscaTcp, name: '', model: '', via: 'VISCA TCP port open' });
  });
  await new Promise((r) => setTimeout(r, 200));
  udp.close();
  // TCP 5678 alone is weak evidence: keep it only when nothing better named the address.
}

