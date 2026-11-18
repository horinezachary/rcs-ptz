// PTZ Camera Control: see every camera's live picture, tap one to select it, and pan, tilt, zoom and focus it
// from the Stream Deck. A Picture page sets gain, iris, shutter, white balance and R/B gain. Optionally the
// unit bridges each camera to ONVIF, with an RTSP stream and ONVIF PTZ turned into the camera's own protocol.
//
// The cameras are the source of truth. Everything read from them is kept only in memory: state holds which
// camera the keys drive, the key mode and the speed; config holds the camera list (address, protocol, how
// its video arrives), preset names, Allow controls, the panel's live video choice and the bridge settings.
// Starting, restoring a save, resuming after a power cut and reconnecting only read. A command goes out only
// on an operator's action (a key, a tap, a confirmed web button, or an ONVIF client through the bridge),
// and only with Allow controls on. Camera and bridge logins are secrets.
//
// Stream Deck, PTZ mode (key 15 cycles PTZ → PRESETS → PICTURE):
//    ↖   ▲   ↗   ZOOM+  NEAR        hold to move; release stops
//    ◀  CAM  ▶   ZOOM−  FAR         CAM: the selected camera, press for the next
//    ↙   ▼   ↘   SPEED  MODE        SPEED: slow, medium, fast
// PRESETS mode: keys 1-12 recall presets 1-12, 13 HOME, 14 STORE (then a preset key), 15 MODE.
// PICTURE mode: iris, gain, shutter, R gain, B gain (+ on top, − below), AE mode, WB mode, one push WB,
//               focus auto/manual, MODE.
//
// On a larger deck (controller 0.21.0+) these 15 keys stay in the top left 5 × 3. The columns to their
// right pick a camera directly, one key each. The rows below them recall presets: 1 onwards in PTZ and
// PICTURE modes, 13 onwards in PRESETS mode (where STORE then a key stores there).

import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { defineModule, type Ctx, type KeySetParams } from '@rcs/module-sdk';
import { OnvifBridge, type BridgeAction, type BridgeCamera, localFor } from './bridge/onvif.js';
import { RtspServer } from './bridge/rtsp.js';
import { Camera, type CameraEntry, type VideoMode, portOf } from './camera.js';
import { BRANDS, type Brand, type Credentials, type Param, PROTOCOLS, type Protocol, clamp } from './cameras/types.js';
import { rtmpSetupFor, rtmpSetupMissing, type RtmpSetting } from './cameras/rtmp-setup.js';
import { scan, type Found } from './discovery.js';
import { RTMP_APP, RtmpServer } from './rtmp/server.js';
import { VideoHub } from './video/hub.js';

export const VERSION = '0.1.0';

export type Speed = 'slow' | 'medium' | 'fast';
export type KeyMode = 'ptz' | 'presets' | 'picture';
export type LiveVideo = 'all' | 'selected' | 'off';
export type View = 'cameras' | 'picture' | 'presets' | 'setup';
const VIEWS: View[] = ['cameras', 'picture', 'presets', 'setup'];

export interface State {
  /** The camera the keys drive. */
  cam: string;
  keyMode: KeyMode;
  speed: Speed;
}

export interface Entry extends CameraEntry {
  /** Names for presets 1-16: the module's own labels (cameras don't store names). */
  presetNames: string[];
  /** The camera's web (HTTP) port for Sony and PTZOptics, where the RTMP setting lives. 0: 80. */
  webPort: number;
}

/** What the module last learned about a camera's own RTMP setting, and what it is doing about it. */
interface RtmpInfo {
  busy: '' | 'reading' | 'setting';
  read: RtmpSetting | null;
  error: string;
  /** After a successful set. */
  done: string;
}

export interface Config {
  cameras: Entry[];
  allowControls: boolean;
  /** Live video on the unit's own panel: every camera, the selected one, or none (the Pi decodes it). */
  liveVideo: LiveVideo;
  rtmpPort: number;
  bridge: { enabled: boolean; basePort: number; rtspPort: number; discovery: boolean };
}

type C = Ctx<State, Config>;

export const MAX_CAMERAS = 16;
export const PRESETS = 16;
export const KEY = {
  UL: 0, UP: 1, UR: 2, ZOOM_IN: 3, NEAR: 4,
  LEFT: 5, CAM: 6, RIGHT: 7, ZOOM_OUT: 8, FAR: 9,
  DL: 10, DOWN: 11, DR: 12, SPEED: 13, MODE: 14,
  HOME: 12, STORE: 13
} as const;
export interface Grid {
  columns: number;
  rows: number;
}

/** The deck as the controller describes it. Older controllers send no size: 5 × 3. */
export function grid(ctx: { host: { deck: { columns?: number; rows?: number } } }): Grid {
  return { columns: ctx.host.deck.columns ?? 5, rows: ctx.host.deck.rows ?? 3 };
}

export interface Layout {
  keys: number;
  /** Deck key of each of the 15 KEY positions. */
  block: number[];
  /** Camera keys right of the block, in order. */
  cameras: number[];
  /** Preset keys below the block, in order. */
  presets: number[];
}

/** Where everything goes on a deck of this size. On 5 × 3 it is the 15 KEY positions and nothing else. */
export function layout(g: Grid): Layout {
  const C = g.columns;
  const block = Array.from({ length: 15 }, (_, i) => Math.floor(i / 5) * C + (i % 5));
  const cameras: number[] = [];
  const presets: number[] = [];
  for (let d = 0; d < C * g.rows; d++) {
    if (d % C >= 5) cameras.push(d);
    else if (Math.floor(d / C) >= 3) presets.push(d);
  }
  return { keys: C * g.rows, block, cameras, presets };
}

const DIRS: Record<number, [number, number]> = { 0: [-1, 1], 1: [0, 1], 2: [1, 1], 5: [-1, 0], 7: [1, 0], 10: [-1, -1], 11: [0, -1], 12: [1, -1] };
const SPEEDS: Record<Speed, number> = { slow: 0.25, medium: 0.55, fast: 1 };
const FOCUS_SPEED = 0.45;
/** A held on-screen button repeats its move this often; the move stops if it stops repeating. */
export const UI_HOLD_MS = 900;
export const STORE_MS = 5000;

const ON = '#FFFFFF';
const ARMED = '#3A2A0E';
const MOVE_BG = '#1F3A5F';
const ACTIVE = '#2E6FD8';

interface Motion {
  pan: number;
  tilt: number;
  zoom: number;
  focus: number;
}

interface Source {
  m: Motion;
  timer: NodeJS.Timeout | null;
}

interface Runtime {
  cameras: Map<string, Camera>;
  view: View;
  held: Set<number>;
  /** Moves by source ("keys", "ui:<client>", "bridge") per camera. */
  motion: Map<string, Map<string, Source>>;
  sent: Map<string, Motion>;
  storeArmed: NodeJS.Timeout | null;
  drawTimer: NodeJS.Timeout | null;
  video: VideoHub;
  rtmp: RtmpServer;
  rtsp: RtspServer;
  bridge: OnvifBridge;
  bridgeOn: boolean;
  scan: { running: boolean; found: Found[]; error: string; at: number; target: string };
  pictureViewers: Map<string, string>;
  lastError: Map<string, number>;
  refused: string;
  rtmpInfo: Map<string, RtmpInfo>;
}
let rt: Runtime | null = null;

const ADDRESS_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\[?[0-9A-Fa-f:]+\]?$/;
export const validAddress = (a: unknown): a is string => typeof a === 'string' && a !== '' && ADDRESS_RE.test(a);
const quiet = (p: Promise<unknown>): void => void p.catch(() => {});
const short = (s: string | undefined, n: number): string => [...(s ?? '')].slice(0, n).join('');
const newId = () => randomBytes(4).toString('hex');
const newKey = () => randomBytes(6).toString('hex');
const isPort = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0 && (n as number) <= 65535;

function cleanEntry(e: any): Entry | null {
  if (!e || typeof e.id !== 'string' || !/^[0-9a-f]{8}$/.test(e.id) || !validAddress(e.host)) return null;
  const brand: Brand = e.brand in BRANDS ? e.brand : 'visca';
  const protocol: Protocol = BRANDS[brand].protocols.includes(e.protocol) ? e.protocol : BRANDS[brand].protocols[0]!;
  const v = e.video ?? {};
  const mode: VideoMode = v.mode === 'pull' || v.mode === 'none' ? v.mode : 'push';
  const names = Array.isArray(e.presetNames) ? e.presetNames.slice(0, PRESETS).map((x: unknown) => (typeof x === 'string' ? x.slice(0, 24) : '')) : [];
  return {
    id: e.id,
    name: typeof e.name === 'string' && e.name.trim() ? e.name.trim().slice(0, 32) : e.host,
    brand,
    protocol,
    host: e.host,
    port: Number.isInteger(e.port) && e.port >= 0 && e.port <= 65535 ? e.port : 0,
    video: { mode, url: typeof v.url === 'string' ? v.url.trim().slice(0, 500) : '', key: typeof v.key === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(v.key) ? v.key : e.id },
    invertPan: !!e.invertPan,
    invertTilt: !!e.invertTilt,
    presetNames: names,
    webPort: Number.isInteger(e.webPort) && e.webPort >= 0 && e.webPort <= 65535 ? e.webPort : 0
  };
}

export function cfg(ctx: C): Config {
  const c = (ctx.config ?? {}) as Partial<Config>;
  const b = (c.bridge ?? {}) as Partial<Config['bridge']>;
  return {
    cameras: Array.isArray(c.cameras) ? c.cameras.map(cleanEntry).filter((e): e is Entry => !!e).slice(0, MAX_CAMERAS) : [],
    allowControls: c.allowControls ?? false,
    liveVideo: c.liveVideo === 'selected' || c.liveVideo === 'off' ? c.liveVideo : 'all',
    rtmpPort: isPort(c.rtmpPort) ? c.rtmpPort : 1935,
    bridge: { enabled: b.enabled === true, basePort: isPort(b.basePort) ? b.basePort : 8000, rtspPort: isPort(b.rtspPort) ? b.rtspPort : 8554, discovery: b.discovery ?? true }
  };
}

function creds(ctx: C, id: string): Credentials | null {
  const s = ctx.secrets?.value?.cams?.[id];
  return s && typeof s.user === 'string' && s.user ? { user: s.user, password: String(s.password ?? '') } : null;
}

function bridgeLogin(ctx: C): Credentials | null {
  const s = ctx.secrets?.value?.bridge;
  return s && typeof s.user === 'string' && s.user ? { user: s.user, password: String(s.password ?? '') } : null;
}

function current(ctx: C): Camera | undefined {
  if (!rt) return undefined;
  return rt.cameras.get(ctx.state.value.cam) ?? rt.cameras.values().next().value;
}

const keyMode = (ctx: C): KeyMode => (['ptz', 'presets', 'picture'].includes(ctx.state.value.keyMode) ? ctx.state.value.keyMode : 'ptz');
const speed = (ctx: C): Speed => (ctx.state.value.speed in SPEEDS ? ctx.state.value.speed : 'medium');

export function unitAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}

// ---- what the screens get ----------------------------------------------------------------------

function motionOf(id: string): Motion {
  return rt?.sent.get(id) ?? { pan: 0, tilt: 0, zoom: 0, focus: 0 };
}

export function snapshot(ctx: C, clientId?: string) {
  const c = cfg(ctx);
  const cur = current(ctx);
  const ip = unitAddresses()[0] ?? '<unit address>';
  const publishing = rt?.rtmp.publishing() ?? new Map();
  const login = (id: string) => !!creds(ctx, id);
  return {
    type: 'snapshot',
    view: rt?.view ?? 'cameras',
    allowControls: c.allowControls,
    liveVideo: c.liveVideo,
    speed: speed(ctx),
    keyMode: keyMode(ctx),
    current: cur?.entry.id ?? '',
    entries: c.cameras.map((e) => ({ ...e, login: login(e.id), url: e.video.mode === 'push' ? `rtmp://${ip}:${c.rtmpPort}/${RTMP_APP}/${e.video.key}` : e.video.url, pushingFrom: publishing.get(e.video.key) ?? '', rtmpSetup: rtmpSetupView(ctx, e) })),
    cameras: [...(rt?.cameras.values() ?? [])].map((cam) => {
      const v = cam.snapshot();
      return { ...v, picture: cam === cur || (clientId && rt?.pictureViewers.get(clientId) === v.id) ? v.picture : [], motion: motionOf(v.id) };
    }),
    rtmp: { port: rt?.rtmp.port ?? 0, error: rt?.rtmp.error ?? '', app: RTMP_APP, refused: rt?.refused ?? '' },
    bridge: {
      ...c.bridge,
      running: !!rt?.bridgeOn,
      errors: [...(rt?.bridge.errors ?? []), ...(rt?.rtsp.error ? [`RTSP: ${rt.rtsp.error}`] : [])],
      login: !!bridgeLogin(ctx),
      rtspPort: rt?.rtsp.port || c.bridge.rtspPort,
      cams: c.cameras.map((e) => ({ id: e.id, onvif: rt?.bridgeOn && rt.bridge.portOf(e.id) ? `http://${ip}:${rt.bridge.portOf(e.id)}/onvif/device_service` : '', rtsp: rt?.bridgeOn ? `rtsp://${ip}:${rt.rtsp.port || c.bridge.rtspPort}/${e.id}` : '' })),
      watching: [...(rt?.rtsp.watching() ?? [])]
    },
    scan: rt ? { running: rt.scan.running, found: rt.scan.found.map((f) => ({ ...f, added: c.cameras.some((e) => e.host === f.host) })), error: rt.scan.error, at: rt.scan.at, target: rt.scan.target } : null,
    storeArmed: !!rt?.storeArmed,
    unit: unitAddresses(),
    brands: Object.fromEntries(Object.entries(BRANDS).map(([k, v]) => [k, { label: v.label, protocols: v.protocols }])),
    protocols: PROTOCOLS
  };
}

// ---- keys --------------------------------------------------------------------------------------

/** Picture keys find their setting under each protocol's name for it. */
const PICTURE_KEYS: { label: string; ids: string[] }[] = [
  { label: 'IRIS', ids: ['iris'] },
  { label: 'GAIN', ids: ['gain'] },
  { label: 'SHUTTER', ids: ['shutter', 'exposureTime'] },
  { label: 'R GAIN', ids: ['rgain', 'crGain'] },
  { label: 'B GAIN', ids: ['bgain', 'cbGain'] }
];
const AE_IDS = ['ae', 'irisAuto', 'exposureMode'];
const WB_IDS = ['wb', 'wbMode'];
const AWB_IDS = ['awb'];

function param(cam: Camera | undefined, ids: string[]): Param | undefined {
  return cam?.view.picture.find((p) => ids.includes(p.id));
}

function blockFaces(ctx: C): KeySetParams[] {
  const c = cfg(ctx);
  const cam = current(ctx);
  const faces: KeySetParams[] = [];
  const blank = (index: number): KeySetParams => ({ index });
  const v = cam?.view;
  const offline = !!v && !v.reachable;
  const can = c.allowControls && !!v && !offline;
  const mode = keyMode(ctx);
  const list = [...(rt?.cameras.values() ?? [])];
  const camFace = (index: number): KeySetParams =>
    v ? { index, label: short(v.name.toUpperCase(), 10), sublabel: offline ? 'offline' : list.length > 1 ? `${list.indexOf(cam!) + 1} of ${list.length} ▶` : 'CAMERA', background: offline ? '#5A1A1A' : '#22262E', color: ON } : { index, label: 'NO CAMERA', sublabel: 'see Setup' };
  const modeFace: KeySetParams = { index: KEY.MODE, label: 'MODE', sublabel: mode === 'ptz' ? 'PTZ' : mode === 'presets' ? 'PRESETS' : 'PICTURE', background: '#2A2F38', color: ON };

  if (mode === 'ptz') {
    const m = v ? motionOf(v.id) : { pan: 0, tilt: 0, zoom: 0, focus: 0 };
    const held = rt?.held ?? new Set<number>();
    const arrows: Record<number, string> = { 0: '↖', 1: '▲', 2: '↗', 5: '◀', 7: '▶', 10: '↙', 11: '▼', 12: '↘' };
    for (let k = 0; k < 15; k++) {
      if (arrows[k]) {
        faces.push(v ? { index: k, label: arrows[k], sublabel: can ? '' : offline ? 'offline' : 'view only', ...(held.has(k) && can ? { background: ACTIVE, color: ON } : can ? { background: MOVE_BG, color: ON } : {}) } : blank(k));
        continue;
      }
      if (k === KEY.CAM) faces.push(camFace(k));
      else if (k === KEY.ZOOM_IN || k === KEY.ZOOM_OUT) {
        const on = (k === KEY.ZOOM_IN ? m.zoom > 0 : m.zoom < 0) && can;
        faces.push(v ? { index: k, label: k === KEY.ZOOM_IN ? 'ZOOM +' : 'ZOOM −', sublabel: v.status?.zoom !== undefined ? `${Math.round(v.status.zoom * 100)}%` : 'TELE / WIDE'.split(' / ')[k === KEY.ZOOM_IN ? 0 : 1], ...(on ? { background: ACTIVE, color: ON } : can ? { background: MOVE_BG, color: ON } : {}) } : blank(k));
      } else if (k === KEY.NEAR || k === KEY.FAR) {
        const on = (k === KEY.FAR ? m.focus > 0 : m.focus < 0) && can;
        faces.push(v ? { index: k, label: k === KEY.NEAR ? 'FOCUS NEAR' : 'FOCUS FAR', sublabel: v.status?.focusAuto ? 'AF on' : 'manual', ...(on ? { background: ACTIVE, color: ON } : can ? { background: '#2C3340', color: ON } : {}) } : blank(k));
      } else if (k === KEY.SPEED) faces.push({ index: k, label: 'SPEED', sublabel: speed(ctx).toUpperCase(), background: '#2A2F38', color: ON });
      else if (k === KEY.MODE) faces.push(modeFace);
    }
    if (v && !c.allowControls) Object.assign(faces[KEY.CAM]!, { sublabel: 'VIEW ONLY' });
    return faces;
  }

  if (mode === 'presets') {
    const names = c.cameras.find((e) => e.id === v?.id)?.presetNames ?? [];
    const storing = !!rt?.storeArmed;
    for (let k = 0; k < 12; k++) {
      const n = k + 1;
      faces.push(v ? { index: k, label: short((names[k] || `PRESET ${n}`).toUpperCase(), 10), sublabel: storing ? 'STORE HERE' : names[k] ? `PRESET ${n}` : '', ...(storing ? { background: ARMED, color: '#FFE2B0' } : can ? { background: '#24324A', color: ON } : {}) } : blank(k));
    }
    faces.push(v ? { index: KEY.HOME, label: 'HOME', sublabel: '', ...(can ? { background: '#24324A', color: ON } : {}) } : blank(KEY.HOME));
    faces.push(v ? { index: KEY.STORE, label: 'STORE', sublabel: storing ? 'PICK A KEY' : '', ...(storing ? { background: ARMED, color: '#FFE2B0' } : can ? { background: '#3A2020', color: ON } : {}) } : blank(KEY.STORE));
    faces.push(modeFace);
    return faces;
  }

  // picture
  for (let k = 0; k < 10; k++) {
    const pk = PICTURE_KEYS[k % 5]!;
    const p = param(cam, pk.ids);
    const up = k < 5;
    if (!v || !p) {
      faces.push(v ? { index: k, label: `${pk.label} ${up ? '+' : '−'}`, sublabel: v.read ? 'n/a' : '…' } : blank(k));
      continue;
    }
    const enabled = p.enabled !== false && can;
    faces.push({ index: k, label: `${pk.label} ${up ? '+' : '−'}`, sublabel: p.enabled === false ? 'locked' : short(p.text ?? '', 12), ...(enabled ? { background: '#2A2440', color: ON } : {}) });
  }
  const ae = param(cam, AE_IDS);
  faces.push(v && ae ? { index: 10, label: 'EXPOSURE', sublabel: short(ae.text, 12), ...(can ? { background: '#2A2440', color: ON } : {}) } : blank(10));
  const wb = param(cam, WB_IDS);
  faces.push(v && wb ? { index: 11, label: 'WHITE BAL', sublabel: short(wb.text, 12), ...(can ? { background: '#2A2440', color: ON } : {}) } : blank(11));
  const awb = param(cam, AWB_IDS);
  faces.push(v && awb ? { index: 12, label: 'ONE PUSH', sublabel: awb.enabled ? 'WB' : 'WB (off)', ...(can && awb.enabled ? { background: '#3A3220', color: ON } : {}) } : blank(12));
  const af = param(cam, ['focus']);
  faces.push(v && af ? { index: 13, label: 'FOCUS', sublabel: af.value === 'auto' ? 'AUTO' : 'MANUAL', ...(can ? { background: '#2A2440', color: ON } : {}) } : blank(13));
  faces.push(modeFace);
  return faces;
}

/** The 15 keys in their block, and on a larger deck the camera and preset keys around it. */
function keyFaces(ctx: C): KeySetParams[] {
  const L = layout(grid(ctx));
  const faces = blockFaces(ctx).map((f) => ({ ...f, index: L.block[f.index]! }));
  if (L.keys === 15) return faces;
  const c = cfg(ctx);
  const cam = current(ctx);
  const list = [...(rt?.cameras.values() ?? [])];
  L.cameras.forEach((index, i) => {
    const x = list[i];
    if (!x) return faces.push({ index });
    const sel = x === cam;
    const offline = !x.view.reachable;
    faces.push({ index, label: short(x.view.name.toUpperCase(), 10), sublabel: offline ? 'offline' : sel ? 'SELECTED' : `CAMERA ${i + 1}`, ...(sel ? { background: ACTIVE, color: ON } : offline ? { background: '#5A1A1A', color: ON } : {}) });
  });
  const v = cam?.view;
  const can = c.allowControls && !!v && v.reachable;
  const storing = !!rt?.storeArmed;
  const names = c.cameras.find((e) => e.id === v?.id)?.presetNames ?? [];
  L.presets.forEach((index, i) => {
    const n = extraPreset(ctx, i);
    if (!v || n > PRESETS) return faces.push({ index });
    const store = storing && keyMode(ctx) === 'presets';
    faces.push({ index, label: short((names[n - 1] || `PRESET ${n}`).toUpperCase(), 10), sublabel: store ? 'STORE HERE' : names[n - 1] ? `PRESET ${n}` : '', ...(store ? { background: ARMED, color: '#FFE2B0' } : can ? { background: '#24324A', color: ON } : {}) });
  });
  return faces;
}

/** The preset on the i-th key below the block: 13 onwards in PRESETS mode (1-12 are in the block), else 1 onwards. */
function extraPreset(ctx: C, i: number): number {
  return (keyMode(ctx) === 'presets' ? 13 : 1) + i;
}

export async function draw(ctx: C, clientId?: string): Promise<void> {
  if (!clientId) {
    if (rt?.drawTimer) clearTimeout(rt.drawTimer);
    if (rt) rt.drawTimer = null;
    if (ctx.keysOwned !== false) await ctx.keys.setMany(keyFaces(ctx));
  }
  await ctx.ui.send(snapshot(ctx, clientId), clientId);
}

function soon(ctx: C): void {
  if (!rt || rt.drawTimer) return;
  rt.drawTimer = setTimeout(() => {
    if (!rt) return;
    rt.drawTimer = null;
    quiet(reportStatus(ctx));
    quiet(draw(ctx));
  }, 80);
}

async function reportStatus(ctx: C): Promise<void> {
  const list = [...(rt?.cameras.values() ?? [])].map((c) => c.view);
  if (!list.length) return ctx.status('disconnected', 'Add a camera in Setup');
  const up = list.filter((s) => s.reachable).length;
  if (up === list.length) return ctx.status('connected', list.length === 1 ? '' : `${up} cameras`);
  return ctx.status(up ? 'connecting' : 'disconnected', list.length === 1 ? list[0]!.lastError || 'Connecting' : `${up} of ${list.length} cameras answering`);
}

// ---- the module's own state and config: no commands ----------------------------------------------

async function setView(ctx: C, v: unknown): Promise<void> {
  if (!rt || !VIEWS.includes(v as View)) return;
  rt.view = v as View;
  quiet(ctx.strip.select(rt.view));
  pictureWanted(ctx);
  await draw(ctx);
}

function pictureWanted(ctx: C): void {
  if (!rt) return;
  const cur = current(ctx);
  const want = new Set<string>([...rt.pictureViewers.values()]);
  if ((rt.view === 'picture' || keyMode(ctx) === 'picture') && cur) want.add(cur.entry.id);
  for (const [id, cam] of rt.cameras) cam.wantPicture(want.has(id));
}

async function select(ctx: C, id: unknown): Promise<void> {
  if (!rt || typeof id !== 'string' || !rt.cameras.has(id)) return;
  const old = ctx.state.value.cam;
  if (id !== old) {
    // Whatever the keys were doing to the old camera stops.
    rt.held.clear();
    if (old) setMotion(ctx, old, 'keys', null);
    disarmStore();
  }
  await ctx.state.patch({ cam: id });
  pictureWanted(ctx);
  await draw(ctx);
}

function newCamera(ctx: C, e: Entry): Camera {
  const cam = new Camera(e, () => creds(ctx, e.id));
  cam.on('change', () => {
    if (rt?.cameras.get(e.id) === cam) soon(ctx);
  });
  return cam;
}

const sameEntry = (a: Entry, b: Entry) => JSON.stringify({ ...a, presetNames: [], name: '' }) === JSON.stringify({ ...b, presetNames: [], name: '' });

/** Brings the cameras, the RTMP receiver and the bridge in line with the config. Reads only. */
async function sync(ctx: C): Promise<void> {
  if (!rt) return;
  const c = cfg(ctx);
  const next = new Map<string, Camera>();
  for (const e of c.cameras) {
    const old = rt.cameras.get(e.id);
    if (old && sameEntry(old.entry as Entry, e)) {
      old.view.name = e.name;
      (old.entry as Entry).presetNames = e.presetNames;
      (old.entry as Entry).name = e.name;
      next.set(e.id, old);
    } else {
      if (old) {
        rt.rtmp.kick(old.entry.video.key);
        old.stop();
      }
      const cam = newCamera(ctx, e);
      next.set(e.id, cam);
      cam.start();
    }
  }
  for (const [id, cam] of rt.cameras)
    if (!next.has(id)) {
      rt.rtmp.kick(cam.entry.video.key);
      cam.stop();
    }
  rt.cameras = next;
  // The receiver runs while any camera pushes to it.
  const push = c.cameras.some((e) => e.video.mode === 'push');
  if (push && rt.rtmp.port !== c.rtmpPort) await rt.rtmp.listen(c.rtmpPort);
  if (!push && rt.rtmp.port) await rt.rtmp.close();
  await syncBridge(ctx);
  watched();
  pictureWanted(ctx);
  quiet(reportStatus(ctx));
}

async function syncBridge(ctx: C): Promise<void> {
  if (!rt) return;
  const b = cfg(ctx).bridge;
  if (b.enabled) {
    if (rt.rtsp.port !== b.rtspPort) await rt.rtsp.listen(b.rtspPort);
    await rt.bridge.sync(b.basePort, b.discovery);
    rt.bridgeOn = true;
  } else if (rt.bridgeOn) {
    await rt.bridge.close();
    await rt.rtsp.close();
    rt.bridgeOn = false;
  }
}

/** Pulled streams run only while a panel, web view or RTSP client is watching them. */
function watched(): void {
  if (!rt) return;
  const w = new Set([...rt.video.watched(), ...rt.rtsp.watching()]);
  for (const [id, cam] of rt.cameras) cam.setWatched(w.has(id));
}

async function addCamera(ctx: C, m: any): Promise<void> {
  const host = typeof m.host === 'string' ? m.host.trim() : '';
  if (!validAddress(host)) return ctx.notify('That is not an IP address or host name', 'warning');
  const c = cfg(ctx);
  if (c.cameras.length >= MAX_CAMERAS) return ctx.notify(`Up to ${MAX_CAMERAS} cameras`, 'warning');
  const brand: Brand = m.brand in BRANDS ? m.brand : 'visca';
  const protocol: Protocol = BRANDS[brand].protocols.includes(m.protocol) ? m.protocol : BRANDS[brand].protocols[0]!;
  const port = m.port === undefined || m.port === '' || m.port === null ? 0 : Number(m.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return ctx.notify(`Port must be 1 to 65535, or empty for ${PROTOCOLS[protocol].port}`, 'warning');
  if (c.cameras.some((e) => e.host === host && portOf(e) === (port || PROTOCOLS[protocol].port))) return ctx.notify(`${host} is already in the list`);
  const id = newId();
  const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 32) : `Camera ${c.cameras.length + 1}`;
  const video = videoOf(m.video, newKey());
  if (typeof video === 'string') return ctx.notify(video, 'warning');
  const e: Entry = { id, name, brand, protocol, host, port, video, invertPan: false, invertTilt: false, presetNames: [], webPort: 0 };
  await ctx.setConfig({ ...c, cameras: [...c.cameras, e] });
  await ctx.log('info', `Added camera ${name} (${host}, ${PROTOCOLS[protocol].label})`);
  await sync(ctx);
  if (!rt?.cameras.has(ctx.state.value.cam)) await ctx.state.patch({ cam: id });
  await draw(ctx);
}

function videoOf(v: any, key: string): Entry['video'] | string {
  const mode: VideoMode = v?.mode === 'pull' || v?.mode === 'none' ? v.mode : 'push';
  const url = typeof v?.url === 'string' ? v.url.trim() : '';
  if (mode === 'pull' && !/^(rtmp|https?):\/\/\S+$/i.test(url)) return 'The stream address must start with rtmp://, http:// or https://';
  return { mode, url: mode === 'pull' ? url.slice(0, 500) : '', key };
}

async function editCamera(ctx: C, m: any): Promise<void> {
  const c = cfg(ctx);
  const e = c.cameras.find((x) => x.id === m.id);
  if (!e) return;
  const next: Entry = { ...e };
  if (typeof m.name === 'string' && m.name.trim()) next.name = m.name.trim().slice(0, 32);
  if (m.host !== undefined) {
    if (!validAddress(String(m.host).trim())) return ctx.notify('That is not an IP address or host name', 'warning');
    next.host = String(m.host).trim();
  }
  if (m.brand in BRANDS) {
    next.brand = m.brand;
    if (!BRANDS[next.brand].protocols.includes(next.protocol)) next.protocol = BRANDS[next.brand].protocols[0]!;
  }
  if (m.protocol !== undefined && BRANDS[next.brand].protocols.includes(m.protocol)) next.protocol = m.protocol;
  if (m.port !== undefined) {
    const p = m.port === '' || m.port === null ? 0 : Number(m.port);
    if (!Number.isInteger(p) || p < 0 || p > 65535) return ctx.notify('Port must be 1 to 65535, or empty for the usual one', 'warning');
    next.port = p;
  }
  if (m.video) {
    const v = videoOf(m.video, m.video.newKey ? newKey() : e.video.key);
    if (typeof v === 'string') return ctx.notify(v, 'warning');
    next.video = v;
  }
  if (m.webPort !== undefined) {
    const p = m.webPort === '' || m.webPort === null ? 0 : Number(m.webPort);
    if (!Number.isInteger(p) || p < 0 || p > 65535) return ctx.notify('Port must be 1 to 65535, or empty for 80', 'warning');
    next.webPort = p;
  }
  if (typeof m.invertPan === 'boolean') next.invertPan = m.invertPan;
  if (typeof m.invertTilt === 'boolean') next.invertTilt = m.invertTilt;
  await ctx.setConfig({ ...c, cameras: c.cameras.map((x) => (x.id === e.id ? next : x)) });
  await sync(ctx);
  await draw(ctx);
}

async function moveCamera(ctx: C, id: unknown, dir: number): Promise<void> {
  const c = cfg(ctx);
  const i = c.cameras.findIndex((e) => e.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= c.cameras.length) return;
  const list = [...c.cameras];
  [list[i], list[j]] = [list[j]!, list[i]!];
  await ctx.setConfig({ ...c, cameras: list });
  await sync(ctx);
  if (rt) rt.cameras = new Map(list.map((e) => [e.id, rt!.cameras.get(e.id)!]).filter(([, v]) => v) as [string, Camera][]);
  await draw(ctx);
}

async function removeCamera(ctx: C, id: unknown): Promise<void> {
  const c = cfg(ctx);
  const e = c.cameras.find((x) => x.id === id);
  if (!e) return;
  stopAll(ctx, e.id);
  await ctx.setConfig({ ...c, cameras: c.cameras.filter((x) => x.id !== e.id) });
  const s = { ...(ctx.secrets?.value ?? {}) };
  if (s.cams?.[e.id]) {
    const cams = { ...s.cams };
    delete cams[e.id];
    await ctx.secrets.set({ ...s, cams }).catch(() => {});
  }
  await ctx.log('info', `Removed camera ${e.name} (${e.host})`);
  await sync(ctx);
  if (ctx.state.value.cam === e.id) await ctx.state.patch({ cam: cfg(ctx).cameras[0]?.id ?? '' });
  await draw(ctx);
}

async function setCredentials(ctx: C, m: any): Promise<void> {
  const user = typeof m.user === 'string' ? m.user.trim().slice(0, 64) : '';
  const password = typeof m.password === 'string' ? m.password.slice(0, 128) : '';
  const s = { ...(ctx.secrets?.value ?? {}) };
  if (m.bridge) s.bridge = user ? { user, password } : undefined;
  else {
    if (!cfg(ctx).cameras.some((e) => e.id === m.id)) return;
    const cams = { ...(s.cams ?? {}) };
    if (user) cams[m.id] = { user, password };
    else delete cams[m.id];
    s.cams = cams;
  }
  if (!s.bridge) delete s.bridge;
  try {
    await ctx.secrets.set(s);
  } catch {
    return ctx.notify('This controller can’t keep logins: update the controller', 'warning');
  }
  if (!m.bridge) {
    // A new login needs a new connection.
    const cam = rt?.cameras.get(m.id);
    if (cam && rt) {
      cam.stop();
      const fresh = newCamera(ctx, cam.entry as Entry);
      rt.cameras.set(m.id, fresh);
      fresh.start();
      watched();
    }
  }
  await draw(ctx);
}

async function setPresetName(ctx: C, m: any): Promise<void> {
  const c = cfg(ctx);
  const e = c.cameras.find((x) => x.id === m.id);
  const n = Number(m.n);
  if (!e || !Number.isInteger(n) || n < 1 || n > PRESETS) return;
  const names = Array.from({ length: PRESETS }, (_, i) => e.presetNames[i] ?? '');
  names[n - 1] = typeof m.name === 'string' ? m.name.trim().slice(0, 24) : '';
  while (names.length && !names[names.length - 1]) names.pop();
  await ctx.setConfig({ ...c, cameras: c.cameras.map((x) => (x.id === e.id ? { ...x, presetNames: names } : x)) });
  await sync(ctx);
  await draw(ctx);
}

async function setAllow(ctx: C, on: unknown): Promise<void> {
  if (!on && rt) for (const id of rt.cameras.keys()) stopAll(ctx, id);
  await ctx.setConfig({ ...cfg(ctx), allowControls: !!on });
  await ctx.log('info', on ? 'Controls allowed' : 'Controls turned off: the module only reads');
  await draw(ctx);
}

async function runScan(ctx: C, target: unknown): Promise<void> {
  if (!rt || rt.scan.running) return;
  const t = typeof target === 'string' ? target.trim() : '';
  if (t && !/^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(t)) return ctx.notify('Give an address like 10.0.0.0/24, or leave it empty for the unit’s own networks', 'warning');
  rt.scan = { running: true, found: rt.scan.found, error: '', at: rt.scan.at, target: t };
  await draw(ctx);
  const r = rt;
  try {
    const found = await scan({ target: t, ...(scanPorts() ?? {}) });
    if (rt !== r) return;
    r.scan = { running: false, found, error: '', at: Date.now(), target: t };
    await ctx.log('info', `Scan found ${found.length} camera${found.length === 1 ? '' : 's'}`);
  } catch (e) {
    if (rt !== r) return;
    r.scan = { running: false, found: [], error: (e as Error).message, at: Date.now(), target: t };
  }
  await draw(ctx);
}

/** Tests point the scan at a simulator. */
function scanPorts() {
  const p = process.env.RCS_PTZ_SCAN_PORTS;
  if (!p) return null;
  try {
    return { ports: JSON.parse(p), unicastOnly: true, timeoutMs: 800 };
  } catch {
    return null;
  }
}

// ---- operator actions: the only things that change a camera ---------------------------------------

// ---- the camera's own RTMP push setting ----

/** Where this camera should push: the unit's address on the camera's network, and the camera's stream key. */
function rtmpTarget(ctx: C, e: Entry): { server: string; key: string } {
  const ip = /^127\./.test(e.host) || e.host === 'localhost' ? '127.0.0.1' : localFor(e.host);
  return { server: `rtmp://${ip}:${cfg(ctx).rtmpPort}/${RTMP_APP}`, key: e.video.key };
}

const webPortOf = (e: Entry) => (e.brand === 'panasonic' ? portOf(e) : e.webPort || 80);

function rtmpSetupView(ctx: C, e: Entry) {
  const setup = rtmpSetupFor(e.brand);
  const info = rt?.rtmpInfo.get(e.id);
  const t = rtmpTarget(ctx, e);
  return {
    supported: !!setup,
    why: setup ? '' : rtmpSetupMissing(e.brand),
    models: setup?.models ?? '',
    readable: setup?.readable ?? false,
    target: `${t.server}/${t.key}`,
    webPort: webPortOf(e),
    busy: info?.busy ?? '',
    read: info?.read ?? null,
    error: info?.error ?? '',
    done: info?.done ?? ''
  };
}

function rtmpInfo(id: string): RtmpInfo {
  let i = rt!.rtmpInfo.get(id);
  if (!i) rt!.rtmpInfo.set(id, (i = { busy: '', read: null, error: '', done: '' }));
  return i;
}

/** Reads the camera's own RTMP setting (a read: no Allow controls needed). */
async function readCameraRtmp(ctx: C, id: unknown): Promise<void> {
  const e = cfg(ctx).cameras.find((x) => x.id === id);
  const setup = e && rtmpSetupFor(e.brand);
  if (!rt || !e || !setup?.readable) return;
  const info = rtmpInfo(e.id);
  if (info.busy) return;
  info.busy = 'reading';
  info.error = '';
  await draw(ctx);
  try {
    info.read = await setup.read(e.host, webPortOf(e), creds(ctx, e.id));
  } catch (err) {
    info.error = `Could not read the camera’s RTMP setting: ${(err as Error).message}`;
  }
  info.busy = '';
  await draw(ctx);
}

/**
 * Sets the camera's RTMP push to this unit. A command to the camera: the web view asks first and sends
 * confirmed: true, Allow controls must be on, and the camera's login must be saved.
 */
async function pointCameraRtmp(ctx: C, m: any, who: string): Promise<void> {
  const e = cfg(ctx).cameras.find((x) => x.id === m.id);
  if (!rt || !e) return;
  const setup = rtmpSetupFor(e.brand);
  if (!setup) return ctx.notify(`${e.name}: ${rtmpSetupMissing(e.brand)}`, 'warning');
  if (m.confirmed !== true) return;
  if (!allowed(ctx)) return;
  if (e.video.mode !== 'push') return ctx.notify(`${e.name}: set Video to “Camera pushes RTMP to this unit” first`, 'warning');
  const login = creds(ctx, e.id);
  if (!login) return ctx.notify(`${e.name}: save the camera’s login (an admin user) first`, 'warning');
  const info = rtmpInfo(e.id);
  if (info.busy) return;
  const t = rtmpTarget(ctx, e);
  info.busy = 'setting';
  info.error = info.done = '';
  await draw(ctx);
  try {
    await setup.set(e.host, webPortOf(e), login, t.server, t.key);
    await ctx.log('info', `${e.name}: set the camera to push RTMP to ${t.server}/${t.key} (${who})`);
    info.done = `Set to ${t.server}/${t.key}`;
    if (setup.readable) {
      try {
        info.read = await setup.read(e.host, webPortOf(e), login);
      } catch {}
    }
    await ctx.notify(`${e.name}: the camera now pushes to this unit`, 'info');
  } catch (err) {
    info.error = `Could not set the camera’s RTMP push: ${(err as Error).message}`;
    await ctx.log('warning', `${e.name}: ${info.error}`);
    await ctx.notify(`${e.name}: ${info.error}`, 'error');
  }
  info.busy = '';
  await draw(ctx);
}

function allowed(ctx: C, quietly = false): boolean {
  if (cfg(ctx).allowControls) return true;
  if (!quietly) quiet(ctx.notify('This module only reads. Turn on Allow controls in Setup to move cameras.', 'warning'));
  return false;
}

function failed(ctx: C, cam: Camera, e: unknown): void {
  if (!rt) return;
  const t = rt.lastError.get(cam.entry.id) ?? 0;
  if (Date.now() - t < 3000) return;
  rt.lastError.set(cam.entry.id, Date.now());
  quiet(ctx.notify(`${cam.entry.name}: ${(e as Error).message}`, 'error'));
}

/** Sets one source's move on a camera (null clears it); the camera gets the sum of every source. */
function setMotion(ctx: C, id: string, source: string, m: Motion | null, ttlMs = 0): void {
  if (!rt) return;
  let map = rt.motion.get(id);
  if (!map) rt.motion.set(id, (map = new Map()));
  const old = map.get(source);
  if (old?.timer) clearTimeout(old.timer);
  if (!m || (!m.pan && !m.tilt && !m.zoom && !m.focus)) map.delete(source);
  else {
    const s: Source = { m, timer: null };
    if (ttlMs) {
      s.timer = setTimeout(() => setMotion(ctx, id, source, null), ttlMs);
      s.timer.unref?.();
    }
    map.set(source, s);
  }
  apply(ctx, id);
}

function stopAll(ctx: C, id: string): void {
  const map = rt?.motion.get(id);
  if (!map) return;
  for (const s of map.values()) if (s.timer) clearTimeout(s.timer);
  map.clear();
  apply(ctx, id);
}

function apply(ctx: C, id: string): void {
  if (!rt) return;
  const cam = rt.cameras.get(id);
  if (!cam) return;
  const total: Motion = { pan: 0, tilt: 0, zoom: 0, focus: 0 };
  for (const s of rt.motion.get(id)?.values() ?? []) {
    total.pan += s.m.pan;
    total.tilt += s.m.tilt;
    total.zoom += s.m.zoom;
    total.focus += s.m.focus;
  }
  for (const k of ['pan', 'tilt', 'zoom', 'focus'] as const) total[k] = clamp(total[k], -1, 1);
  const was = rt.sent.get(id) ?? { pan: 0, tilt: 0, zoom: 0, focus: 0 };
  rt.sent.set(id, total);
  const d = cam.driver;
  const e = cam.entry;
  if (total.pan !== was.pan || total.tilt !== was.tilt) quiet(d.move(total.pan * (e.invertPan ? -1 : 1), total.tilt * (e.invertTilt ? -1 : 1)).catch((err) => failed(ctx, cam, err)));
  if (total.zoom !== was.zoom) quiet(d.zoom(total.zoom).catch((err) => failed(ctx, cam, err)));
  if (total.focus !== was.focus) {
    const go = async () => {
      // Focus keys drive a camera in auto focus by switching it to manual first.
      if (total.focus && cam.view.status?.focusAuto) {
        await d.set('focus', 'manual');
        if (cam.view.status) cam.view.status.focusAuto = false;
      }
      await d.focus(total.focus);
    };
    quiet(go().catch((err) => failed(ctx, cam, err)));
  }
  soon(ctx);
}

/** Recomputes the keys' move from the arrows, zoom and focus keys held now. */
function keysMotion(ctx: C): void {
  const cam = current(ctx);
  if (!rt || !cam) return;
  const sp = SPEEDS[speed(ctx)];
  let pan = 0,
    tilt = 0,
    zoom = 0,
    focus = 0;
  for (const k of rt.held) {
    const d = DIRS[k];
    if (d) {
      pan += d[0];
      tilt += d[1];
    }
    if (k === KEY.ZOOM_IN) zoom += 1;
    if (k === KEY.ZOOM_OUT) zoom -= 1;
    if (k === KEY.FAR) focus += 1;
    if (k === KEY.NEAR) focus -= 1;
  }
  setMotion(ctx, cam.entry.id, 'keys', { pan: clamp(pan, -1, 1) * sp, tilt: clamp(tilt, -1, 1) * sp, zoom: clamp(zoom, -1, 1) * Math.max(sp, 0.4), focus: clamp(focus, -1, 1) * FOCUS_SPEED });
}

async function oneShot(ctx: C, cam: Camera, what: string, fn: () => Promise<void>, who: string, readBack = true): Promise<void> {
  if (!allowed(ctx)) return;
  try {
    await fn();
    await ctx.log('info', `${cam.entry.name}: ${what} (${who})`);
  } catch (e) {
    failed(ctx, cam, e);
  }
  if (readBack) void cam.poll();
}

async function recall(ctx: C, cam: Camera, n: number, who: string): Promise<void> {
  if (!Number.isInteger(n) || n < 1 || n > PRESETS) return;
  await oneShot(ctx, cam, `recall preset ${n}`, () => cam.driver.recall(n), who);
}

async function store(ctx: C, cam: Camera, n: number, who: string): Promise<void> {
  if (!Number.isInteger(n) || n < 1 || n > PRESETS) return;
  await oneShot(ctx, cam, `store preset ${n}`, () => cam.driver.store(n), who);
  await ctx.notify(`${cam.entry.name}: stored preset ${n}`);
}

async function setParam(ctx: C, cam: Camera, id: string, value: number | string, who: string): Promise<void> {
  const p = cam.view.picture.find((x) => x.id === id);
  if (!p) return;
  if (p.kind === 'enum' && !p.options?.some((o) => o.value === value)) return;
  if (p.kind === 'range' && (typeof value !== 'number' || !Number.isFinite(value))) return;
  const v = p.kind === 'range' ? clamp(value as number, p.min ?? -Infinity, p.max ?? Infinity) : value;
  await oneShot(ctx, cam, `${p.label} ${p.kind === 'action' ? '' : 'to ' + v}`.trim(), () => cam.driver.set(id, v), who, false);
  await cam.refreshPicture();
}

/** A + or − on a setting: the next value of a range by its step (bigger on wide ranges), or the next option. */
async function stepParam(ctx: C, cam: Camera, ids: string[], dir: 1 | -1, who: string): Promise<void> {
  const p = param(cam, ids);
  if (!p || p.enabled === false) return;
  if (p.kind === 'range') {
    const span = (p.max ?? 0) - (p.min ?? 0);
    const step = Math.max(p.step ?? 1, span > 64 ? span / 32 : 0);
    const v = clamp(Math.round((Number(p.value) + dir * step) / (p.step ?? 1)) * (p.step ?? 1), p.min ?? -Infinity, p.max ?? Infinity);
    if (v === p.value) return;
    p.value = v; // shown at once; the read after confirms it
    return setParam(ctx, cam, p.id, v, who);
  }
  if (p.kind === 'enum' && p.options?.length) {
    const i = p.options.findIndex((o) => o.value === p.value);
    const o = p.options[(i + dir + p.options.length) % p.options.length]!;
    return setParam(ctx, cam, p.id, o.value, who);
  }
}

function disarmStore(): void {
  if (!rt?.storeArmed) return;
  clearTimeout(rt.storeArmed);
  rt.storeArmed = null;
}

function armStore(ctx: C): void {
  if (!rt) return;
  disarmStore();
  const r = rt;
  r.storeArmed = setTimeout(() => {
    r.storeArmed = null;
    soon(ctx);
  }, STORE_MS);
  soon(ctx);
}

/** The bridge's ONVIF PTZ requests, turned into the same moves as the keys. */
async function bridgeControl(ctx: C, id: string, a: BridgeAction): Promise<string> {
  const cam = rt?.cameras.get(id);
  if (!cam) return 'No such camera';
  if (!cfg(ctx).allowControls) return 'Allow controls is off on the rack unit';
  switch (a.action) {
    case 'move': {
      const prev = rt!.motion.get(id)?.get('bridge')?.m;
      setMotion(ctx, id, 'bridge', { pan: clamp(a.pan, -1, 1), tilt: clamp(a.tilt, -1, 1), zoom: clamp(a.zoom, -1, 1), focus: prev?.focus ?? 0 }, a.timeoutMs);
      return '';
    }
    case 'stop': {
      const prev = rt!.motion.get(id)?.get('bridge')?.m;
      if (!prev) return '';
      const m = { ...prev, ...(a.panTilt ? { pan: 0, tilt: 0 } : {}), ...(a.zoom ? { zoom: 0 } : {}) };
      setMotion(ctx, id, 'bridge', m, 15_000);
      return '';
    }
    case 'recall':
      await recall(ctx, cam, a.n, 'ONVIF bridge');
      return '';
    case 'store':
      await store(ctx, cam, a.n, 'ONVIF bridge');
      return '';
    case 'home':
      await oneShot(ctx, cam, 'home', () => cam.driver.home(), 'ONVIF bridge');
      return '';
  }
}

function bridgeCameras(ctx: C): BridgeCamera[] {
  return cfg(ctx).cameras.map((e) => {
    const cam = rt?.cameras.get(e.id);
    return {
      id: e.id,
      name: e.name,
      width: cam?.stream.width || 1920,
      height: cam?.stream.height || 1080,
      presets: Array.from({ length: PRESETS }, (_, i) => ({ n: i + 1, name: e.presetNames[i] ?? '' })),
      position: () => {
        const s = cam?.view.status;
        const m = motionOf(e.id);
        const frac = (v: number | undefined, range: number) => (v === undefined ? undefined : clamp(v / range, -1, 1));
        return {
          pan: e.protocol === 'onvif' ? s?.pan : frac(s?.pan, 0x0990),
          tilt: e.protocol === 'onvif' ? s?.tilt : frac(s?.tilt, 0x0510),
          zoom: s?.zoom,
          moving: !!(m.pan || m.tilt || m.zoom)
        };
      }
    };
  });
}

function uiMotion(m: any): Motion {
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? clamp(x, -1, 1) : 0);
  return { pan: n(m.pan), tilt: n(m.tilt), zoom: n(m.zoom), focus: n(m.focus) };
}

export default defineModule<State, Config>({
  // The panel UI fills a taller screen too (1824×1080 on a 16:9 one). Controllers before 0.22.0 ignore it.
  fullPanel: true,
  // Every key of a larger deck: camera and preset keys around the usual 15. Older controllers ignore
  // this and send 15 keys.
  fullDeck: true,

  // The deck changed size: keys moved, so a held key may never come up. Stop the keys' move.
  async deck(ctx) {
    if (!rt) return;
    rt.held.clear();
    const cam = current(ctx);
    if (cam) setMotion(ctx, cam.entry.id, 'keys', null);
    disarmStore();
    await ctx.keys.clear();
    await draw(ctx);
  },

  async start(ctx) {
    if (rt) {
      for (const c of rt.cameras.values()) c.stop();
      rt.video.stop();
      await rt.rtmp.close();
      await rt.rtsp.close();
      await rt.bridge.close();
    }
    const cams = () => rt?.cameras;
    const video = new VideoHub(
      (m, id) => ctx.ui.send(m, id),
      (id) => cams()?.get(id)?.stream ?? null,
      () => watched()
    );
    const rtmp = new RtmpServer((key) => [...(cams()?.values() ?? [])].find((c) => c.entry.video.mode === 'push' && c.entry.video.key === key)?.stream ?? null);
    const rtsp = new RtspServer(
      (id) => {
        const c = cams()?.get(id);
        return c ? { name: c.entry.name, stream: c.stream } : null;
      },
      () => bridgeLogin(ctx)
    );
    const bridge = new OnvifBridge({
      cameras: () => bridgeCameras(ctx),
      control: (id, a) => bridgeControl(ctx, id, a),
      auth: () => bridgeLogin(ctx),
      rtspPort: () => rtsp.port || cfg(ctx).bridge.rtspPort,
      version: VERSION
    });
    rt = {
      cameras: new Map(),
      view: 'cameras',
      held: new Set(),
      motion: new Map(),
      sent: new Map(),
      storeArmed: null,
      drawTimer: null,
      video,
      rtmp,
      rtsp,
      bridge,
      bridgeOn: false,
      scan: { running: false, found: [], error: '', at: 0, target: '' },
      pictureViewers: new Map(),
      lastError: new Map(),
      refused: '',
      rtmpInfo: new Map()
    };
    rtmp.on('publish', () => soon(ctx));
    rtmp.on('unpublish', () => soon(ctx));
    rtmp.on('refused', (key: string, peer: string) => {
      if (rt) rt.refused = `${peer} pushed to an unknown stream key (${key.slice(0, 4)}…)`;
      soon(ctx);
    });
    rtsp.on('change', () => {
      watched();
      soon(ctx);
    });
    rtsp.on('want', (id: string) => rt?.cameras.get(id)?.setWatched(true));
    await ctx.state.init({ cam: '', keyMode: 'ptz', speed: 'medium' });
    await ctx.strip.set([
      { id: 'cameras', label: 'Cameras', icon: 'assets/cameras.svg' },
      { id: 'picture', label: 'Picture', icon: 'assets/picture.svg' },
      { id: 'presets', label: 'Presets', icon: 'assets/presets.svg' },
      { id: 'setup', label: 'Setup', icon: 'assets/setup.svg' }
    ]);
    await sync(ctx); // reads only: nothing is sent to a camera on start, whatever the reason
    const first = cfg(ctx).cameras[0];
    if (!rt.cameras.has(ctx.state.value.cam) && first) await ctx.state.patch({ cam: first.id });
    pictureWanted(ctx);
    await reportStatus(ctx);
    await draw(ctx);
  },

  async stop() {
    if (!rt) return;
    const r = rt;
    rt = null;
    if (r.drawTimer) clearTimeout(r.drawTimer);
    if (r.storeArmed) clearTimeout(r.storeArmed);
    // Anything still moving stops: the module is going away.
    for (const [id, map] of r.motion) {
      const cam = r.cameras.get(id);
      if (!cam || !map.size) continue;
      for (const s of map.values()) if (s.timer) clearTimeout(s.timer);
      await Promise.allSettled([cam.driver.move(0, 0), cam.driver.zoom(0)]);
    }
    for (const c of r.cameras.values()) c.stop();
    r.video.stop();
    await r.rtmp.close();
    await r.rtsp.close();
    await r.bridge.close();
  },

  async keysOwned(ctx, owned) {
    // The system borrowed the keys (panel lock, a Settings keypad): a held key will never come up.
    if (!owned && rt) {
      rt.held.clear();
      const cam = current(ctx);
      if (cam) setMotion(ctx, cam.entry.id, 'keys', null);
    }
    if (owned) await draw(ctx);
  },

  async key(ctx, { index: d, action }) {
    if (!rt) return;
    const mode = keyMode(ctx);
    const cam = current(ctx);
    const L = layout(grid(ctx));
    const index = L.block.indexOf(d);
    if (index < 0) {
      if (action !== 'down') return;
      const c = L.cameras.indexOf(d);
      if (c >= 0) {
        const id = [...rt.cameras.keys()][c];
        return id ? select(ctx, id) : undefined;
      }
      const p = L.presets.indexOf(d);
      if (p < 0 || !cam) return;
      const n = extraPreset(ctx, p);
      if (n > PRESETS) return;
      if (mode === 'presets' && rt.storeArmed) {
        disarmStore();
        await store(ctx, cam, n, 'the panel keys');
      } else await recall(ctx, cam, n, 'the panel keys');
      return draw(ctx);
    }
    if (mode === 'ptz' && (DIRS[index] || index === KEY.ZOOM_IN || index === KEY.ZOOM_OUT || index === KEY.NEAR || index === KEY.FAR)) {
      if (action === 'up') {
        if (rt.held.delete(index)) keysMotion(ctx);
        return;
      }
      if (!cam || !allowed(ctx)) return;
      rt.held.add(index);
      keysMotion(ctx);
      return;
    }
    if (action !== 'down') return;
    if (index === KEY.MODE) {
      rt.held.clear();
      if (cam) setMotion(ctx, cam.entry.id, 'keys', null);
      disarmStore();
      await ctx.state.patch({ keyMode: mode === 'ptz' ? 'presets' : mode === 'presets' ? 'picture' : 'ptz' });
      pictureWanted(ctx);
      return draw(ctx);
    }
    if (mode === 'ptz') {
      if (index === KEY.CAM) {
        const list = [...rt.cameras.keys()];
        if (list.length < 2) return;
        return select(ctx, list[(list.indexOf(cam?.entry.id ?? '') + 1) % list.length]);
      }
      if (index === KEY.SPEED) {
        const s = speed(ctx);
        await ctx.state.patch({ speed: s === 'slow' ? 'medium' : s === 'medium' ? 'fast' : 'slow' });
        return draw(ctx);
      }
      return;
    }
    if (!cam) return;
    if (mode === 'presets') {
      if (index < 12) {
        const n = index + 1;
        if (rt.storeArmed) {
          disarmStore();
          await store(ctx, cam, n, 'the panel keys');
        } else await recall(ctx, cam, n, 'the panel keys');
        return draw(ctx);
      }
      if (index === KEY.HOME) {
        disarmStore();
        await oneShot(ctx, cam, 'home', () => cam.driver.home(), 'the panel keys');
        return draw(ctx);
      }
      if (index === KEY.STORE) {
        if (rt.storeArmed) disarmStore();
        else if (allowed(ctx)) armStore(ctx);
        return draw(ctx);
      }
      return;
    }
    // picture
    if (index < 10) {
      if (!allowed(ctx)) return;
      await stepParam(ctx, cam, PICTURE_KEYS[index % 5]!.ids, index < 5 ? 1 : -1, 'the panel keys');
      return draw(ctx);
    }
    if (!allowed(ctx)) return;
    if (index === 10) await stepParam(ctx, cam, AE_IDS, 1, 'the panel keys');
    if (index === 11) await stepParam(ctx, cam, WB_IDS, 1, 'the panel keys');
    if (index === 12) {
      const p = param(cam, AWB_IDS);
      if (p?.enabled) await setParam(ctx, cam, p.id, 1, 'the panel keys');
    }
    if (index === 13) {
      const p = param(cam, ['focus']);
      if (p) await setParam(ctx, cam, 'focus', p.value === 'auto' ? 'manual' : 'auto', 'the panel keys');
    }
    return draw(ctx);
  },

  async strip(ctx, id) {
    await setView(ctx, id);
  },

  async client(ctx, { clientId, action }) {
    if (action === 'connect') await draw(ctx, clientId);
    if (action === 'disconnect' && rt) {
      rt.video.drop(clientId);
      rt.pictureViewers.delete(clientId);
      for (const id of rt.cameras.keys()) setMotion(ctx, id, `ui:${clientId}`, null);
      pictureWanted(ctx);
    }
  },

  async ui(ctx, { clientId, message: m }) {
    if (!rt || typeof m !== 'object' || m === null) return;
    const who = m.from === 'web' ? 'the web view' : 'the panel';
    const camOf = () => (typeof m.id === 'string' ? rt?.cameras.get(m.id) : current(ctx));
    switch (m.type) {
      case 'hello':
        return draw(ctx, clientId);
      case 'view':
        return setView(ctx, m.view);
      case 'select':
        return select(ctx, m.id);
      case 'speed':
        if (m.speed in SPEEDS) await ctx.state.patch({ speed: m.speed });
        return draw(ctx);
      case 'key-mode':
        if (['ptz', 'presets', 'picture'].includes(m.mode)) await ctx.state.patch({ keyMode: m.mode });
        pictureWanted(ctx);
        return draw(ctx);
      case 'picture-of':
        // A web view showing the Picture page for a camera other than the selected one.
        if (typeof m.id === 'string' && rt.cameras.has(m.id)) rt.pictureViewers.set(clientId, m.id);
        else rt.pictureViewers.delete(clientId);
        pictureWanted(ctx);
        return draw(ctx, clientId);
      case 'move': {
        // A held on-screen button: repeated while held, stops on its own if the repeats stop.
        const cam = camOf();
        if (!cam) return;
        const mo = uiMotion(m);
        const any = mo.pan || mo.tilt || mo.zoom || mo.focus;
        if (any && !allowed(ctx)) return;
        setMotion(ctx, cam.entry.id, `ui:${clientId}`, any ? mo : null, UI_HOLD_MS);
        return;
      }
      case 'stop': {
        const cam = camOf();
        if (cam) setMotion(ctx, cam.entry.id, `ui:${clientId}`, null);
        return;
      }
      case 'home': {
        const cam = camOf();
        if (cam) await oneShot(ctx, cam, 'home', () => cam.driver.home(), who);
        return draw(ctx);
      }
      case 'recall': {
        const cam = camOf();
        if (cam) await recall(ctx, cam, Number(m.n), who);
        return draw(ctx);
      }
      case 'store': {
        // The panel's Store button arms; the next preset tap stores. The web view asks first, then sends this.
        const cam = camOf();
        if (cam) await store(ctx, cam, Number(m.n), who);
        disarmStore();
        return draw(ctx);
      }
      case 'arm-store':
        if (rt.storeArmed) disarmStore();
        else if (allowed(ctx)) armStore(ctx);
        return draw(ctx);
      case 'set': {
        const cam = camOf();
        if (cam && typeof m.param === 'string') await setParam(ctx, cam, m.param, m.value, who);
        return draw(ctx);
      }
      case 'step': {
        const cam = camOf();
        if (cam && typeof m.param === 'string' && allowed(ctx)) await stepParam(ctx, cam, [m.param], m.dir === -1 ? -1 : 1, who);
        return draw(ctx);
      }
      case 'add':
        return addCamera(ctx, m);
      case 'edit':
        return editCamera(ctx, m);
      case 'reorder':
        return moveCamera(ctx, m.id, m.dir === -1 ? -1 : 1);
      case 'remove':
        return removeCamera(ctx, m.id);
      case 'credentials':
        return setCredentials(ctx, m);
      case 'rtmp-read':
        return readCameraRtmp(ctx, m.id);
      case 'rtmp-point':
        return pointCameraRtmp(ctx, m, who);
      case 'preset-name':
        return setPresetName(ctx, m);
      case 'allow':
        return setAllow(ctx, m.on);
      case 'live-video':
        if (['all', 'selected', 'off'].includes(m.mode)) await ctx.setConfig({ ...cfg(ctx), liveVideo: m.mode });
        return draw(ctx);
      case 'rtmp-port': {
        const p = Number(m.port);
        if (!isPort(p)) return ctx.notify('Port must be 1 to 65535', 'warning');
        await ctx.setConfig({ ...cfg(ctx), rtmpPort: p });
        await sync(ctx);
        return draw(ctx);
      }
      case 'bridge': {
        const c = cfg(ctx);
        const b = { ...c.bridge };
        if (typeof m.enabled === 'boolean') b.enabled = m.enabled;
        if (typeof m.discovery === 'boolean') b.discovery = m.discovery;
        for (const k of ['basePort', 'rtspPort'] as const) {
          if (m[k] === undefined) continue;
          if (!isPort(Number(m[k]))) return ctx.notify('Ports are 1 to 65535', 'warning');
          b[k] = Number(m[k]);
        }
        await ctx.setConfig({ ...c, bridge: b });
        await ctx.log('info', b.enabled ? 'ONVIF bridge on' : 'ONVIF bridge off');
        await syncBridge(ctx);
        return draw(ctx);
      }
      case 'scan':
        return runScan(ctx, m.target);
      case 'add-found': {
        const f = rt.scan.found.find((x) => x.host === m.host);
        if (!f) return;
        return addCamera(ctx, { host: f.host, brand: f.brand, protocol: f.protocol, port: f.port === PROTOCOLS[f.protocol].port ? 0 : f.port, name: f.name || f.model || undefined, video: { mode: 'push' } });
      }
      case 'video':
        rt.video.want(clientId, Array.isArray(m.cams) ? m.cams.filter((x: unknown) => typeof x === 'string').slice(0, MAX_CAMERAS) : []);
        return;
      case 'reconnect':
        for (const c of rt.cameras.values()) void c.poll();
        return;
    }
  }
});
