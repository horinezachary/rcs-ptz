// SOAP 1.2 over HTTP for ONVIF, both ends: envelopes, WS-Security UsernameToken (PasswordDigest), faults.

import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { esc, find, parseXml, text, type XmlNode } from './xml.js';

export const NS = {
  s: 'http://www.w3.org/2003/05/soap-envelope',
  tds: 'http://www.onvif.org/ver10/device/wsdl',
  trt: 'http://www.onvif.org/ver10/media/wsdl',
  tptz: 'http://www.onvif.org/ver20/ptz/wsdl',
  timg: 'http://www.onvif.org/ver20/imaging/wsdl',
  tt: 'http://www.onvif.org/ver10/schema',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  ter: 'http://www.onvif.org/ver10/error'
};

const XMLNS = Object.entries(NS)
  .map(([k, v]) => `xmlns:${k}="${v}"`)
  .join(' ');

export function envelope(body: string, header = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope ${XMLNS}>${header ? `<s:Header>${header}</s:Header>` : ''}<s:Body>${body}</s:Body></s:Envelope>`;
}

export function digest(nonce: Buffer, created: string, password: string): string {
  return createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created + password, 'utf8')])).digest('base64');
}

export function security(user: string, password: string, offsetMs = 0): string {
  const nonce = randomBytes(16);
  const created = new Date(Date.now() + offsetMs).toISOString().replace(/\.\d+Z$/, 'Z');
  return (
    `<wsse:Security s:mustUnderstand="1"><wsse:UsernameToken><wsse:Username>${esc(user)}</wsse:Username>` +
    `<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest(nonce, created, password)}</wsse:Password>` +
    `<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</wsse:Nonce>` +
    `<wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security>`
  );
}

/** Checks a request's UsernameToken. Digest or plain text; Created within 5 minutes when digested. */
export function checkSecurity(env: XmlNode, user: string, password: string): boolean {
  const tok = find(env, 'Header', 'UsernameToken');
  if (!tok) return false;
  if (text(tok, 'Username') !== user) return false;
  const pw = find(tok, 'Password');
  const given = (pw?.text ?? '').trim();
  if (!pw || !/Digest$/.test(pw.attrs.Type ?? '')) return given === password;
  const nonce = Buffer.from(text(tok, 'Nonce'), 'base64');
  const created = text(tok, 'Created');
  const t = Date.parse(created);
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > 5 * 60_000) return false;
  return given === digest(nonce, created, password);
}

export function fault(code: string, sub: string, reason: string): string {
  return envelope(
    `<s:Fault><s:Code><s:Value>s:${code}</s:Value><s:Subcode><s:Value>${sub}</s:Value></s:Subcode></s:Code><s:Reason><s:Text xml:lang="en">${esc(reason)}</s:Text></s:Reason></s:Fault>`
  );
}

export class SoapError extends Error {
  constructor(
    message: string,
    readonly auth = false
  ) {
    super(message);
  }
}

export interface SoapAuth {
  user: string;
  password: string;
}

/** Posts one SOAP request; resolves to the Body element, or throws SoapError with the fault's reason. */
export function soap(url: string, body: string, auth: SoapAuth | null, timeoutMs = 4000, offsetMs = 0): Promise<XmlNode> {
  const data = envelope(body, auth?.user ? security(auth.user, auth.password, offsetMs) : '');
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(data) }, timeout: timeoutMs },
      (res) => {
        const parts: Buffer[] = [];
        let n = 0;
        res.on('data', (d: Buffer) => {
          n += d.length;
          if (n > 2_000_000) req.destroy(new Error('Reply too large'));
          else parts.push(d);
        });
        res.on('end', () => {
          const s = Buffer.concat(parts).toString('utf8');
          if (res.statusCode === 401) return reject(new SoapError('The camera wants a user name and password', true));
          let doc: XmlNode;
          try {
            doc = parseXml(s);
          } catch {
            return reject(new SoapError(`HTTP ${res.statusCode}: not a SOAP reply`));
          }
          const f = find(doc, 'Fault');
          if (f) {
            const reason = text(f, 'Reason', 'Text') || text(f, 'faultstring') || 'SOAP fault';
            const sub = text(f, 'Subcode', 'Value');
            return reject(new SoapError(reason, /NotAuthorized|FailedAuthentication/i.test(sub + reason)));
          }
          const b = find(doc, 'Body');
          if (!b) return reject(new SoapError('No SOAP body'));
          resolve(b);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('No answer')));
    req.on('error', (e: NodeJS.ErrnoException) => reject(new SoapError(e.code === 'ECONNREFUSED' ? 'Connection refused' : e.message)));
    req.end(data);
  });
}
