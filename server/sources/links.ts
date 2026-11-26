import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type LinkErrorCode = 'link_blocked' | 'link_not_pdf' | 'link_too_large' | 'link_failed';

export class LinkError extends Error {
  constructor(public code: LinkErrorCode, message: string) {
    super(message);
    this.name = 'LinkError';
  }
}

const KEEP = /pdf|invoice|receipt|document|חשבונית|קבלה|הורדה|להורדת|מסמך|לצפי(?:י)?ה|download/i;
const DROP = /unsubscribe|privacy|optout|opt-out|preferences|הסרה|פרטיות/i;
const MAX_LINKS = 5;

function decodeEntities(s: string): string {
  return s.replace(/&amp;/gi, '&').replace(/&#38;/g, '&').replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
}

/**
 * A vendor whose emailed link opens a viewer page rather than the PDF itself. `apiUrl` maps the viewer link
 * to the address that actually serves the document; `extract` turns that response into the PDF bytes.
 */
interface KnownViewer {
  name: string;
  apiUrl(url: URL): string | null;
  extract(body: Buffer): Buffer;
}

const KNOWN_VIEWERS: KnownViewer[] = [
  {
    // InvoiceOne (invoice-one.com): Akum and other Israeli senders. The viewer page loads the document from
    // GetPDF, which answers JSON with the PDF base64-encoded in Entity.ArrData. No login needed.
    name: 'invoice-one',
    apiUrl(url) {
      if (!/^(www\.)?invoice-one\.com$/i.test(url.hostname)) return null;
      const id = url.pathname.match(/\/viewernew\/pages\/(?:Y_)?GreeViewer_document\/([A-Za-z0-9]+)\/?$/i)?.[1];
      return id ? `https://invoice-one.com/viewernew/api/GreeViewer/Document/GetPDF?DocumentID=${id}` : null;
    },
    extract(body) {
      let data: unknown;
      try {
        data = JSON.parse(body.toString('utf8'));
      } catch {
        throw new LinkError('link_not_pdf', 'invoice-one: response is not JSON');
      }
      const b64 = (data as { Entity?: { ArrData?: unknown } })?.Entity?.ArrData;
      if (typeof b64 !== 'string' || b64 === '') throw new LinkError('link_not_pdf', 'invoice-one: no document data');
      return Buffer.from(b64, 'base64');
    },
  },
];

function knownViewer(url: string): { viewer: KnownViewer; apiUrl: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  for (const viewer of KNOWN_VIEWERS) {
    const apiUrl = viewer.apiUrl(u);
    if (apiUrl) return { viewer, apiUrl };
  }
  return null;
}

/** http(s) links whose URL or anchor text looks like an invoice; deduped, max 5, known viewers first. */
export function findInvoiceLinks(html: string, text: string): string[] {
  const found: string[] = [];
  const known: string[] = [];
  const add = (raw: string, anchor: string) => {
    const url = decodeEntities(raw.trim()).replace(/[)\].,;>]+$/, '');
    if (!/^https?:\/\//i.test(url)) return;
    if (knownViewer(url)) {
      if (!known.includes(url)) known.push(url);
      return;
    }
    if (DROP.test(url) || DROP.test(anchor)) return;
    if (!KEEP.test(url) && !KEEP.test(anchor)) return;
    if (!found.includes(url)) found.push(url);
  };
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) add(m[1] ?? m[2] ?? '', m[3].replace(/<[^>]*>/g, ' '));
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) add(m[0], '');
  return [...known, ...found].slice(0, MAX_LINKS);
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
  /** Extra request headers (e.g. a login cookie), sent only while the URL's host matches `hosts`. */
  headersFor?: { hosts: RegExp; headers: Record<string, string> };
}

const defaultResolve = (host: string) => lookup(host, { all: true });
const MAX_REDIRECTS = 6;

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

const BROWSER_HEADERS: Record<string, string> = {
  // Some vendor sites (behind Cloudflare and the like) refuse a bare server fetch; look like a browser.
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  accept: 'application/pdf,text/html;q=0.9,*/*;q=0.8',
  'accept-language': 'he-IL,he;q=0.9,en;q=0.8',
};
/** How many HTML pages deep we follow from the emailed link looking for the actual PDF (a download page). */
const MAX_PAGE_DEPTH = 2;
const MAX_PAGE_CANDIDATES = 4;

/** The PDF inside a body: `%PDF-` within the first 1024 bytes (some servers send a short preamble). */
function pdfFrom(buf: Buffer): Buffer | null {
  const at = buf.subarray(0, 1024).indexOf('%PDF-', 0, 'latin1');
  return at < 0 ? null : at === 0 ? buf : buf.subarray(at);
}

/**
 * Where an HTML landing page sends the browser for the document: a meta refresh or script redirect, an
 * embedded viewer (iframe/embed/object), or a link that looks like the PDF download. Absolute, deduped, in
 * that order of preference.
 */
export function pdfCandidatesFromHtml(html: string, base: string): string[] {
  const out: string[] = [];
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const v = decodeEntities(raw.trim()).replace(/\\\//g, '/');
    if (!v || /^(javascript|mailto|tel|data):/i.test(v) || v.startsWith('#')) return;
    let u: string;
    try { u = new URL(v, base).toString(); } catch { return; }
    if (!/^https?:/i.test(u) || u === base || out.includes(u)) return;
    out.push(u);
  };
  for (const m of html.matchAll(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi)) {
    add(m[0].match(/content\s*=\s*["'][^"']*?url\s*=\s*['"]?([^"'>\s]+)/i)?.[1]);
  }
  for (const m of html.matchAll(/(?:window\.|document\.)?location(?:\.href)?\s*(?:=|\.replace\(|\.assign\()\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/<(?:iframe|embed|frame)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/<object\b[^>]*?\bdata\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  const anchors = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  const pdfish = /\.pdf\b|[?&/](?:pdf|download)\b|format=pdf|type=pdf/i;
  for (const m of html.matchAll(anchors)) {
    const href = m[1] ?? m[2] ?? '';
    const tag = m[0].slice(0, m[0].indexOf('>') + 1);
    const label = m[3].replace(/<[^>]*>/g, ' ');
    if (DROP.test(href) || DROP.test(label)) continue;
    if (pdfish.test(href) || /\bdownload\b/i.test(tag) || /pdf|הורד|download/i.test(label)) add(href);
  }
  for (const m of html.matchAll(/["'](https?:\/\/[^"'\s<>]+?\.pdf(?:\?[^"'\s<>]*)?)["']/gi)) add(m[1]);
  return out.slice(0, MAX_PAGE_CANDIDATES);
}

interface Fetched { body: Buffer; contentType: string; url: string }

/** One GET with SSRF checks on every hop, manual redirects, a per-host cookie jar and a size cap. */
async function fetchSafe(
  start: URL, opts: DownloadOptions, jar: Map<string, Map<string, string>>, signal: AbortSignal,
): Promise<Fetched> {
  const resolve = opts.resolve ?? defaultResolve;
  const doFetch = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? 20 * 1024 * 1024;
  let current = start;
  for (let hop = 0; ; hop++) {
    await assertSafe(current, resolve);
    const headers: Record<string, string> = { ...BROWSER_HEADERS };
    const cookies = jar.get(current.hostname);
    if (cookies?.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (opts.headersFor && opts.headersFor.hosts.test(current.hostname)) Object.assign(headers, opts.headersFor.headers);
    const res = await doFetch(current.toString(), { redirect: 'manual', signal, headers });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of setCookies) {
      const pair = c.split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      if (!jar.has(current.hostname)) jar.set(current.hostname, new Map());
      jar.get(current.hostname)!.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
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
    return { body: Buffer.concat(chunks), contentType: (res.headers.get('content-type') ?? '').toLowerCase(), url: current.toString() };
  }
}

/**
 * Downloads a PDF from an emailed link, refusing internal addresses (SSRF). When the link opens an HTML page
 * (a "download your invoice" landing page, a viewer, a script redirect), the page is searched for the PDF
 * and up to MAX_PAGE_DEPTH pages are followed; every hop goes through the same address checks.
 *
 * Known limit (accepted for v1): we resolve DNS to vet the host, then fetch resolves it again,
 * so a hostile DNS server could answer differently the second time (TOCTOU / DNS rebinding).
 * Closing it needs a pinned-IP connection agent, which we deliberately do not build.
 */
export async function downloadPdf(url: string, opts: DownloadOptions = {}): Promise<Buffer> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
  const jar = new Map<string, Map<string, string>>();

  const visit = async (target: string, depth: number): Promise<Buffer> => {
    // A known viewer link is swapped for the vendor's document address; everything below still applies.
    const known = knownViewer(target);
    let start: URL;
    try {
      start = new URL(known?.apiUrl ?? target);
    } catch {
      throw new LinkError('link_blocked', 'invalid url');
    }
    const got = await fetchSafe(start, opts, jar, signal);
    const raw = known ? known.viewer.extract(got.body) : got.body;
    const pdf = pdfFrom(raw);
    if (pdf) return pdf;
    const looksHtml = /html/.test(got.contentType) || /^\s*(<!doctype|<html|<head|<body|<meta|<script)/i.test(raw.subarray(0, 512).toString('latin1'));
    if (known || !looksHtml || depth >= MAX_PAGE_DEPTH) throw new LinkError('link_not_pdf', 'not a PDF');
    const candidates = pdfCandidatesFromHtml(raw.toString('utf8'), got.url);
    if (candidates.length === 0) throw new LinkError('link_not_pdf', 'not a PDF (page has no document link)');
    let firstErr: unknown = null;
    for (const next of candidates) {
      try {
        return await visit(next, depth + 1);
      } catch (err) {
        if (err instanceof LinkError && err.code === 'link_blocked') throw err;
        firstErr ??= err;
      }
    }
    throw firstErr;
  };

  try {
    return await visit(url, 0);
  } catch (err) {
    if (err instanceof LinkError) throw err;
    throw new LinkError('link_failed', (err as Error).message);
  }
}
