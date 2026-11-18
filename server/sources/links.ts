import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type LinkErrorCode = 'link_blocked' | 'link_not_pdf' | 'link_too_large' | 'link_failed';

export class LinkError extends Error {
  constructor(public code: LinkErrorCode, message: string) {
    super(message);
    this.name = 'LinkError';
  }
}

const KEEP = /pdf|invoice|receipt|חשבונית|קבלה|הורדה|download/i;
const DROP = /unsubscribe|privacy|optout|opt-out|preferences|הסרה|פרטיות/i;
const MAX_LINKS = 5;

function decodeEntities(s: string): string {
  return s.replace(/&amp;/gi, '&').replace(/&#38;/g, '&').replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
}

/** http(s) links whose URL or anchor text looks like an invoice; deduped, max 5. */
export function findInvoiceLinks(html: string, text: string): string[] {
  const found: string[] = [];
  const add = (raw: string, anchor: string) => {
    const url = decodeEntities(raw.trim()).replace(/[)\].,;>]+$/, '');
    if (!/^https?:\/\//i.test(url)) return;
    if (DROP.test(url) || DROP.test(anchor)) return;
    if (!KEEP.test(url) && !KEEP.test(anchor)) return;
    if (!found.includes(url)) found.push(url);
  };
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) add(m[1] ?? m[2] ?? '', m[3].replace(/<[^>]*>/g, ' '));
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) add(m[0], '');
  return found.slice(0, MAX_LINKS);
}

function v4Blocked(a: number[]): boolean {
  const [x, y] = a;
  return (
    x === 0 || x === 10 || x === 127 || x >= 224 ||
    (x === 100 && y >= 64 && y <= 127) ||
    (x === 169 && y === 254) ||
    (x === 172 && y >= 16 && y <= 31) ||
    (x === 192 && y === 168) ||
    (x === 198 && (y === 18 || y === 19))
  );
}

/** Expands an IPv6 literal into 8 16-bit groups, or null if it is malformed. */
function parseV6(addr: string): number[] | null {
  let s = addr.toLowerCase().split('%')[0];
  const tail = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const p = tail[2].split('.').map(Number);
    if (p.length !== 4 || p.some((n) => n > 255)) return null;
    s = tail[1] + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

export function isBlockedAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return v4Blocked(address.split('.').map(Number));
  if (kind === 6) {
    const g = parseV6(address);
    if (!g) return true;
    if (g.every((x) => x === 0)) return true; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d)
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
      return v4Blocked([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]);
    }
    return false;
  }
  return true; // not an IP: refuse
}

export interface DownloadOptions {
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

const defaultResolve = (host: string) => lookup(host, { all: true });
const MAX_REDIRECTS = 3;

async function assertSafe(url: URL, resolve: NonNullable<DownloadOptions['resolve']>): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LinkError('link_blocked', `scheme not allowed: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new LinkError('link_blocked', 'address not allowed');
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await resolve(host);
  } catch (err) {
    throw new LinkError('link_failed', `dns failed: ${(err as Error).message}`);
  }
  if (addrs.length === 0) throw new LinkError('link_failed', 'dns returned no addresses');
  if (addrs.some((a) => isBlockedAddress(a.address))) throw new LinkError('link_blocked', 'host resolves to a blocked address');
}

/**
 * Downloads a PDF from an emailed link, refusing internal addresses (SSRF).
 *
 * Known limit (accepted for v1): we resolve DNS to vet the host, then fetch resolves it again,
 * so a hostile DNS server could answer differently the second time (TOCTOU / DNS rebinding).
 * Closing it needs a pinned-IP connection agent, which we deliberately do not build.
 */
export async function downloadPdf(url: string, opts: DownloadOptions = {}): Promise<Buffer> {
  const resolve = opts.resolve ?? defaultResolve;
  const doFetch = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? 20 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    let current: URL;
    try {
      current = new URL(url);
    } catch {
      throw new LinkError('link_blocked', 'invalid url');
    }
    for (let hop = 0; ; hop++) {
      await assertSafe(current, resolve);
      const res = await doFetch(current.toString(), { redirect: 'manual', signal });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!loc) throw new LinkError('link_failed', 'redirect without location');
        if (hop >= MAX_REDIRECTS) throw new LinkError('link_failed', 'too many redirects');
        try {
          current = new URL(loc, current);
        } catch {
          throw new LinkError('link_failed', 'bad redirect location');
        }
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel().catch(() => {});
        throw new LinkError('link_failed', `http ${res.status}`);
      }
      const declared = Number(res.headers.get('content-length'));
      if (declared > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new LinkError('link_too_large', 'content-length over limit');
      }
      const chunks: Buffer[] = [];
      let total = 0;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new LinkError('link_too_large', 'body over limit');
          }
          chunks.push(Buffer.from(value));
        }
      }
      const buf = Buffer.concat(chunks);
      if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new LinkError('link_not_pdf', 'not a PDF');
      return buf;
    }
  } catch (err) {
    if (err instanceof LinkError) throw err;
    throw new LinkError('link_failed', (err as Error).message);
  }
}
