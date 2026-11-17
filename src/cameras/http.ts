// A small HTTP client for cameras' web APIs, with HTTP Basic and Digest (RFC 2617 / 7616, MD5, qop=auth)
// logins: Sony and PTZOptics use Digest, Panasonic Basic. The first request goes without a login; a 401 with a
// challenge is answered once.

import crypto from 'node:crypto';
import http from 'node:http';
import type { Credentials } from './types.js';

const TIMEOUT_MS = 4000;
const MAX_BODY = 256 * 1024;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status = 0
  ) {
    super(message);
  }
}

export interface HttpReply {
  status: number;
  body: string;
}

function once(method: string, host: string, port: number, path: string, auth: string | undefined): Promise<HttpReply & { challenge: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (auth) headers.Authorization = auth;
    if (method !== 'GET') headers['Content-Length'] = '0';
    const req = http.request({ host, port, path, method, timeout: TIMEOUT_MS, headers }, (res) => {
      const parts: Buffer[] = [];
      let size = 0;
      res.on('data', (d: Buffer) => {
        size += d.length;
        if (size > MAX_BODY) return req.destroy(new HttpError('Reply too large'));
        parts.push(d);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8'), challenge: String(res.headers['www-authenticate'] ?? '') }));
    });
    req.on('timeout', () => req.destroy(new HttpError('No answer')));
    req.on('error', (e: NodeJS.ErrnoException) => reject(e instanceof HttpError ? e : new HttpError(e.code === 'ECONNREFUSED' ? 'Connection refused' : e.message)));
    req.end();
  });
}

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');

/** The Authorization header answering a Digest challenge. */
export function digestAuth(challenge: string, method: string, path: string, c: Credentials, cnonce = crypto.randomBytes(8).toString('hex')): string {
  const p: Record<string, string> = {};
  for (const m of challenge.replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) p[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? '';
  const realm = p.realm ?? '';
  const nonce = p.nonce ?? '';
  const qop = (p.qop ?? '').split(',').map((x) => x.trim()).includes('auth') ? 'auth' : '';
  const ha1 = md5(`${c.user}:${realm}:${c.password}`);
  const ha2 = md5(`${method}:${path}`);
  const nc = '00000001';
  const response = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  const q = (k: string, v: string) => `${k}="${v.replace(/"/g, '')}"`;
  const parts = [q('username', c.user), q('realm', realm), q('nonce', nonce), q('uri', path), q('response', response)];
  if (p.opaque !== undefined) parts.push(q('opaque', p.opaque));
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, q('cnonce', cnonce));
  parts.push('algorithm=MD5');
  return 'Digest ' + parts.join(', ');
}

export const basicAuth = (c: Credentials) => 'Basic ' + Buffer.from(`${c.user}:${c.password}`).toString('base64');

/** A request with the camera's login when it asks for one. Throws on anything but 2xx. */
export async function request(method: 'GET' | 'POST', host: string, port: number, path: string, login: Credentials | null): Promise<HttpReply> {
  let r = await once(method, host, port, path, undefined);
  if (r.status === 401) {
    if (!login?.user) throw new HttpError('The camera wants a user name and password', 401);
    const auth = /^Digest/i.test(r.challenge) ? digestAuth(r.challenge, method, path, login) : basicAuth(login);
    r = await once(method, host, port, path, auth);
    if (r.status === 401) throw new HttpError('The camera refused the user name and password', 401);
  }
  if (r.status === 403) throw new HttpError('The camera says this login may not change that setting (an admin login is needed)', 403);
  if (r.status === 404) throw new HttpError('This camera model does not have that command', 404);
  if (r.status < 200 || r.status >= 300) throw new HttpError(`HTTP ${r.status}`, r.status);
  return { status: r.status, body: r.body };
}
