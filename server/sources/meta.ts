import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PDFDocument, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { getSecret } from '../secrets.js';
import { LinkError, downloadPdf } from './links.js';
import type { DownloadOptions } from './links.js';

/**
 * Meta ads receipts arrive as an email with no attachment; its links need a Facebook login. With the owner's
 * Facebook cookies saved (secret `meta_cookies`) we try Meta's own receipt PDF; otherwise, or when that fails,
 * we build a PDF from the email itself and leave a note on the item saying so.
 */

export interface MetaCampaign { name: string; results: string; amount: string }

export interface MetaReceipt {
  accountId: string;
  txid: string;
  accountName: string | null;
  referenceNumber: string | null;
  amountBilled: string | null;
  dateRange: string | null;
  billingReason: string | null;
  productType: string | null;
  paymentMethod: string | null;
  campaigns: MetaCampaign[];
  campaignTotal: string | null;
  total: string | null;
  billedBy: string | null;
}

const NAMED: Record<string, string> = {
  middot: '·', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…',
  rlm: '‏', lrm: '‎', euro: '€', pound: '£', shekel: '₪',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&([a-z]+);/gi, (m, n: string) => NAMED[n.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

const BIDI_MARKS = /[‎‏‪-‮⁦-⁩]/g;

/** The email's visible text as one trimmed line per table cell / block. */
export function emailLines(html: string): string[] {
  const s = html
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(td|th|tr|p|div|h\d|li|table)>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(s).replace(BIDI_MARKS, '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** A money cell ("₪602.87", "$12.00 USD"); a bare count like "71,322" in the Results column is not one. */
const AMOUNT = /^(?:[^\d\s]{1,3}\s?[\d,]+(?:\.\d+)?|[\d,]+\.\d{2})(?:\s?[A-Z]{3})?$/;

/** Reads a Meta ads receipt email; null when the email is not one (or has no transaction to point at). */
export function parseMetaReceipt(html: string): MetaReceipt | null {
  if (!/facebook\.com\/ads\/billing_email\//i.test(html)) return null;
  const link = decodeEntities(html).match(/[?&]act=(\d+)&(?:amp;)?txid=([\w-]+)/);
  if (!link) return null;
  const lines = emailLines(html);
  const after = (label: string): string | null => {
    const i = lines.findIndex((l) => l.toLowerCase() === label.toLowerCase());
    return i >= 0 && i + 1 < lines.length ? lines[i + 1] : null;
  };
  const amountBilled = after('Amount billed');
  if (!amountBilled) return null;

  const campaigns: MetaCampaign[] = [];
  const start = lines.findIndex((l, i) => l === 'Campaign' && lines[i + 1] === 'Results' && lines[i + 2] === 'Amount');
  const end = lines.indexOf('Campaign total');
  if (start >= 0 && end > start) {
    let row: string[] = [];
    for (const l of lines.slice(start + 3, end)) {
      if (row.length > 0 && AMOUNT.test(l)) {
        campaigns.push({ name: row[0], results: row.slice(1).join(' '), amount: l });
        row = [];
      } else {
        row.push(l);
      }
    }
  }
  const forLine = after('Transaction for');
  return {
    accountId: link[1],
    txid: link[2],
    accountName: forLine?.replace(/\s*\(\d+\)\s*$/, '') || null,
    referenceNumber: after('Reference number'),
    amountBilled,
    dateRange: after('Date range'),
    billingReason: after('Billing reason'),
    productType: after('Product type'),
    paymentMethod: after('Payment method'),
    campaigns,
    campaignTotal: after('Campaign total'),
    total: after('Total'),
    billedBy: lines.join(' ').match(/billed by ([^,.]+?(?:Limited|Ltd|Inc)\.?)(?:,|\s|$)/i)?.[1] ?? null,
  };
}

/** Meta's own receipt PDF for one transaction (needs a logged-in Facebook session). */
export function metaReceiptUrl(r: Pick<MetaReceipt, 'accountId' | 'txid'>): string {
  const q = new URLSearchParams({
    act: r.accountId, pdf: 'true', print: 'false', source: 'billing_summary', tx_type: '3', txid: r.txid,
  });
  return `https://business.facebook.com/ads/manage/billing_transaction/?${q}`;
}

const FACEBOOK_HOSTS = /^(?:[\w-]+\.)*facebook\.com$/i;
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/**
 * Turns whatever the user pasted into one `Cookie:` header value. Accepts `name=value` pairs separated by
 * `;`, `,` or new lines (with or without a leading `Cookie:`), and rows copied from the browser's DevTools
 * cookie table (`name<TAB>value<TAB>domain...`). Anything else is dropped.
 */
export function normalizeCookies(raw: string): string {
  const pairs: string[] = [];
  for (const line of raw.replace(/^\s*cookie:\s*/i, '').split(/\r?\n/)) {
    if (line.includes('\t')) {
      const [name, value] = line.split('\t').map((c) => c.trim());
      if (name && value && /^[^=\s;,]+$/.test(name)) pairs.push(`${name}=${value}`);
      continue;
    }
    for (const part of line.split(/[;,]/)) {
      const p = part.trim();
      if (/^[^=\s]+=.+/.test(p)) pairs.push(p.replace(/^([^=\s]+)=\s*/, '$1='));
    }
  }
  return pairs.join('; ');
}

// ---- building a PDF from the email ----

const require = createRequire(import.meta.url);
let fonts: { regular: Uint8Array; bold: Uint8Array } | null = null;
export function fontBytes() {
  fonts ??= {
    regular: readFileSync(require.resolve('@expo-google-fonts/heebo/400Regular/Heebo_400Regular.ttf')),
    bold: readFileSync(require.resolve('@expo-google-fonts/heebo/700Bold/Heebo_700Bold.ttf')),
  };
  return fonts;
}

const HEBREW = /[֐-׿]/;
const LTR_RUN = /[A-Za-z0-9À-ɏ](?:[A-Za-z0-9À-ɏ.,:/%@'_+-]*[A-Za-z0-9À-ɏ%])?/g;
const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '<': '>', '>': '<' };

const HEBREW_RUN = /[֐-׿]+(?:[\s"'׳״-]+[֐-׿]+)*/g;

/** True when the line's first letter is Hebrew, i.e. the line reads right to left. */
function startsHebrew(s: string): boolean {
  const first = s.match(/[A-Za-zÀ-ɏ֐-׿]/)?.[0];
  return !!first && HEBREW.test(first);
}

/**
 * PDF text is drawn left to right, so a line with Hebrew is put in visual order first. A line starting in
 * Hebrew reads right to left: its pieces are reversed, Hebrew letters too, while Latin words and numbers
 * (e.g. "12.2", "15.12") keep their order. A line starting in English keeps its order; only its Hebrew
 * words are reversed.
 */
export function visualOrder(s: string): string {
  if (!HEBREW.test(s)) return s;
  if (!startsHebrew(s)) return s.replace(HEBREW_RUN, (run) => [...run].reverse().join(''));
  const parts: string[] = [];
  let last = 0;
  for (const m of s.matchAll(LTR_RUN)) {
    if (m.index! > last) parts.push(...[...s.slice(last, m.index)].map((c) => MIRROR[c] ?? c));
    parts.push(m[0]);
    last = m.index! + m[0].length;
  }
  if (last < s.length) parts.push(...[...s.slice(last)].map((c) => MIRROR[c] ?? c));
  return parts.reverse().join('');
}

/**
 * The string to hand pdf-lib so the line *appears* in visual order. pdf-lib lays text out with fontkit, which
 * reverses the whole line when its first letter is Hebrew (it treats the run as right-to-left), so such lines
 * are pre-reversed to cancel that out.
 */
export function pdfLibOrder(s: string): string {
  const visual = visualOrder(s);
  return startsHebrew(s) ? [...visual].reverse().join('') : visual;
}

/** Shortens the text (from its logical end) until it fits `width`, then orders it for drawing. */
function fit(text: string, font: PDFFont, size: number, width: number): string {
  const shown = pdfLibOrder(text);
  if (font.widthOfTextAtSize(shown, size) <= width) return shown;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(pdfLibOrder(`${t}…`), size) > width) t = t.slice(0, -1);
  return pdfLibOrder(`${t.trimEnd()}…`);
}

export async function renderMetaReceiptPdf(r: MetaReceipt, receivedAt: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const { regular, bold } = fontBytes();
  const font = await doc.embedFont(regular);
  const fontBold = await doc.embedFont(bold);
  doc.setTitle(`Meta ads receipt ${r.referenceNumber ?? r.txid}`);
  doc.setProducer('Invoice Collector');

  const W = 595.28, H = 841.89, M = 48;
  const ink = rgb(0.1, 0.1, 0.1), muted = rgb(0.42, 0.42, 0.42), line = rgb(0.85, 0.85, 0.85);
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;
  const newLineSpace = (need: number) => {
    if (y - need < M) { page = doc.addPage([W, H]); y = H - M; }
  };
  const text = (s: string, x: number, opts: { size?: number; f?: PDFFont; color?: typeof ink; width?: number; right?: boolean } = {}) => {
    const size = opts.size ?? 10, f = opts.f ?? font;
    const shown = fit(s, f, size, opts.width ?? (opts.right ? 120 : W - M - x));
    const dx = opts.right ? -f.widthOfTextAtSize(shown, size) : 0;
    page.drawText(shown, { x: x + dx, y, size, font: f, color: opts.color ?? ink });
  };
  const rule = () => { page.drawLine({ start: { x: M, y: y + 4 }, end: { x: W - M, y: y + 4 }, thickness: 0.6, color: line }); };

  text('Meta ads receipt', M, { size: 18, f: fontBold });
  y -= 18;
  text("Built by Invoice Collector from Meta's receipt email, because Meta's own PDF could not be downloaded.", M, { size: 8.5, color: muted });
  y -= 12;
  text(`Email received ${receivedAt.slice(0, 10)}. Meta's email states: "This is not an invoice".`, M, { size: 8.5, color: muted });
  y -= 26;

  const rows: [string, string | null][] = [
    ['Billed by', r.billedBy ?? 'Meta Platforms'],
    ['Account', r.accountName ? `${r.accountName} (${r.accountId})` : r.accountId],
    ['Transaction ID', r.txid],
    ['Reference number', r.referenceNumber],
    ['Date range', r.dateRange],
    ['Amount billed', r.amountBilled],
    ['Payment method', r.paymentMethod],
    ['Product type', r.productType],
    ['Billing reason', r.billingReason],
  ];
  for (const [k, v] of rows) {
    if (!v) continue;
    newLineSpace(16);
    text(k, M, { f: fontBold, width: 130 });
    text(v, M + 140);
    y -= 16;
  }

  if (r.campaigns.length > 0) {
    y -= 14;
    newLineSpace(40);
    const colResults = W - M - 190, colAmount = W - M;
    text('Campaign', M, { f: fontBold });
    text('Results', colResults, { f: fontBold });
    text('Amount', colAmount, { f: fontBold, right: true });
    y -= 6; rule(); y -= 12;
    for (const c of r.campaigns) {
      newLineSpace(16);
      text(c.name, M, { width: colResults - M - 12 });
      text(c.results, colResults, { width: 110 });
      text(c.amount, colAmount, { right: true });
      y -= 16;
    }
    y -= 2; rule(); y -= 12;
    if (r.campaignTotal) { text('Campaign total', M, { f: fontBold }); text(r.campaignTotal, colAmount, { right: true }); y -= 16; }
  }
  if (r.total) {
    newLineSpace(20);
    y -= 4;
    text('Total', M, { size: 12, f: fontBold });
    text(r.total, W - M, { size: 12, f: fontBold, right: true });
  }
  return Buffer.from(await doc.save());
}

/** What the ingest step stores for a Meta receipt email. */
export interface MetaDocument { name: string; data: Buffer; note?: string }

export async function metaReceiptDocument(
  r: MetaReceipt, receivedAt: string, downloadOpts: DownloadOptions = {},
): Promise<MetaDocument> {
  const ref = (r.referenceNumber ?? r.txid).replace(/[^\w-]/g, '');
  let cookies: string | null = null;
  try { cookies = getSecret('meta_cookies'); } catch { /* unreadable: treat as not set */ }
  let why = 'no_facebook_login';
  if (cookies) {
    try {
      const data = await downloadPdf(metaReceiptUrl(r), {
        ...downloadOpts,
        headersFor: { hosts: FACEBOOK_HOSTS, headers: { cookie: normalizeCookies(cookies), 'user-agent': BROWSER_UA } },
      });
      return { name: `meta-receipt-${ref}.pdf`, data };
    } catch (e) {
      // Usually an expired Facebook login: Meta answers with its login page (link_not_pdf).
      why = e instanceof LinkError ? e.code : 'link_failed';
    }
  }
  return {
    name: `meta-receipt-${ref}-from-email.pdf`,
    data: await renderMetaReceiptPdf(r, receivedAt),
    note: `made_from_email:${why}`,
  };
}
