// Setting a camera's own RTMP push destination to this unit, through the camera's web API, with its login.
// Only an operator's confirmed action calls set(); read() only reads.
//
//   Panasonic  /cgi-bin/set_rtmp_param?type=1&url=&key=, rtmp_ctrl?cmd=stop|start, get_rtmp_param, get_rtmp_status
//              (Integrated Camera Interface Specifications, supplement for AW-UE4/UE20/HE20; Admin login)
//   Sony       /command/rtmp.cgi?RTMPURL=&RTMPEnable=on, inquiry.cgi?inqjs=rtmp
//              (CGI Command List, SRG-XP1/XB25 v1.20; Digest; no separate key, so the URL carries it)
//   PTZOptics  POST /cgi-bin/param.cgi?post_network_other_conf&rtmp1_mrl= / rtmp1_key= / rtmp1_en=1
//              (docs.ptzoptics.com HTTP API: Move 4K, Link 4K, Move SE, Studio Pro; Digest; nothing to read back)
//
// BirdDog's API has no RTMP settings, and ONVIF and plain VISCA have no way to set a push destination.

import type { Brand, Credentials } from './types.js';
import { request } from './http.js';

export interface RtmpSetting {
  /** The server URL the camera pushes to (with the key when the camera keeps them together). */
  url: string;
  key: string;
  enabled: boolean | null;
  /** The camera's own words on the stream, when it reports them. */
  status: string;
}

export interface RtmpSetup {
  /** Who documents it, for the page. */
  models: string;
  /** Can the setting be read back? */
  readable: boolean;
  read(host: string, port: number, login: Credentials | null): Promise<RtmpSetting>;
  set(host: string, port: number, login: Credentials | null, server: string, key: string): Promise<void>;
}

/** name=value lines, `var name="value";` or name=value&... into a map. */
export function parseKv(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(?:var\s+)?([A-Za-z_][\w]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^&\r\n;]*))/g)) {
    out[m[1]!] = (m[2] ?? m[3] ?? m[4] ?? '').trim();
  }
  return out;
}

const q = encodeURIComponent;

const panasonic: RtmpSetup = {
  models: 'Panasonic AW-UE4, AW-UE20 and AW-HE20 document it; other AW models may answer the same commands',
  readable: true,
  async read(host, port, login) {
    const p = parseKv((await request('GET', host, port, '/cgi-bin/get_rtmp_param', login)).body);
    let status = '';
    try {
      const s = parseKv((await request('GET', host, port, '/cgi-bin/get_rtmp_status', login)).body).status;
      status = s === '1' ? 'Streaming' : s === '0' ? 'Stopped' : '';
    } catch {}
    return { url: p.url ?? '', key: p.key ?? '', enabled: status ? status === 'Streaming' : null, status };
  },
  async set(host, port, login, server, key) {
    // Stop, set, start: the new destination takes effect on the next start.
    await request('GET', host, port, '/cgi-bin/rtmp_ctrl?cmd=stop', login).catch(() => {});
    await request('GET', host, port, `/cgi-bin/set_rtmp_param?type=1&url=${q(server)}&key=${q(key)}`, login);
    await request('GET', host, port, '/cgi-bin/rtmp_ctrl?cmd=start', login);
  }
};

const sony: RtmpSetup = {
  models: 'Sony documents it for the SRG-XP1 and SRG-XB25; other models with RTMP may answer the same commands',
  readable: true,
  async read(host, port, login) {
    const p = parseKv((await request('GET', host, port, '/command/inquiry.cgi?inqjs=rtmp', login)).body);
    const en = p.RTMPEnable;
    return { url: p.RTMPURL ?? '', key: '', enabled: en === 'on' ? true : en === 'off' ? false : null, status: p.RTMPStatus ?? '' };
  },
  async set(host, port, login, server, key) {
    await request('GET', host, port, `/command/rtmp.cgi?RTMPURL=${q(`${server}/${key}`)}&RTMPEnable=on`, login);
  }
};

const ptzoptics: RtmpSetup = {
  models: 'PTZOptics documents it for the Move 4K, Link 4K, Move SE and Studio Pro',
  readable: false,
  async read() {
    throw new Error('PTZOptics cameras have no documented command to read the RTMP setting');
  },
  async set(host, port, login, server, key) {
    const post = (kv: string) => request('POST', host, port, `/cgi-bin/param.cgi?post_network_other_conf&${kv}`, login);
    await post(`rtmp1_mrl=${q(server)}`);
    await post(`rtmp1_key=${q(key)}`);
    await post('rtmp1_en=1');
  }
};

const SETUPS: Partial<Record<Brand, RtmpSetup>> = { panasonic, sony, ptzoptics };

export function rtmpSetupFor(brand: Brand): RtmpSetup | null {
  return SETUPS[brand] ?? null;
}

/** Why a brand can't be set from here. */
export function rtmpSetupMissing(brand: Brand): string {
  if (brand === 'birddog') return 'BirdDog’s API has no RTMP settings: set the push address in the camera’s web page';
  if (brand === 'onvif') return 'ONVIF has no command for a push address: set it in the camera’s web page';
  return 'VISCA has no command for a push address: set it in the camera’s web page';
}
