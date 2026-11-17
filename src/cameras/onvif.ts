// ONVIF cameras: Profile S PTZ (ContinuousMove, Stop, presets, home) and the Imaging service for the picture
// (exposure, gain, iris, white balance with Cr/Cb gains, brightness, saturation, sharpness, focus). Ranges come
// from the camera's own GetOptions. Logins use WS-Security digest, the user name and password kept as secrets.

import { soap, SoapError, type SoapAuth } from '../onvif/soap.js';
import { child, find, findAll, num, text, type XmlNode } from '../onvif/xml.js';
import { CameraError, type Credentials, type Driver, type Identity, type Param, type Status, clamp } from './types.js';
import { esc } from '../onvif/xml.js';

interface Endpoints {
  media: string;
  ptz: string;
  imaging: string;
  profile: string;
  source: string;
  ptzRange?: { pan: [number, number]; tilt: [number, number] };
}

type Opt = { min: number; max: number };

export class OnvifDriver implements Driver {
  readonly protocol = 'onvif' as const;
  private ep: Endpoints | null = null;
  private presets: { token: string; name: string }[] | null = null;
  /** Camera clock minus ours, so a digest's Created is in the camera's time. */
  private offset = 0;
  private options: Record<string, Opt | string[]> = {};
  private imaging: XmlNode | null = null;
  private closed = false;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly creds: () => Credentials | null
  ) {}

  private get device(): string {
    return `http://${this.host.includes(':') ? `[${this.host}]` : this.host}:${this.port}/onvif/device_service`;
  }

  private auth(): SoapAuth | null {
    const c = this.creds();
    return c?.user ? { user: c.user, password: c.password } : null;
  }

  private call(url: string, body: string): Promise<XmlNode> {
    if (this.closed) return Promise.reject(new CameraError('Closed'));
    return soap(url, body, this.auth(), 4000, this.offset).catch((e) => {
      throw new CameraError(e instanceof SoapError ? e.message : (e as Error).message);
    });
  }

  private async endpoints(): Promise<Endpoints> {
    if (this.ep) return this.ep;
    // The clock first (no login needed), so the digest is fresh in the camera's time.
    const t = await soap(this.device, '<tds:GetSystemDateAndTime/>', null).catch(() => null);
    const utc = find(t ?? undefined, 'UTCDateTime');
    if (utc) {
      const d = Date.UTC(num(utc, 'Year')!, (num(utc, 'Month') ?? 1) - 1, num(utc, 'Day'), num(utc, 'Hour'), num(utc, 'Minute'), num(utc, 'Second'));
      if (Number.isFinite(d)) this.offset = d - Date.now();
    }
    const caps = await this.call(this.device, '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>');
    const media = text(caps, 'Media', 'XAddr');
    const ptz = text(caps, 'PTZ', 'XAddr');
    const imaging = text(caps, 'Imaging', 'XAddr');
    if (!media) throw new CameraError('The camera has no ONVIF media service');
    const profiles = await this.call(media, '<trt:GetProfiles/>');
    const all = findAll(profiles, 'Profiles');
    const p = all.find((x) => find(x, 'PTZConfiguration')) ?? all[0];
    if (!p) throw new CameraError('The camera has no media profile');
    this.ep = { media, ptz, imaging, profile: p.attrs.token ?? '', source: text(p, 'VideoSourceConfiguration', 'SourceToken') };
    return this.ep;
  }

  async identify(): Promise<Identity> {
    const ep = await this.endpoints();
    const r = await this.call(this.device, '<tds:GetDeviceInformation/>');
    let rtsp = '';
    const u = await this.call(ep.media, `<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${esc(ep.profile)}</trt:ProfileToken></trt:GetStreamUri>`).catch(() => null);
    if (u) rtsp = text(u, 'Uri');
    return { vendor: text(r, 'Manufacturer') || 'ONVIF', model: text(r, 'Model'), firmware: text(r, 'FirmwareVersion'), rtsp };
  }

  async status(): Promise<Status> {
    const ep = await this.endpoints();
    const s: Status = { power: 'on' };
    if (ep.ptz) {
      const r = await this.call(ep.ptz, `<tptz:GetStatus><tptz:ProfileToken>${esc(ep.profile)}</tptz:ProfileToken></tptz:GetStatus>`).catch(() => null);
      const pt = find(r ?? undefined, 'Position', 'PanTilt');
      if (pt) {
        s.pan = Number(pt.attrs.x);
        s.tilt = Number(pt.attrs.y);
      }
      const z = find(r ?? undefined, 'Position', 'Zoom');
      if (z) s.zoom = clamp(Number(z.attrs.x), 0, 1);
    }
    if (this.imaging) s.focusAuto = text(this.imaging, 'Focus', 'AutoFocusMode') === 'AUTO';
    return s;
  }

  private async readOptions(ep: Endpoints): Promise<void> {
    if (Object.keys(this.options).length) return;
    const o = await this.call(ep.imaging, `<timg:GetOptions><timg:VideoSourceToken>${esc(ep.source)}</timg:VideoSourceToken></timg:GetOptions>`).catch(() => null);
    if (!o) return;
    const range = (n: XmlNode | undefined): Opt | undefined => {
      const min = num(n, 'Min');
      const max = num(n, 'Max');
      return min !== undefined && max !== undefined && max > min ? { min, max } : undefined;
    };
    const set = (k: string, v: Opt | string[] | undefined) => {
      if (v && (!Array.isArray(v) || v.length)) this.options[k] = v;
    };
    set('brightness', range(child(find(o, 'ImagingOptions'), 'Brightness')));
    set('saturation', range(child(find(o, 'ImagingOptions'), 'ColorSaturation')));
    set('contrast', range(child(find(o, 'ImagingOptions'), 'Contrast')));
    set('sharpness', range(child(find(o, 'ImagingOptions'), 'Sharpness')));
    const ex = find(o, 'Exposure');
    set('exposureModes', findAll(ex, 'Mode').map((m) => m.text.trim()));
    set('gain', range(child(ex, 'Gain') ?? child(ex, 'MaxGain')));
    set('iris', range(child(ex, 'Iris') ?? child(ex, 'MaxIris')));
    set('exposureTime', range(child(ex, 'ExposureTime') ?? child(ex, 'MaxExposureTime')));
    const wb = find(o, 'WhiteBalance');
    set('wbModes', findAll(wb, 'Mode').map((m) => m.text.trim()));
    set('crGain', range(child(wb, 'YrGain')) ?? range(child(wb, 'CrGain')));
    set('cbGain', range(child(wb, 'YbGain')) ?? range(child(wb, 'CbGain')));
    set('focusModes', findAll(find(o, 'Focus'), 'AutoFocusModes').map((m) => m.text.trim()));
  }

  async picture(): Promise<Param[]> {
    const ep = await this.endpoints();
    if (!ep.imaging) return [];
    await this.readOptions(ep);
    const r = await this.call(ep.imaging, `<timg:GetImagingSettings><timg:VideoSourceToken>${esc(ep.source)}</timg:VideoSourceToken></timg:GetImagingSettings>`);
    const s = find(r, 'ImagingSettings');
    this.imaging = s ?? null;
    const out: Param[] = [];
    const range = (id: string, label: string, group: Param['group'], value: number | undefined, unit: string, enabled = true, hint?: string) => {
      const o = this.options[id];
      if (value === undefined || !o || Array.isArray(o)) return;
      const step = (o.max - o.min) / 100;
      out.push({ id, label, group, kind: 'range', value, min: o.min, max: o.max, step: step >= 1 ? Math.round(step) : Number(step.toPrecision(2)), text: `${Number(value.toFixed(2))}${unit}`, enabled, hint: enabled ? undefined : hint });
    };
    const modes = (this.options.exposureModes as string[] | undefined) ?? [];
    const exMode = text(s, 'Exposure', 'Mode');
    if (exMode && modes.length) out.push({ id: 'exposureMode', label: 'Exposure mode', group: 'exposure', kind: 'enum', value: exMode, options: modes.map((m) => ({ value: m, label: m === 'AUTO' ? 'Auto' : m === 'MANUAL' ? 'Manual' : m })), text: exMode === 'AUTO' ? 'Auto' : 'Manual' });
    const manual = exMode === 'MANUAL';
    range('iris', 'Iris', 'exposure', num(s, 'Exposure', 'Iris'), ' dB', manual, 'Set Exposure mode to Manual');
    range('gain', 'Gain', 'exposure', num(s, 'Exposure', 'Gain'), ' dB', manual, 'Set Exposure mode to Manual');
    range('exposureTime', 'Shutter (µs)', 'exposure', num(s, 'Exposure', 'ExposureTime'), ' µs', manual, 'Set Exposure mode to Manual');
    range('brightness', 'Brightness', 'exposure', num(s, 'Brightness'), '');
    const wbModes = (this.options.wbModes as string[] | undefined) ?? [];
    const wb = text(s, 'WhiteBalance', 'Mode');
    if (wb && wbModes.length) out.push({ id: 'wbMode', label: 'White balance', group: 'color', kind: 'enum', value: wb, options: wbModes.map((m) => ({ value: m, label: m === 'AUTO' ? 'Auto' : m === 'MANUAL' ? 'Manual' : m })), text: wb === 'AUTO' ? 'Auto' : 'Manual' });
    range('crGain', 'R gain (Cr)', 'color', num(s, 'WhiteBalance', 'CrGain'), '', wb === 'MANUAL', 'Set White balance to Manual');
    range('cbGain', 'B gain (Cb)', 'color', num(s, 'WhiteBalance', 'CbGain'), '', wb === 'MANUAL', 'Set White balance to Manual');
    range('saturation', 'Saturation', 'color', num(s, 'ColorSaturation'), '');
    range('contrast', 'Contrast', 'image', num(s, 'Contrast'), '');
    range('sharpness', 'Sharpness', 'image', num(s, 'Sharpness'), '');
    const af = text(s, 'Focus', 'AutoFocusMode');
    if (af) out.push({ id: 'focus', label: 'Focus', group: 'focus', kind: 'enum', value: af === 'AUTO' ? 'auto' : 'manual', options: [{ value: 'auto', label: 'Auto' }, { value: 'manual', label: 'Manual' }], text: af === 'AUTO' ? 'Auto' : 'Manual' });
    return out;
  }

  private async ptz(body: string): Promise<void> {
    const ep = await this.endpoints();
    if (!ep.ptz) throw new CameraError('The camera has no ONVIF PTZ service');
    await this.call(ep.ptz, body);
  }

  private moving = { pan: 0, tilt: 0, zoom: 0 };

  private async continuous(): Promise<void> {
    const ep = await this.endpoints();
    const { pan, tilt, zoom } = this.moving;
    if (!pan && !tilt && !zoom) {
      await this.ptz(`<tptz:Stop><tptz:ProfileToken>${esc(ep.profile)}</tptz:ProfileToken><tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom></tptz:Stop>`);
      return;
    }
    await this.ptz(
      `<tptz:ContinuousMove><tptz:ProfileToken>${esc(ep.profile)}</tptz:ProfileToken><tptz:Velocity><tt:PanTilt x="${pan.toFixed(3)}" y="${tilt.toFixed(3)}"/><tt:Zoom x="${zoom.toFixed(3)}"/></tptz:Velocity></tptz:ContinuousMove>`
    );
  }

  async move(pan: number, tilt: number): Promise<void> {
    this.moving.pan = clamp(pan, -1, 1);
    this.moving.tilt = clamp(tilt, -1, 1);
    await this.continuous();
  }

  async zoom(v: number): Promise<void> {
    this.moving.zoom = clamp(v, -1, 1);
    await this.continuous();
  }

  async focus(v: number): Promise<void> {
    const ep = await this.endpoints();
    if (!ep.imaging) throw new CameraError('The camera has no ONVIF imaging service');
    if (v === 0) await this.call(ep.imaging, `<timg:Stop><timg:VideoSourceToken>${esc(ep.source)}</timg:VideoSourceToken></timg:Stop>`);
    else await this.call(ep.imaging, `<timg:Move><timg:VideoSourceToken>${esc(ep.source)}</timg:VideoSourceToken><timg:Focus><tt:Continuous><tt:Speed>${(-v).toFixed(3)}</tt:Speed></tt:Continuous></timg:Focus></timg:Move>`);
  }

  async home(): Promise<void> {
    const ep = await this.endpoints();
    await this.ptz(`<tptz:GotoHomePosition><tptz:ProfileToken>${esc(ep.profile)}</tptz:ProfileToken></tptz:GotoHomePosition>`);
  }

  private async presetList(): Promise<{ token: string; name: string }[]> {
    if (this.presets) return this.presets;
    const ep = await this.endpoints();
    const r = await this.call(ep.ptz, `<tptz:GetPresets><tptz:ProfileToken>${esc(ep.profile)}</tptz:ProfileToken></tptz:GetPresets>`);
    this.presets = findAll(r, 'Preset').map((p) => ({ token: p.attrs.token ?? '', name: text(p, 'Name') }));
    return this.presets;
  }

  /** Preset n is the camera's preset named or tokened n, else its nth. */
  private async presetToken(n: number): Promise<string | undefined> {
    const list = await this.presetList();
    return (list.find((p) => p.name === String(n) || p.token === String(n)) ?? list[n - 1])?.token;
  }

  async recall(n: number): Promise<void> {
    const ep = await this.endpoints();
    const token = await this.presetToken(n);
    if (!token) throw new CameraError(`The camera has no preset ${n}`);
    await this.ptz(`<tptz:GotoPreset><tptz:ProfileToken>${esc(ep.profile)}</tptz:ProfileToken><tptz:PresetToken>${esc(token)}</tptz:PresetToken></tptz:GotoPreset>`);
  }

  async store(n: number): Promise<void> {
    const ep = await this.endpoints();
    const token = await this.presetToken(n).catch(() => undefined);
    await this.ptz(`<tptz:SetPreset><tptz:ProfileToken>${esc(ep.profile)}</tptz:ProfileToken><tptz:PresetName>${n}</tptz:PresetName>${token ? `<tptz:PresetToken>${esc(token)}</tptz:PresetToken>` : ''}</tptz:SetPreset>`);
    this.presets = null;
  }

  async set(id: string, value: number | string): Promise<void> {
    const ep = await this.endpoints();
    if (!ep.imaging) throw new CameraError('The camera has no ONVIF imaging service');
    const n = Number(value);
    const o = this.options[id];
    const v = o && !Array.isArray(o) ? clamp(n, o.min, o.max) : n;
    const word = (x: string | number) => esc(String(x));
    let body: string;
    switch (id) {
      case 'brightness':
        body = `<tt:Brightness>${v}</tt:Brightness>`;
        break;
      case 'saturation':
        body = `<tt:ColorSaturation>${v}</tt:ColorSaturation>`;
        break;
      case 'contrast':
        body = `<tt:Contrast>${v}</tt:Contrast>`;
        break;
      case 'sharpness':
        body = `<tt:Sharpness>${v}</tt:Sharpness>`;
        break;
      case 'exposureMode':
        if (value !== 'AUTO' && value !== 'MANUAL') throw new CameraError('Unknown exposure mode');
        body = `<tt:Exposure><tt:Mode>${value}</tt:Mode></tt:Exposure>`;
        break;
      case 'iris':
      case 'gain':
        body = `<tt:Exposure><tt:Mode>MANUAL</tt:Mode><tt:${id === 'iris' ? 'Iris' : 'Gain'}>${v}</tt:${id === 'iris' ? 'Iris' : 'Gain'}></tt:Exposure>`;
        break;
      case 'exposureTime':
        body = `<tt:Exposure><tt:Mode>MANUAL</tt:Mode><tt:ExposureTime>${v}</tt:ExposureTime></tt:Exposure>`;
        break;
      case 'wbMode':
        if (value !== 'AUTO' && value !== 'MANUAL') throw new CameraError('Unknown white balance mode');
        body = `<tt:WhiteBalance><tt:Mode>${value}</tt:Mode></tt:WhiteBalance>`;
        break;
      case 'crGain':
      case 'cbGain': {
        const cr = id === 'crGain' ? v : num(this.imaging ?? undefined, 'WhiteBalance', 'CrGain') ?? 0;
        const cb = id === 'cbGain' ? v : num(this.imaging ?? undefined, 'WhiteBalance', 'CbGain') ?? 0;
        body = `<tt:WhiteBalance><tt:Mode>MANUAL</tt:Mode><tt:CrGain>${cr}</tt:CrGain><tt:CbGain>${cb}</tt:CbGain></tt:WhiteBalance>`;
        break;
      }
      case 'focus':
        body = `<tt:Focus><tt:AutoFocusMode>${value === 'auto' ? 'AUTO' : 'MANUAL'}</tt:AutoFocusMode></tt:Focus>`;
        break;
      default:
        throw new CameraError(`This camera has no setting "${word(id)}"`);
    }
    await this.call(ep.imaging, `<timg:SetImagingSettings><timg:VideoSourceToken>${esc(ep.source)}</timg:VideoSourceToken><timg:ImagingSettings>${body}</timg:ImagingSettings><timg:ForcePersistence>false</timg:ForcePersistence></timg:SetImagingSettings>`);
  }

  close(): void {
    this.closed = true;
  }
}
