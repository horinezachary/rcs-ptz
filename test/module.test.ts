// The module against simulated cameras and the SDK's fake controller: the source-of-truth rules (start,
// restore and reconnect only read; commands only on an operator action with Allow controls on), every
// protocol, the keys, the picture settings, live video, the ONVIF bridge and the network scan.
import net from 'node:net';
import { startTestModule, type TestModule } from '@rcs/module-sdk/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import mod, { KEY, layout, UI_HOLD_MS, type Config, type Entry, type State } from '../src/index.js';
import { OnvifDriver } from '../src/cameras/onvif.js';
import type { Protocol, Brand } from '../src/cameras/types.js';
import { SimCamera, type SimPorts } from '../src/sim/camera.js';
import { SimPusher } from '../src/sim/push.js';

let sim: TestModule<State, Config> | null = null;
const cleanups: (() => Promise<void> | void)[] = [];

beforeAll(() => {
  process.env.RCS_PTZ_POLL_MS = '100';
});

afterEach(async () => {
  await sim?.close();
  sim = null;
  while (cleanups.length) await cleanups.pop()!();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 5000, what = ''): Promise<void> {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error(`timed out ${what}: ${JSON.stringify(last()?.cameras?.map((c: any) => [c.name, c.reachable, c.lastError]))} ${sim?.errors.map(String)}`);
    await wait(10);
  }
}

const last = () => (sim ? [...sim.uiMessages].reverse().find((m) => m.message?.type === 'snapshot')?.message : null);
const camView = (id: string) => last()?.cameras.find((c: any) => c.id === id);

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

async function camera(name = 'Cam A') {
  const c = new SimCamera(name);
  const ports = await c.listen();
  cleanups.push(() => c.close());
  return { c, ports };
}

const PORT_OF: Record<Protocol, keyof SimPorts> = { 'visca-udp': 'viscaUdp', 'visca-tcp': 'viscaTcp', panasonic: 'panasonic', onvif: 'onvif' };

function entry(id: string, ports: SimPorts, protocol: Protocol = 'visca-udp', brand: Brand = 'sony', video: Entry['video'] = { mode: 'none', url: '', key: id }): Entry {
  return { id, name: `Cam ${id.slice(-1)}`, brand, protocol, host: '127.0.0.1', port: ports[PORT_OF[protocol]], video, invertPan: false, invertTilt: false, presetNames: [], webPort: 0 };
}

async function start(cameras: Entry[], extra: { allow?: boolean; state?: State; reason?: 'boot' | 'restore' | 'user'; rtmpPort?: number; bridge?: Config['bridge']; secrets?: Record<string, unknown>; deck?: { columns: number; rows: number } } = {}) {
  const config: Config = {
    cameras,
    allowControls: extra.allow ?? false,
    liveVideo: 'all',
    rtmpPort: extra.rtmpPort ?? (await freePort()),
    bridge: extra.bridge ?? { enabled: false, basePort: 8000, rtspPort: 8554, discovery: false }
  };
  sim = await startTestModule(mod, { config, state: extra.state, reason: extra.reason, secrets: extra.secrets, deck: extra.deck });
  await sim.settle();
  await until(() => last()?.cameras?.length === cameras.length && last().cameras.every((c: any) => c.read && c.reachable), 6000, 'for the cameras');
  await sim.settle();
  return sim;
}

const moves = (c: SimCamera) => c.commands.map((x) => x.what);

describe('the camera is the source of truth', () => {
  it.each(['boot', 'restore', 'user'] as const)('only reads on a %s start, whatever the save says', async (reason) => {
    const { c, ports } = await camera();
    await start([entry('00000001', ports)], { allow: true, reason, state: { cam: '00000001', keyMode: 'picture', speed: 'fast' } });
    await wait(500);
    expect(c.commands).toEqual([]);
    expect(c.inquiries).toBeGreaterThan(5);
    expect(Object.keys(sim!.state).sort()).toEqual(['cam', 'keyMode', 'speed']);
    expect(sim!.state.speed).toBe('fast');
    // Nothing read from the camera goes into config.
    expect(JSON.stringify(sim!.config)).not.toMatch(/BRC|Sony|SIM-PTZ|power/);
    expect(sim!.secrets).toEqual({});
  });

  it('reconnect only reads', async () => {
    const { c, ports } = await camera();
    await start([entry('00000001', ports)], { allow: true });
    await sim!.sendUi({ type: 'reconnect' });
    await wait(300);
    expect(c.commands).toEqual([]);
  });

  it('shows a camera that does not answer, and sends nothing to the others', async () => {
    const { c, ports } = await camera();
    const gone = await camera('Gone');
    const gonePorts = { ...gone.ports };
    await gone.c.close();
    const config: Config = { cameras: [entry('00000001', ports, 'visca-tcp', 'ptzoptics'), entry('00000002', gonePorts, 'visca-udp')], allowControls: true, liveVideo: 'all', rtmpPort: await freePort(), bridge: { enabled: false, basePort: 8000, rtspPort: 8554, discovery: false } };
    sim = await startTestModule(mod, { config });
    await until(() => /Connection refused|No answer/.test(camView('00000002')?.lastError ?? ''), 4000, 'for the error');
    expect(camView('00000001').reachable).toBe(true);
    expect(c.commands).toEqual([]);
    expect(sim.status?.connection).toBe('connecting');
  });
});

describe('every protocol reads the camera', () => {
  it.each([
    ['visca-udp', 'sony'],
    ['visca-tcp', 'ptzoptics'],
    ['visca-udp', 'birddog'],
    ['panasonic', 'panasonic'],
    ['onvif', 'onvif']
  ] as [Protocol, Brand][])('%s (%s): identity, position and picture settings', async (protocol, brand) => {
    const { c, ports } = await camera('Stage Left');
    c.pan = 0.5;
    c.zoom = 0.25;
    const e = entry('00000001', ports, protocol, brand);
    // The BirdDog's REST API is on another port here than on a real camera.
    const s = await start([e]);
    const v = camView('00000001');
    expect(v.identity.vendor).toMatch(protocol === 'panasonic' ? /Panasonic/ : protocol === 'onvif' ? /SimCam/ : brand === 'birddog' ? /BirdDog|Sony/ : /Sony|PTZOptics/);
    expect(v.status.power).toBe('on');
    expect(v.status.zoom).toBeCloseTo(0.25, 1);
    const ids = v.picture.map((p: any) => p.id);
    if (protocol === 'onvif') expect(ids).toEqual(expect.arrayContaining(['exposureMode', 'iris', 'gain', 'wbMode', 'crGain', 'cbGain', 'focus']));
    else expect(ids).toEqual(expect.arrayContaining(['iris', 'gain', 'shutter', 'wb', 'rgain', 'bgain', 'focus']));
    expect(c.commands).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  it('keeps an ONVIF login as a secret and sends it as a WS-Security digest', async () => {
    const { c, ports } = await camera();
    c.login = { user: 'admin', password: 'pw1' };
    await start([entry('00000001', ports, 'onvif', 'onvif')], { secrets: { cams: { '00000001': { user: 'admin', password: 'pw1' } } } });
    expect(camView('00000001').reachable).toBe(true);
    expect(JSON.stringify(last())).not.toMatch(/pw1/);
    expect(last().entries[0].login).toBe(true);
  });
});

describe('the Stream Deck', () => {
  it('does nothing without Allow controls, and says so', async () => {
    const { c, ports } = await camera();
    const s = await start([entry('00000001', ports)]);
    expect(s.keys[KEY.CAM]?.sublabel).toBe('VIEW ONLY');
    await s.down(KEY.UP);
    await s.up(KEY.UP);
    await wait(200);
    expect(c.commands).toEqual([]);
    expect(s.notifications.at(-1)?.text).toMatch(/Allow controls/);
  });

  it('pans and tilts while a key is held, at the chosen speed, and stops on release', async () => {
    const { c, ports } = await camera();
    const s = await start([entry('00000001', ports)], { allow: true });
    await s.down(KEY.UR);
    await until(() => c.vel.pan > 0 && c.vel.tilt > 0, 2000, 'for the move');
    expect(c.vel.pan).toBeCloseTo(13 / 24, 1); // medium: 0.55 of full speed
    await s.up(KEY.UR);
    await until(() => c.vel.pan === 0 && c.vel.tilt === 0, 2000, 'for the stop');
    await s.press(KEY.SPEED); // fast
    expect(s.state.speed).toBe('fast');
    await s.down(KEY.LEFT);
    await until(() => c.vel.pan < -0.9, 2000, 'for a fast left');
    await s.down(KEY.UP); // two keys: a diagonal
    await until(() => c.vel.tilt > 0.9, 2000, 'for up too');
    await s.up(KEY.LEFT);
    await until(() => c.vel.pan === 0 && c.vel.tilt > 0.9, 2000, 'for up only');
    await s.up(KEY.UP);
    await until(() => !c.moving, 2000, 'for the stop');
    expect(moves(c).at(-1)).toBe('pan-tilt stop');
  });

  it('zooms, and focuses after switching the camera to manual focus', async () => {
    const { c, ports } = await camera();
    const s = await start([entry('00000001', ports, 'visca-tcp', 'ptzoptics')], { allow: true });
    await s.down(KEY.ZOOM_IN);
    await until(() => c.vel.zoom > 0, 2000, 'for zoom');
    await s.up(KEY.ZOOM_IN);
    await until(() => c.vel.zoom === 0, 2000, 'for zoom stop');
    expect(c.focusAuto).toBe(true);
    await s.down(KEY.FAR);
    await until(() => c.vel.focus > 0, 2000, 'for focus');
    expect(c.focusAuto).toBe(false);
    await s.up(KEY.FAR);
    await until(() => c.vel.focus === 0, 2000, 'for focus stop');
    expect(moves(c)).toEqual(expect.arrayContaining(['focus manual', 'zoom stop', 'focus stop']));
  });

  it('presses CAM for the next camera, and the old one stops', async () => {
    const a = await camera('A');
    const b = await camera('B');
    const s = await start([entry('0000000a', a.ports), entry('0000000b', b.ports, 'panasonic', 'panasonic')], { allow: true });
    await s.down(KEY.LEFT);
    await until(() => a.c.vel.pan < 0, 2000, 'for A to move');
    await s.press(KEY.CAM);
    expect(s.state.cam).toBe('0000000b');
    await until(() => a.c.vel.pan === 0, 2000, 'for A to stop');
    await s.up(KEY.LEFT);
    await s.down(KEY.RIGHT);
    await until(() => b.c.vel.pan > 0, 2000, 'for B to move');
    await s.up(KEY.RIGHT);
    await until(() => b.c.vel.pan === 0, 2000, 'for B to stop');
  });

  it('stops when the system borrows the keys mid-move', async () => {
    const { c, ports } = await camera();
    const s = await start([entry('00000001', ports)], { allow: true });
    await s.down(KEY.DOWN);
    await until(() => c.vel.tilt < 0, 2000, 'for the move');
    await s.setKeysOwned(false);
    await until(() => c.vel.tilt === 0, 2000, 'for the stop');
  });

  it('recalls, stores (STORE then a preset key) and goes home in PRESETS mode', async () => {
    const { c, ports } = await camera();
    const s = await start([entry('00000001', ports)], { allow: true });
    await s.press(KEY.MODE);
    expect(s.state.keyMode).toBe('presets');
    c.pan = 0.3;
    await s.press(KEY.STORE);
    expect(s.keys[0]?.sublabel).toBe('STORE HERE');
    await s.press(2);
    expect(moves(c)).toContain('store 3');
    c.pan = -0.8;
    await s.press(2);
    expect(moves(c)).toContain('recall 3');
    expect(c.pan).toBeCloseTo(0.3, 1);
    await s.press(KEY.HOME);
    expect(moves(c)).toContain('home');
  });

  it('steps picture settings in PICTURE mode', async () => {
    const { c, ports } = await camera();
    c.ae = 0x03; // manual, so gain is live
    const s = await start([entry('00000001', ports)], { allow: true });
    await s.press(KEY.MODE);
    await s.press(KEY.MODE);
    expect(s.state.keyMode).toBe('picture');
    expect(s.keys[1]?.label).toBe('GAIN +');
    const g = c.gain;
    await s.press(1);
    expect(c.gain).toBe(g + 1);
    await s.press(6);
    expect(c.gain).toBe(g);
    await s.press(10); // exposure mode: next one
    expect(c.ae).toBe(0x0a);
    await until(() => s.keys[1]?.sublabel === 'locked', 2000, 'for gain to lock (manual only)');
    expect(s.keys[2]?.sublabel).not.toBe('locked'); // shutter is live in shutter priority
  });
});

describe('the panel and web view', () => {
  it('moves while an on-screen button repeats, and stops on its own when it stops repeating', async () => {
    const { c, ports } = await camera();
    const s = await start([entry('00000001', ports)], { allow: true });
    await s.sendUi({ type: 'move', id: '00000001', pan: 0, tilt: 0, zoom: 0.5 }, 'web1');
    await until(() => c.vel.zoom > 0, 2000, 'for zoom');
    await wait(UI_HOLD_MS + 300);
    expect(c.vel.zoom).toBe(0);
  });

  it('sets a picture setting and shows what the camera took', async () => {
    const { c, ports } = await camera();
    const s = await start([entry('00000001', ports, 'panasonic', 'panasonic')], { allow: true });
    await s.sendUi({ type: 'set', id: '00000001', param: 'wb', value: 9, from: 'web' });
    await until(() => c.wb === 5, 3000, 'for white balance');
    await s.sendUi({ type: 'set', id: '00000001', param: 'rgain', value: 20, from: 'web' });
    await until(() => c.rgain === 0x80 + 20, 3000, 'for R gain');
    await until(() => camView('00000001').picture.find((p: any) => p.id === 'rgain')?.value === 20, 5000, 'for the read');
    expect(s.logs.map((l) => l.text)).toEqual(expect.arrayContaining([expect.stringMatching(/R gain to 20 \(the web view\)/)]));
  });

  it('names presets in config, and adds, edits and removes cameras', async () => {
    const { ports } = await camera();
    const s = await start([entry('00000001', ports)]);
    await s.sendUi({ type: 'preset-name', id: '00000001', n: 2, name: 'Lectern' });
    expect(s.config.cameras[0]!.presetNames).toEqual(['', 'Lectern']);
    await s.sendUi({ type: 'add', host: '127.0.0.1', brand: 'panasonic', port: ports.panasonic, name: 'Wide' });
    expect(s.config.cameras).toHaveLength(2);
    expect(s.config.cameras[1]).toMatchObject({ name: 'Wide', brand: 'panasonic', protocol: 'panasonic', video: { mode: 'push' } });
    const id = s.config.cameras[1]!.id;
    await s.sendUi({ type: 'edit', id, video: { mode: 'pull', url: 'ftp://nope' } });
    expect(s.notifications.at(-1)?.text).toMatch(/rtmp:\/\//);
    await s.sendUi({ type: 'remove', id });
    expect(s.config.cameras).toHaveLength(1);
  });
});

describe('live video', () => {
  it('takes a camera’s RTMP push and sends it to a viewer as fragmented MP4', async () => {
    const { ports } = await camera();
    const rtmpPort = await freePort();
    const s = await start([entry('00000001', ports, 'visca-udp', 'sony', { mode: 'push', url: '', key: 'stagecam' })], { rtmpPort });
    expect(last().entries[0].url).toMatch(new RegExp(`^rtmp://.+:${rtmpPort}/live/stagecam$`));
    // An unknown key is refused.
    const bad = new SimPusher(`rtmp://127.0.0.1:${rtmpPort}/live/wrong`);
    bad.start();
    cleanups.push(() => bad.stop());
    await until(() => !!last()?.rtmp.refused, 3000, 'for the refusal');
    const p = new SimPusher(`rtmp://127.0.0.1:${rtmpPort}/live/stagecam`);
    p.start();
    cleanups.push(() => p.stop());
    await until(() => camView('00000001')?.stream.live, 4000, 'for the stream');
    expect(camView('00000001').stream).toMatchObject({ width: 640, height: 360, from: 'push from 127.0.0.1' });
    expect(last().entries[0].pushingFrom).toBe('127.0.0.1');
    await s.sendUi({ type: 'video', cams: ['00000001'] }, 'panel');
    await until(() => s.uiMessages.some((m) => m.message?.type === 'video' && m.message.kind === 'seg' && m.message.key), 4000, 'for a keyframe');
    const init = s.uiMessages.find((m) => m.message?.type === 'video' && m.message.kind === 'init')!.message;
    expect(init.mime).toMatch(/^video\/mp4; codecs="avc1\./);
    expect(s.uiMessages.every((m) => JSON.stringify(m.message).length < 64_000)).toBe(true);
  });

  it('pulls an rtmp:// stream only while someone watches it', async () => {
    const { ports } = await camera();
    // A "media server": the module's own receiver in a second test module would do, but a bare one is simpler.
    const { RtmpServer } = await import('../src/rtmp/server.js');
    const { LiveStream } = await import('../src/video/stream.js');
    const { RtmpConnection, MSG } = await import('../src/rtmp/conn.js');
    void RtmpConnection;
    void MSG;
    const upstream = new LiveStream('up');
    const srv = new RtmpServer(() => upstream);
    const port = await srv.listen(0, '127.0.0.1');
    cleanups.push(() => srv.close());
    void port;
    // Our receiver only takes pushes, so pulling from it is refused: the module shows why.
    const s = await start([entry('00000001', ports, 'visca-udp', 'sony', { mode: 'pull', url: `rtmp://127.0.0.1:${port}/live/x`, key: 'x' })]);
    await wait(300);
    expect(camView('00000001').stream.from).toBe(''); // not watched: nothing pulled
    await s.sendUi({ type: 'video', cams: ['00000001'] }, 'panel');
    await until(() => !!camView('00000001')?.stream.error, 4000, 'for the pull to start and fail');
    expect(camView('00000001').stream.from).toMatch(/^pull rtmp:\/\/127\.0\.0\.1:/);
  });
});

describe('the RTMP to ONVIF bridge', () => {
  async function bridged(allow: boolean) {
    const { c, ports } = await camera();
    const basePort = await freePort();
    const rtspPort = await freePort();
    const rtmpPort = await freePort();
    const s = await start([entry('00000001', ports, 'visca-udp', 'sony', { mode: 'push', url: '', key: 'bridgecam' })], { allow, rtmpPort, bridge: { enabled: true, basePort, rtspPort, discovery: false } });
    const p = new SimPusher(`rtmp://127.0.0.1:${rtmpPort}/live/bridgecam`);
    p.start();
    cleanups.push(() => p.stop());
    await until(() => camView('00000001')?.stream.live, 4000, 'for the stream');
    return { c, s, basePort, rtspPort };
  }

  it('is a camera an ONVIF client can find, play and drive; moves become VISCA', async () => {
    const { c, s, basePort, rtspPort } = await bridged(true);
    expect(last().bridge.cams[0].onvif).toMatch(new RegExp(`:${basePort}/onvif/device_service$`));
    const d = new OnvifDriver('127.0.0.1', basePort, () => null);
    cleanups.push(() => d.close());
    const id = await d.identify();
    expect(id).toMatchObject({ vendor: 'Rack Control Surface', model: 'Cam 1 (PTZ bridge)' });
    expect(id.rtsp).toMatch(new RegExp(`^rtsp://127\\.0\\.0\\.1:${rtspPort}/00000001$`));
    await d.move(0.5, 0);
    await until(() => c.vel.pan > 0, 2000, 'for the VISCA move');
    await d.move(0, 0);
    await until(() => c.vel.pan === 0, 2000, 'for the VISCA stop');
    await d.recall(4);
    expect(moves(c)).toContain('recall 4');
    // RTSP: the SDP carries the camera's own H.264 parameters.
    const sdp = await describe_(rtspPort, '00000001');
    expect(sdp).toMatch(/RTSP\/1\.0 200 OK/);
    expect(sdp).toMatch(/a=rtpmap:96 H264\/90000/);
    expect(sdp).toMatch(/sprop-parameter-sets=/);
    void s;
  });

  it('refuses moves while Allow controls is off', async () => {
    const { c, basePort } = await bridged(false);
    const d = new OnvifDriver('127.0.0.1', basePort, () => null);
    cleanups.push(() => d.close());
    await expect(d.move(0.5, 0)).rejects.toThrow(/Allow controls/);
    expect(c.commands).toEqual([]);
  });

  it('asks ONVIF clients for the bridge login when one is set', async () => {
    const { c, ports } = await camera();
    const basePort = await freePort();
    await start([entry('00000001', ports)], { allow: true, bridge: { enabled: true, basePort, rtspPort: await freePort(), discovery: false }, secrets: { bridge: { user: 'op', password: 'secret' } } });
    await expect(new OnvifDriver('127.0.0.1', basePort, () => null).move(0.2, 0)).rejects.toThrow(/not authorized/i);
    const ok = new OnvifDriver('127.0.0.1', basePort, () => ({ user: 'op', password: 'secret' }));
    cleanups.push(() => ok.close());
    await ok.move(0.2, 0);
    await until(() => c.vel.pan > 0, 2000, 'for the move');
    await ok.move(0, 0);
  });
});

function describe_(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let out = '';
    s.on('connect', () => s.write(`DESCRIBE rtsp://127.0.0.1:${port}/${path} RTSP/1.0\r\nCSeq: 2\r\nAccept: application/sdp\r\n\r\n`));
    s.on('data', (d) => {
      out += d.toString();
      if (/\r\n\r\n[\s\S]*m=video[\s\S]*control:trackID=0/.test(out)) {
        s.destroy();
        resolve(out);
      }
    });
    s.on('error', reject);
    setTimeout(() => {
      s.destroy();
      resolve(out);
    }, 5000);
  });
}

describe('scan network', () => {
  it('finds cameras by asking (reads only) and adds the one picked', async () => {
    const { c, ports } = await camera('Found Cam');
    process.env.RCS_PTZ_SCAN_PORTS = JSON.stringify({ viscaUdp: ports.viscaUdp, viscaTcp: ports.viscaTcp, panasonic: ports.panasonic, birddog: ports.birddog });
    cleanups.push(() => void delete process.env.RCS_PTZ_SCAN_PORTS);
    const s = await start([]);
    await s.sendUi({ type: 'scan', target: '127.0.0.1' });
    await until(() => last()?.scan && !last().scan.running && last().scan.at > 0, 6000, 'for the scan');
    const f = last().scan.found.find((x: any) => x.host === '127.0.0.1');
    // The sim answers every protocol: the most specific brand wins, and how it was found is listed.
    expect(f.via).toEqual(expect.arrayContaining(['VISCA over IP', 'Panasonic HTTP', 'BirdDog API']));
    expect(c.commands).toEqual([]);
    await s.sendUi({ type: 'add-found', host: '127.0.0.1' });
    expect(s.config.cameras).toHaveLength(1);
    expect(last().scan.found[0].added).toBe(true);
  });
});

describe('pointing a camera’s own RTMP push at the unit', () => {
  const LOGIN = { user: 'admin', password: 'pw9' };

  async function pointable(brand: 'panasonic' | 'sony' | 'ptzoptics', allow = true, withLogin = true) {
    const { c, ports } = await camera();
    c.login = LOGIN;
    const protocol: Protocol = brand === 'panasonic' ? 'panasonic' : 'visca-udp';
    const e = { ...entry('00000001', ports, protocol, brand, { mode: 'push', url: '', key: 'stagecam' }), webPort: ports.web };
    const rtmpPort = await freePort();
    const s = await start([e], { allow, rtmpPort, secrets: withLogin ? { cams: { '00000001': LOGIN } } : {} });
    return { c, s, rtmpPort };
  }
  const rtmpCommands = (c: SimCamera) => c.commands.filter((x) => x.what.startsWith('RTMP'));

  it.each(['panasonic', 'sony', 'ptzoptics'] as const)('%s: sets the push to this unit only once confirmed, with the camera’s login', async (brand) => {
    const { c, s, rtmpPort } = await pointable(brand);
    expect(last().entries[0].rtmpSetup).toMatchObject({ supported: true, target: `rtmp://127.0.0.1:${rtmpPort}/live/stagecam` });
    await wait(300);
    expect(rtmpCommands(c)).toEqual([]); // starting only reads
    await s.sendUi({ type: 'rtmp-point', id: '00000001', from: 'web' }); // not confirmed: nothing
    await s.settle();
    expect(rtmpCommands(c)).toEqual([]);
    await s.sendUi({ type: 'rtmp-point', id: '00000001', confirmed: true, from: 'web' });
    await until(() => !!last()?.entries[0].rtmpSetup.done, 4000, 'for the set');
    const pushTo = brand === 'sony' ? c.rtmp.url : `${c.rtmp.url}/${c.rtmp.key}`;
    expect(pushTo).toBe(`rtmp://127.0.0.1:${rtmpPort}/live/stagecam`);
    expect(c.rtmp.enabled).toBe(true);
    if (brand !== 'ptzoptics') expect(last().entries[0].rtmpSetup.read).toMatchObject({ enabled: true });
    expect(s.logs.some((l) => /set the camera to push RTMP/.test(l.text))).toBe(true);
    expect(JSON.stringify(last())).not.toMatch(/pw9/);
  });

  it('then the camera’s picture arrives at the unit', async () => {
    const { c, s } = await pointable('panasonic');
    let pusher: SimPusher | null = null;
    c.onRtmp = (url) => {
      pusher = new SimPusher(url);
      pusher.start();
    };
    cleanups.push(() => pusher?.stop());
    await s.sendUi({ type: 'rtmp-point', id: '00000001', confirmed: true, from: 'web' });
    await until(() => camView('00000001')?.stream.live, 5000, 'for the stream');
  });

  it('reads the camera’s current setting without changing it', async () => {
    const { c, s } = await pointable('sony', false);
    c.rtmp = { url: 'rtmp://elsewhere/live/abc', key: '', enabled: true };
    await s.sendUi({ type: 'rtmp-read', id: '00000001', from: 'web' });
    await until(() => !!last()?.entries[0].rtmpSetup.read, 3000, 'for the read');
    expect(last().entries[0].rtmpSetup.read).toMatchObject({ url: 'rtmp://elsewhere/live/abc', enabled: true, status: 'Connection success' });
    expect(rtmpCommands(c)).toEqual([]);
  });

  it('refuses without Allow controls or a saved login, and says why for BirdDog', async () => {
    const off = await pointable('panasonic', false);
    await off.s.sendUi({ type: 'rtmp-point', id: '00000001', confirmed: true, from: 'web' });
    await off.s.settle();
    expect(rtmpCommands(off.c)).toEqual([]);
    expect(off.s.notifications.at(-1)?.text).toMatch(/Allow controls/);
    await sim!.close();
    sim = null;

    const nologin = await pointable('ptzoptics', true, false);
    await nologin.s.sendUi({ type: 'rtmp-point', id: '00000001', confirmed: true, from: 'web' });
    await nologin.s.settle();
    expect(rtmpCommands(nologin.c)).toEqual([]);
    expect(nologin.s.notifications.at(-1)?.text).toMatch(/login/);
    await sim!.close();
    sim = null;

    const { ports } = await camera();
    const s = await start([entry('00000001', ports, 'visca-udp', 'birddog', { mode: 'push', url: '', key: 'stagecam' })], { allow: true });
    expect(last().entries[0].rtmpSetup).toMatchObject({ supported: false, why: expect.stringMatching(/BirdDog/) });
    await s.sendUi({ type: 'rtmp-point', id: '00000001', confirmed: true, from: 'web' });
    await s.settle();
    expect(s.notifications.at(-1)?.text).toMatch(/BirdDog/);
  });
});

describe('a larger Stream Deck', () => {
  it('keeps the 15 keys top left, picks cameras on the bottom row and recalls presets on the right', async () => {
    const a = await camera('A');
    const b = await camera('B');
    const s = await start([entry('0000000a', a.ports), entry('0000000b', b.ports)], { allow: true, deck: { columns: 8, rows: 4 } });
    expect(s.keys).toHaveLength(32);
    expect(s.keys[1]).toMatchObject({ label: '▲' });
    expect(s.keys[20]).toMatchObject({ label: 'MODE' }); // block key 15 at column 5, row 3 of the deck
    expect(s.keys[24]).toMatchObject({ label: 'CAM A', sublabel: 'SELECTED' });
    expect(s.keys[25]).toMatchObject({ label: 'CAM B' });
    expect(s.keys[26]).toEqual({}); // no third camera
    // Presets: 4 rows of 3 on the right, row by row.
    expect([5, 6, 7, 13, 31].map((k) => s.keys[k]?.label)).toEqual(['PRESET 1', 'PRESET 2', 'PRESET 3', 'PRESET 4', 'PRESET 12']);

    await s.down(8); // ◀ at column 0, row 1
    await until(() => a.c.vel.pan < 0, 2000, 'for the move');
    await s.press(25); // camera B: the move on A stops
    expect(s.state.cam).toBe('0000000b');
    await until(() => a.c.vel.pan === 0, 2000, 'for the stop');
    await s.up(8);
    await s.press(6);
    expect(moves(b.c)).toContain('recall 2');
    expect(moves(a.c)).not.toContain('recall 2');

    await s.down(1); // ▲ held while the deck changes: the move stops
    await until(() => b.c.vel.tilt > 0, 2000, 'for the tilt');
    await s.setDeck(5, 3);
    await until(() => b.c.vel.tilt === 0, 2000, 'for the stop');
    await s.settle();
    expect(s.keys).toHaveLength(15);
    expect(s.keys[KEY.MODE]).toMatchObject({ label: 'MODE' });
    expect(s.keys[KEY.CAM]).toMatchObject({ label: 'CAM B' });
  });
});

describe('the larger deck layout', () => {
  it('puts up to 5 cameras under the 15 keys and 4 rows of presets on the right', () => {
    const L = layout({ columns: 8, rows: 4 }, 5);
    expect(L.cameras).toEqual([24, 25, 26, 27, 28]);
    expect(L.presets).toEqual([5, 6, 7, 13, 14, 15, 21, 22, 23, 29, 30, 31]);
  });

  it('runs the camera row the whole width with more than 5 cameras, and keeps 3 rows of presets', () => {
    const L = layout({ columns: 8, rows: 4 }, 6);
    expect(L.cameras).toEqual([24, 25, 26, 27, 28, 29, 30, 31]);
    expect(L.presets).toEqual([5, 6, 7, 13, 14, 15, 21, 22, 23]);
    expect(layout({ columns: 9, rows: 4 }, 2).presets).toHaveLength(16); // + XL: 4 rows of 4
  });

  it('adds nothing on a 15-key deck', () => {
    expect(layout({ columns: 5, rows: 3 }, 8)).toMatchObject({ cameras: [], presets: [] });
  });
});
