// What every camera protocol offers the module: movement at a speed, presets, and picture settings described
// generically, so the panel and web view draw one page for any camera. A picture setting a camera doesn't
// answer when it is read is left out: what is shown is what that camera has.

export type Protocol = 'visca-udp' | 'visca-tcp' | 'panasonic' | 'onvif';
export type Brand = 'sony' | 'birddog' | 'panasonic' | 'ptzoptics' | 'visca' | 'onvif';

export const BRANDS: Record<Brand, { label: string; protocols: Protocol[] }> = {
  sony: { label: 'Sony', protocols: ['visca-udp'] },
  birddog: { label: 'BirdDog', protocols: ['visca-udp'] },
  panasonic: { label: 'Panasonic', protocols: ['panasonic'] },
  ptzoptics: { label: 'PTZOptics', protocols: ['visca-tcp', 'visca-udp'] },
  visca: { label: 'Other VISCA camera', protocols: ['visca-udp', 'visca-tcp'] },
  onvif: { label: 'ONVIF camera', protocols: ['onvif'] }
};

export const PROTOCOLS: Record<Protocol, { label: string; port: number }> = {
  'visca-udp': { label: 'VISCA over IP (UDP)', port: 52381 },
  'visca-tcp': { label: 'VISCA over TCP', port: 5678 },
  panasonic: { label: 'Panasonic AW (HTTP)', port: 80 },
  onvif: { label: 'ONVIF', port: 80 }
};

export type ParamGroup = 'exposure' | 'color' | 'focus' | 'image';

export interface Param {
  id: string;
  label: string;
  group: ParamGroup;
  kind: 'range' | 'enum' | 'action';
  value?: number | string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: number | string; label: string }[];
  /** The value as the operator reads it: "F2.8", "+6 dB", "step 7". */
  text?: string;
  /** False when the camera's mode makes it do nothing (iris in full auto). */
  enabled?: boolean;
  /** One line on what it does or why it is off. */
  hint?: string;
}

export interface Status {
  power: 'on' | 'standby' | '';
  /** Pan and tilt as the camera reports them, in its own units, and as a fraction of its range when known. */
  pan?: number;
  tilt?: number;
  /** 0 (wide) to 1 (tele) when known. */
  zoom?: number;
  focusAuto?: boolean;
}

export interface Identity {
  vendor: string;
  model: string;
  firmware: string;
  /** For ONVIF cameras: their own RTSP stream, shown in Setup. */
  rtsp?: string;
}

export interface Credentials {
  user: string;
  password: string;
}

export class CameraError extends Error {}

/** Reads have no effect on the camera; everything below "commands" moves it or changes a setting. */
export interface Driver {
  readonly protocol: Protocol;
  identify(): Promise<Identity>;
  status(): Promise<Status>;
  picture(): Promise<Param[]>;
  // commands
  /** Pan and tilt velocity, -1 to 1 each (negative: left, down). 0, 0 stops. */
  move(pan: number, tilt: number): Promise<void>;
  /** -1 (wide) to 1 (tele); 0 stops. */
  zoom(v: number): Promise<void>;
  /** -1 (near) to 1 (far); 0 stops. */
  focus(v: number): Promise<void>;
  home(): Promise<void>;
  /** Presets are numbered from 1. */
  recall(n: number): Promise<void>;
  store(n: number): Promise<void>;
  set(id: string, value: number | string): Promise<void>;
  close(): void;
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** A velocity -1..1 as a speed step 1..max (0 for a stop). */
export const speedStep = (v: number, max: number) => (v === 0 ? 0 : clamp(Math.round(Math.abs(v) * max), 1, max));
