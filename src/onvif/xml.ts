// A small XML reader for SOAP: elements by local name (namespace prefixes dropped), attributes, text. No DTDs,
// no entities beyond the five standard ones and character references, which is all ONVIF uses.

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export class XmlError extends Error {}

const local = (n: string) => n.slice(n.indexOf(':') + 1);

function unescape(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()]!;
  });
}

export function esc(s: string | number): string {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

export function parseXml(src: string): XmlNode {
  if (src.length > 2_000_000) throw new XmlError('XML too large');
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) stack[stack.length - 1]!.text += unescape(src.slice(i, lt));
    if (src.startsWith('<?', lt)) {
      i = src.indexOf('?>', lt);
      if (i < 0) throw new XmlError('Unclosed declaration');
      i += 2;
    } else if (src.startsWith('<!--', lt)) {
      i = src.indexOf('-->', lt);
      if (i < 0) throw new XmlError('Unclosed comment');
      i += 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt);
      if (e < 0) throw new XmlError('Unclosed CDATA');
      stack[stack.length - 1]!.text += src.slice(lt + 9, e);
      i = e + 3;
    } else if (src.startsWith('<!', lt)) {
      throw new XmlError('DTDs are not accepted');
    } else if (src[lt + 1] === '/') {
      const gt = src.indexOf('>', lt);
      if (gt < 0) throw new XmlError('Unclosed tag');
      const name = local(src.slice(lt + 2, gt).trim());
      const top = stack.pop();
      if (!top || top.name !== name || !stack.length) throw new XmlError(`Mismatched </${name}>`);
      i = gt + 1;
    } else {
      const m = /^<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(src.slice(lt, lt + 4096));
      if (!m) throw new XmlError('Bad tag');
      const node: XmlNode = { name: local(m[1]!), attrs: {}, children: [], text: '' };
      for (const a of m[2]!.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) node.attrs[local(a[1]!)] = unescape(a[2] ?? a[3] ?? '');
      stack[stack.length - 1]!.children.push(node);
      if (!m[3]) {
        if (stack.length > 64) throw new XmlError('XML nested too deep');
        stack.push(node);
      }
      i = lt + m[0].length;
    }
  }
  if (stack.length !== 1) throw new XmlError('Unclosed element');
  return root;
}

/** The first descendant (depth first) with this local name, or a path of names. */
export function find(n: XmlNode | undefined, ...path: string[]): XmlNode | undefined {
  let cur = n;
  for (const p of path) {
    if (!cur) return undefined;
    cur = descend(cur, p);
  }
  return cur;
}

function descend(n: XmlNode, name: string): XmlNode | undefined {
  for (const c of n.children) {
    if (c.name === name) return c;
    const d = descend(c, name);
    if (d) return d;
  }
  return undefined;
}

export function findAll(n: XmlNode | undefined, name: string, out: XmlNode[] = []): XmlNode[] {
  if (!n) return out;
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    else findAll(c, name, out);
  }
  return out;
}

/** Direct child by name. */
export function child(n: XmlNode | undefined, name: string): XmlNode | undefined {
  return n?.children.find((c) => c.name === name);
}

export function text(n: XmlNode | undefined, ...path: string[]): string {
  return (find(n, ...path)?.text ?? '').trim();
}

export function num(n: XmlNode | undefined, ...path: string[]): number | undefined {
  const t = text(n, ...path);
  const v = Number(t);
  return t !== '' && Number.isFinite(v) ? v : undefined;
}
