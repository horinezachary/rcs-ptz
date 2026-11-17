import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { decode, encode } from '../src/rtmp/amf.js';
import { parseRtmpUrl } from '../src/rtmp/conn.js';
import { find, findAll, parseXml, text } from '../src/onvif/xml.js';
import { duration } from '../src/bridge/onvif.js';
import { parseSonyReply, targets } from '../src/discovery.js';
import { FlvReader, avcSize } from '../src/video/flv.js';

describe('pieces', () => {
  it('keeps the panel and web video players the same file', () => {
    expect(fs.readFileSync('web/video.js', 'utf8')).toBe(fs.readFileSync('ui/video.js', 'utf8'));
  });

  it('round-trips AMF0', () => {
    const v = ['connect', 1, { app: 'live', ok: true, n: null, list: [1, 'a'] }];
    expect(decode(encode(...(v as any)))).toEqual(v);
  });

  it('parses RTMP URLs', () => {
    expect(parseRtmpUrl('rtmp://10.0.0.5/live/cam1')).toMatchObject({ host: '10.0.0.5', port: 1935, app: 'live', stream: 'cam1' });
    expect(parseRtmpUrl('rtmp://h:1940/app/inst/key?x=1')).toMatchObject({ port: 1940, app: 'app/inst', stream: 'key?x=1', tcUrl: 'rtmp://h:1940/app/inst' });
    expect(parseRtmpUrl('rtmp://h/onlyapp')).toBeNull();
    expect(parseRtmpUrl('http://h/live/a')).toBeNull();
  });

  it('reads SOAP with namespaces stripped and refuses DTDs', () => {
    const x = parseXml('<?xml version="1.0"?><s:Envelope xmlns:s="x"><s:Body><t:P token="a"><t:Name>One &amp; two</t:Name></t:P><t:P token="b"/></s:Body></s:Envelope>');
    expect(text(find(x, 'Body', 'P', 'Name'))).toBe('One & two');
    expect(findAll(x, 'P').map((p) => p.attrs.token)).toEqual(['a', 'b']);
    expect(() => parseXml('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>')).toThrow();
  });

  it('reads ONVIF timeouts', () => {
    expect(duration('PT5S')).toBe(5000);
    expect(duration('PT1M0.5S')).toBe(60500);
    expect(duration('PT')).toBeUndefined();
    expect(duration('soon')).toBeUndefined();
  });

  it('reads Sony discovery replies and scan targets', () => {
    const r = parseSonyReply(Buffer.from('\x02MAC:00-11\xffMODEL:SRG-X400\xffIPADR:10.0.0.9\xff\x03', 'latin1'));
    expect(r).toMatchObject({ MODEL: 'SRG-X400', IPADR: '10.0.0.9' });
    expect(targets('10.0.0.9')).toEqual(['10.0.0.9']);
    expect(targets('10.0.0.0/30')).toEqual(['10.0.0.1', '10.0.0.2']);
  });

  it('reads the picture size from the simulator video', () => {
    let size: { width: number; height: number } | null = null;
    let frames = 0;
    new FlvReader((c) => (size ??= avcSize(c.avcC)), () => frames++).push(fs.readFileSync('sim/cam.flv'));
    expect(size).toEqual({ width: 640, height: 360 });
    expect(frames).toBeGreaterThan(100);
  });
});

describe('module.json', () => {
  it('fits the host manifest rules the dev panel checks', () => {
    const m = JSON.parse(fs.readFileSync('module.json', 'utf8'));
    expect(m.id).toBe('ptz');
    expect(m.description.length).toBeLessThanOrEqual(80);
    expect(m.name.length).toBeLessThanOrEqual(40);
  });
});

describe('camera CGI values', () => {
  it('sends an RTMP address as typed (cameras store percent-escapes literally), escaping only what breaks a query', async () => {
    const { q } = await import('../src/cameras/rtmp-setup.js');
    expect(q('rtmp://10.0.3.117:1935/live')).toBe('rtmp://10.0.3.117:1935/live');
    expect(q('rtmp://h/live/ab12_cd-3')).toBe('rtmp://h/live/ab12_cd-3');
    expect(q('a&b c#d')).toBe('a%26b%20c%23d');
  });
});
