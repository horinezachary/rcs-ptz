// The bridge's ONVIF side: every camera in the module appears as its own ONVIF camera (Profile S), on its own
// port (base port + its place in the list), found by WS-Discovery. Its stream is the bridge's RTSP; its PTZ
// service turns ONVIF ContinuousMove, Stop, presets and home into whatever the real camera speaks (VISCA,
// Panasonic or ONVIF). Moves go through the module, so they obey Allow controls like the keys do.

import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { checkSecurity, envelope, fault } from '../onvif/soap.js';
import { esc, find, findAll, parseXml, text, type XmlNode } from '../onvif/xml.js';

export interface BridgeCamera {
  id: string;
  name: string;
  width: number;
  height: number;
  presets: { n: number; name: string }[];
  /** Pan/tilt and zoom as 0..1 fractions, when the camera reports them. */
  position(): { pan?: number; tilt?: number; zoom?: number; moving: boolean };
}

export type BridgeAction =
  | { action: 'move'; pan: number; tilt: number; zoom: number; timeoutMs: number }
  | { action: 'stop'; panTilt: boolean; zoom: boolean }
  | { action: 'recall'; n: number }
  | { action: 'store'; n: number }
  | { action: 'home' };

export interface BridgeHandlers {
  cameras(): BridgeCamera[];
  /** Resolves '' when done, or why not (Allow controls off, the camera didn't answer). */
  control(cam: string, a: BridgeAction): Promise<string>;
  auth(): { user: string; password: string } | null;
  rtspPort(): number;
  version: string;
}

const WSD_ADDR = '239.255.255.250';
const WSD_PORT = 3702;
/** A ContinuousMove without a Timeout stops on its own after this long, in case the client never sends Stop. */
export const MAX_MOVE_MS = 15_000;

const uuidOf = (id: string) => {
  const h = createHash('sha1').update('rcs-ptz:' + id).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** ISO 8601 duration ("PT5S", "PT0.5S", "PT1M") in ms. */
export function duration(s: string): number | undefined {
  const m = /^P(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s.trim());
  if (!m || s.trim() === 'P' || s.trim() === 'PT') return undefined;
  return Math.round((Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000);
}

/** The unit's address on the same network as `remote`, or its first. */
export function localFor(remote: string): string {
  const r = remote.replace(/^::ffff:/, '').split('.').map(Number);
  let first = '';
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      first ||= a.address;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      if (r.length === 4 && ip.every((x, i) => (x & mask[i]!) === (r[i]! & mask[i]!))) return a.address;
    }
  }
  return first || '127.0.0.1';
}

export class OnvifBridge extends EventEmitter {
  private servers = new Map<string, { server: http.Server; port: number }>();
  private wsd: dgram.Socket | null = null;
  basePort = 0;
  errors: string[] = [];

  constructor(private readonly h: BridgeHandlers) {
    super();
  }

  /** Brings the per-camera servers in line with the camera list. Camera i is on basePort + i. */
  async sync(basePort: number, discovery = true): Promise<void> {
    this.basePort = basePort;
    const cams = this.h.cameras();
    const want = new Map(cams.map((c, i) => [c.id, basePort ? basePort + i : 0]));
    for (const [id, s] of this.servers) {
      const p = want.get(id);
      if (p === undefined || (p !== 0 && p !== s.port)) {
        await new Promise<void>((r) => s.server.close(() => r()));
        s.server.closeAllConnections?.();
        this.servers.delete(id);
      }
    }
    this.errors = [];
    for (const c of cams) {
      if (this.servers.has(c.id)) continue;
      const server = http.createServer((req, res) => void this.serve(c.id, req, res));
      const port = want.get(c.id)!;
      const ok = await new Promise<boolean>((resolve) => {
        server.once('error', (e: NodeJS.ErrnoException) => {
          this.errors.push(`${c.name}: port ${port} ${e.code === 'EADDRINUSE' ? 'is in use' : e.message}`);
          resolve(false);
        });
        server.listen(port, () => resolve(true));
      });
      if (ok) this.servers.set(c.id, { server, port: (server.address() as AddressInfo).port });
    }
    if (discovery && !this.wsd) this.startDiscovery();
    if (!discovery && this.wsd) this.stopDiscovery();
    this.hello();
  }

  portOf(id: string): number {
    return this.servers.get(id)?.port ?? 0;
  }

  async close(): Promise<void> {
    this.bye();
    this.stopDiscovery();
    for (const s of this.servers.values()) {
      await new Promise<void>((r) => s.server.close(() => r()));
      s.server.closeAllConnections?.();
    }
    this.servers.clear();
  }

  // ---- WS-Discovery ----------------------------------------------------------------------------

  private startDiscovery(): void {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', (e) => {
      this.errors.push(`Discovery: ${e.message}`);
      this.stopDiscovery();
    });
    s.on('message', (m, r) => this.onProbe(m, r));
    s.bind(WSD_PORT, () => {
      try {
        s.addMembership(WSD_ADDR);
      } catch {}
    });
    this.wsd = s;
  }

  private stopDiscovery(): void {
    try {
      this.wsd?.close();
    } catch {}
    this.wsd = null;
  }

  private matchXml(id: string, local: string): string {
    const c = this.h.cameras().find((x) => x.id === id);
    const port = this.portOf(id);
    if (!c || !port) return '';
    return (
      `<d:EndpointReference><a:Address>urn:uuid:${uuidOf(id)}</a:Address></d:EndpointReference><d:Types>dn:NetworkVideoTransmitter tds:Device</d:Types>` +
      `<d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/type/ptz onvif://www.onvif.org/Profile/Streaming onvif://www.onvif.org/name/${encodeURIComponent(c.name.replace(/ /g, '_'))} onvif://www.onvif.org/hardware/RCS_PTZ_Bridge</d:Scopes>` +
      `<d:XAddrs>http://${local}:${port}/onvif/device_service</d:XAddrs><d:MetadataVersion>1</d:MetadataVersion>`
    );
  }

  private wsdEnvelope(action: string, relates: string, body: string): string {
    return (
      `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">` +
      `<s:Header><a:MessageID>urn:uuid:${uuidOf(String(Math.random()))}</a:MessageID>${relates ? `<a:RelatesTo>${esc(relates)}</a:RelatesTo>` : ''}<a:To>${relates ? 'http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous' : 'urn:schemas-xmlsoap-org:ws:2005:04:discovery'}</a:To><a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/${action}</a:Action></s:Header>` +
      `<s:Body>${body}</s:Body></s:Envelope>`
    );
  }

  private onProbe(m: Buffer, r: dgram.RemoteInfo): void {
    let doc: XmlNode;
    try {
      doc = parseXml(m.toString('utf8'));
    } catch {
      return;
    }
    if (!find(doc, 'Probe')) return;
    const types = text(doc, 'Probe', 'Types');
    if (types && !/NetworkVideoTransmitter|Device/.test(types)) return;
    const relates = text(doc, 'MessageID');
    const local = localFor(r.address);
    for (const c of this.h.cameras()) {
      const match = this.matchXml(c.id, local);
      if (!match) continue;
      const reply = this.wsdEnvelope('ProbeMatches', relates, `<d:ProbeMatches><d:ProbeMatch>${match}</d:ProbeMatch></d:ProbeMatches>`);
      this.wsd?.send(reply, r.port, r.address, () => {});
    }
  }

  private hello(): void {
    if (!this.wsd) return;
    const local = localFor('');
    for (const c of this.h.cameras()) {
      const match = this.matchXml(c.id, local);
      if (match) this.wsd.send(this.wsdEnvelope('Hello', '', `<d:Hello>${match}</d:Hello>`), WSD_PORT, WSD_ADDR, () => {});
    }
  }

  private bye(): void {
    if (!this.wsd) return;
    for (const c of this.h.cameras()) {
      if (!this.portOf(c.id)) continue;
      this.wsd.send(this.wsdEnvelope('Bye', '', `<d:Bye><d:EndpointReference><a:Address>urn:uuid:${uuidOf(c.id)}</a:Address></d:EndpointReference></d:Bye>`), WSD_PORT, WSD_ADDR, () => {});
    }
  }

  // ---- SOAP ----------------------------------------------------------------------------------------

  private async serve(id: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, xml: string) => {
      res.writeHead(status, { 'Content-Type': 'application/soap+xml; charset=utf-8' });
      res.end(xml);
    };
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return void res.end();
    }
    const parts: Buffer[] = [];
    let n = 0;
    for await (const d of req) {
      n += (d as Buffer).length;
      if (n > 256_000) return send(413, fault('Sender', 'ter:InvalidArgVal', 'Request too large'));
      parts.push(d as Buffer);
    }
    let doc: XmlNode;
    try {
      doc = parseXml(Buffer.concat(parts).toString('utf8'));
    } catch {
      return send(400, fault('Sender', 'ter:WellFormed', 'Not well-formed XML'));
    }
    const body = find(doc, 'Body');
    const op = body?.children[0];
    if (!op) return send(400, fault('Sender', 'ter:InvalidArgVal', 'Empty body'));
    const cam = this.h.cameras().find((c) => c.id === id);
    if (!cam) return send(400, fault('Receiver', 'ter:ActionNotSupported', 'This camera has been removed'));
    const auth = this.h.auth();
    const open = op.name === 'GetSystemDateAndTime' || op.name === 'GetServices' || op.name === 'GetCapabilities' || op.name === 'GetServiceCapabilities';
    if (auth?.user && !open && !checkSecurity(doc, auth.user, auth.password)) return send(400, fault('Sender', 'ter:NotAuthorized', 'Sender not authorized'));
    const local = (req.socket.localAddress ?? '127.0.0.1').replace(/^::ffff:/, '');
    const host = req.headers.host?.replace(/:\d+$/, '') || local;
    const base = `http://${host}:${this.portOf(id)}/onvif`;
    try {
      const out = await this.operation(cam, op, base, host);
      if (out === null) return send(400, fault('Receiver', 'ter:ActionNotSupported', `${op.name} is not supported by this bridge`));
      send(200, envelope(out));
    } catch (e) {
      send(500, fault('Receiver', 'ter:Action', (e as Error).message));
    }
  }

  private async operation(cam: BridgeCamera, op: XmlNode, base: string, host: string): Promise<string | null> {
    const profile = `<trt:Profiles token="profile_1" fixed="true"><tt:Name>${esc(cam.name)}</tt:Name>${this.vsc(cam)}${this.vec(cam)}${this.ptzConf()}</trt:Profiles>`;
    const control = async (a: BridgeAction) => {
      const why = await this.h.control(cam.id, a);
      if (why) throw new Error(why);
    };
    switch (op.name) {
      // device
      case 'GetSystemDateAndTime': {
        const d = new Date();
        return `<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>NTP</tt:DateTimeType><tt:DaylightSavings>false</tt:DaylightSavings><tt:TimeZone><tt:TZ>UTC0</tt:TZ></tt:TimeZone><tt:UTCDateTime><tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`;
      }
      case 'GetDeviceInformation':
        return `<tds:GetDeviceInformationResponse><tds:Manufacturer>Rack Control Surface</tds:Manufacturer><tds:Model>${esc(cam.name)} (PTZ bridge)</tds:Model><tds:FirmwareVersion>${esc(this.h.version)}</tds:FirmwareVersion><tds:SerialNumber>${esc(cam.id)}</tds:SerialNumber><tds:HardwareId>rcs-ptz</tds:HardwareId></tds:GetDeviceInformationResponse>`;
      case 'GetCapabilities':
        return `<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Device><tt:XAddr>${base}/device_service</tt:XAddr></tt:Device><tt:Media><tt:XAddr>${base}/media_service</tt:XAddr><tt:StreamingCapabilities><tt:RTPMulticast>false</tt:RTPMulticast><tt:RTP_TCP>true</tt:RTP_TCP><tt:RTP_RTSP_TCP>true</tt:RTP_RTSP_TCP></tt:StreamingCapabilities></tt:Media><tt:PTZ><tt:XAddr>${base}/ptz_service</tt:XAddr></tt:PTZ></tds:Capabilities></tds:GetCapabilitiesResponse>`;
      case 'GetServices': {
        const svc = (ns: string, path: string) => `<tds:Service><tds:Namespace>${ns}</tds:Namespace><tds:XAddr>${base}/${path}</tds:XAddr><tds:Version><tt:Major>2</tt:Major><tt:Minor>60</tt:Minor></tds:Version></tds:Service>`;
        return `<tds:GetServicesResponse>${svc('http://www.onvif.org/ver10/device/wsdl', 'device_service')}${svc('http://www.onvif.org/ver10/media/wsdl', 'media_service')}${svc('http://www.onvif.org/ver20/ptz/wsdl', 'ptz_service')}</tds:GetServicesResponse>`;
      }
      case 'GetServiceCapabilities':
        return `<${'tds'}:GetServiceCapabilitiesResponse><tds:Capabilities/></tds:GetServiceCapabilitiesResponse>`;
      case 'GetScopes':
        return `<tds:GetScopesResponse>${['type/video_encoder', 'type/ptz', 'Profile/Streaming', `name/${encodeURIComponent(cam.name.replace(/ /g, '_'))}`, 'hardware/RCS_PTZ_Bridge'].map((s) => `<tds:Scopes><tt:ScopeDef>Fixed</tt:ScopeDef><tt:ScopeItem>onvif://www.onvif.org/${s}</tt:ScopeItem></tds:Scopes>`).join('')}</tds:GetScopesResponse>`;
      case 'GetHostname':
        return `<tds:GetHostnameResponse><tds:HostnameInformation><tt:FromDHCP>false</tt:FromDHCP><tt:Name>${esc(os.hostname())}</tt:Name></tds:HostnameInformation></tds:GetHostnameResponse>`;
      case 'GetNetworkInterfaces':
        return `<tds:GetNetworkInterfacesResponse><tds:NetworkInterfaces token="eth0"><tt:Enabled>true</tt:Enabled><tt:IPv4><tt:Enabled>true</tt:Enabled><tt:Config><tt:Manual><tt:Address>${esc(host)}</tt:Address><tt:PrefixLength>24</tt:PrefixLength></tt:Manual><tt:DHCP>false</tt:DHCP></tt:Config></tt:IPv4></tds:NetworkInterfaces></tds:GetNetworkInterfacesResponse>`;
      // media
      case 'GetProfiles':
        return `<trt:GetProfilesResponse>${profile}</trt:GetProfilesResponse>`;
      case 'GetProfile':
        return `<trt:GetProfileResponse>${profile.replace(/^<trt:Profiles/, '<trt:Profile').replace(/<\/trt:Profiles>$/, '</trt:Profile>')}</trt:GetProfileResponse>`;
      case 'GetVideoSources':
        return `<trt:GetVideoSourcesResponse><trt:VideoSources token="source_1"><tt:Framerate>30</tt:Framerate><tt:Resolution><tt:Width>${cam.width}</tt:Width><tt:Height>${cam.height}</tt:Height></tt:Resolution></trt:VideoSources></trt:GetVideoSourcesResponse>`;
      case 'GetVideoSourceConfigurations':
        return `<trt:GetVideoSourceConfigurationsResponse>${this.vsc(cam).replace(/tt:VideoSourceConfiguration|trt:VideoSourceConfiguration/g, 'trt:Configurations')}</trt:GetVideoSourceConfigurationsResponse>`;
      case 'GetVideoEncoderConfigurations':
        return `<trt:GetVideoEncoderConfigurationsResponse>${this.vec(cam).replace(/tt:VideoEncoderConfiguration|trt:VideoEncoderConfiguration/g, 'trt:Configurations')}</trt:GetVideoEncoderConfigurationsResponse>`;
      case 'GetStreamUri':
        return `<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://${host}:${this.h.rtspPort()}/${esc(cam.id)}</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect><tt:InvalidAfterReboot>false</tt:InvalidAfterReboot><tt:Timeout>PT0S</tt:Timeout></trt:MediaUri></trt:GetStreamUriResponse>`;
      // ptz
      case 'GetNodes':
      case 'GetNode': {
        const node = `<tt:Name>PTZ</tt:Name><tt:SupportedPTZSpaces><tt:ContinuousPanTiltVelocitySpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace</tt:URI><tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange><tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange></tt:ContinuousPanTiltVelocitySpace><tt:ContinuousZoomVelocitySpace><tt:URI>http://www.onvif.org/ver10/tptz/ZoomSpaces/VelocityGenericSpace</tt:URI><tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange></tt:ContinuousZoomVelocitySpace></tt:SupportedPTZSpaces><tt:MaximumNumberOfPresets>16</tt:MaximumNumberOfPresets><tt:HomeSupported>true</tt:HomeSupported>`;
        return op.name === 'GetNodes' ? `<tptz:GetNodesResponse><tptz:PTZNode token="ptz_node" FixedHomePosition="true">${node}</tptz:PTZNode></tptz:GetNodesResponse>` : `<tptz:GetNodeResponse><tptz:PTZNode token="ptz_node" FixedHomePosition="true">${node}</tptz:PTZNode></tptz:GetNodeResponse>`;
      }
      case 'GetConfigurations':
        return `<tptz:GetConfigurationsResponse>${this.ptzConf().replace(/trt:PTZConfiguration/g, 'tptz:PTZConfiguration')}</tptz:GetConfigurationsResponse>`;
      case 'GetConfiguration':
        return `<tptz:GetConfigurationResponse>${this.ptzConf().replace(/trt:PTZConfiguration/g, 'tptz:PTZConfiguration')}</tptz:GetConfigurationResponse>`;
      case 'GetConfigurationOptions':
        return `<tptz:GetConfigurationOptionsResponse><tptz:PTZConfigurationOptions><tt:Spaces><tt:ContinuousPanTiltVelocitySpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace</tt:URI><tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange><tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange></tt:ContinuousPanTiltVelocitySpace><tt:ContinuousZoomVelocitySpace><tt:URI>http://www.onvif.org/ver10/tptz/ZoomSpaces/VelocityGenericSpace</tt:URI><tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange></tt:ContinuousZoomVelocitySpace></tt:Spaces><tt:PTZTimeout><tt:Min>PT1S</tt:Min><tt:Max>PT15S</tt:Max></tt:PTZTimeout></tptz:PTZConfigurationOptions></tptz:GetConfigurationOptionsResponse>`;
      case 'ContinuousMove': {
        const v = find(op, 'Velocity');
        const pt = find(v, 'PanTilt');
        const z = find(v, 'Zoom');
        const t = duration(text(op, 'Timeout'));
        await control({ action: 'move', pan: Number(pt?.attrs.x ?? 0) || 0, tilt: Number(pt?.attrs.y ?? 0) || 0, zoom: Number(z?.attrs.x ?? 0) || 0, timeoutMs: Math.min(t || MAX_MOVE_MS, MAX_MOVE_MS) });
        return '<tptz:ContinuousMoveResponse/>';
      }
      case 'Stop': {
        const pt = text(op, 'PanTilt');
        const z = text(op, 'Zoom');
        await control({ action: 'stop', panTilt: pt !== 'false', zoom: z !== 'false' });
        return '<tptz:StopResponse/>';
      }
      case 'GetPresets':
        return `<tptz:GetPresetsResponse>${cam.presets.map((p) => `<tptz:Preset token="${p.n}"><tt:Name>${esc(p.name || `Preset ${p.n}`)}</tt:Name></tptz:Preset>`).join('')}</tptz:GetPresetsResponse>`;
      case 'GotoPreset': {
        const n = Number(text(op, 'PresetToken'));
        if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error('No such preset');
        await control({ action: 'recall', n });
        return '<tptz:GotoPresetResponse/>';
      }
      case 'SetPreset': {
        const tok = text(op, 'PresetToken');
        let n = Number(tok);
        if (!tok) {
          const name = text(op, 'PresetName');
          n = Number(name) || cam.presets.find((p) => p.name === name)?.n || 0;
        }
        if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error('Give a preset token 1 to 16');
        await control({ action: 'store', n });
        return `<tptz:SetPresetResponse><tptz:PresetToken>${n}</tptz:PresetToken></tptz:SetPresetResponse>`;
      }
      case 'GotoHomePosition':
        await control({ action: 'home' });
        return '<tptz:GotoHomePositionResponse/>';
      case 'GetStatus': {
        const p = cam.position();
        const pos =
          p.pan !== undefined || p.zoom !== undefined
            ? `<tt:Position>${p.pan !== undefined ? `<tt:PanTilt x="${p.pan.toFixed(4)}" y="${(p.tilt ?? 0).toFixed(4)}" space="http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace"/>` : ''}${p.zoom !== undefined ? `<tt:Zoom x="${p.zoom.toFixed(4)}" space="http://www.onvif.org/ver10/tptz/ZoomSpaces/PositionGenericSpace"/>` : ''}</tt:Position>`
            : '';
        const mv = p.moving ? 'MOVING' : 'IDLE';
        return `<tptz:GetStatusResponse><tptz:PTZStatus>${pos}<tt:MoveStatus><tt:PanTilt>${mv}</tt:PanTilt><tt:Zoom>${mv}</tt:Zoom></tt:MoveStatus><tt:UtcTime>${new Date().toISOString()}</tt:UtcTime></tptz:PTZStatus></tptz:GetStatusResponse>`;
      }
      default:
        return null;
    }
  }

  private vsc(cam: BridgeCamera): string {
    return `<tt:VideoSourceConfiguration token="vsc_1"><tt:Name>Source</tt:Name><tt:UseCount>1</tt:UseCount><tt:SourceToken>source_1</tt:SourceToken><tt:Bounds x="0" y="0" width="${cam.width}" height="${cam.height}"/></tt:VideoSourceConfiguration>`;
  }

  private vec(cam: BridgeCamera): string {
    return `<tt:VideoEncoderConfiguration token="vec_1"><tt:Name>H264</tt:Name><tt:UseCount>1</tt:UseCount><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>${cam.width}</tt:Width><tt:Height>${cam.height}</tt:Height></tt:Resolution><tt:Quality>5</tt:Quality><tt:RateControl><tt:FrameRateLimit>30</tt:FrameRateLimit><tt:EncodingInterval>1</tt:EncodingInterval><tt:BitrateLimit>8000</tt:BitrateLimit></tt:RateControl><tt:H264><tt:GovLength>30</tt:GovLength><tt:H264Profile>High</tt:H264Profile></tt:H264><tt:SessionTimeout>PT60S</tt:SessionTimeout></tt:VideoEncoderConfiguration>`;
  }

  private ptzConf(): string {
    return `<trt:PTZConfiguration token="ptz_1"><tt:Name>PTZ</tt:Name><tt:UseCount>1</tt:UseCount><tt:NodeToken>ptz_node</tt:NodeToken><tt:DefaultContinuousPanTiltVelocitySpace>http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace</tt:DefaultContinuousPanTiltVelocitySpace><tt:DefaultContinuousZoomVelocitySpace>http://www.onvif.org/ver10/tptz/ZoomSpaces/VelocityGenericSpace</tt:DefaultContinuousZoomVelocitySpace><tt:DefaultPTZTimeout>PT5S</tt:DefaultPTZTimeout></trt:PTZConfiguration>`;
  }
}

