import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { LinkError, fetchJson } from './links.js';
import type { DownloadOptions } from './links.js';
import { fontBytes, pdfLibOrder } from './meta.js';

/**
 * Kvish 6 (Derech Eretz) monthly invoice emails carry no PDF, only a link to service.kvish6.co.il, a
 * JavaScript app. Its PDF download needs the owner's ID number and a reCAPTCHA, so it cannot be fetched.
 * The same app loads the invoice details from a JSON API keyed by the link's id, without a login, so we
 * build the document from that data (and say so on the item). The link is valid for about a month.
 */

export interface Kvish6Trip { plate: string; trips: number; amount: string }

export interface Kvish6Invoice {
  invoiceNumber: string;
  amount: string;
  account: string;
  customerName: string | null;
  period: string | null;
  /** DD/MM/YYYY */
  issueDate: string | null;
  trips: Kvish6Trip[];
}

const LINK = /https:\/\/service\.kvish6\.co\.il\/#\/website\/invoice\?(?:[^"'\s<>]*&(?:amp;)?)?id=([0-9a-f]{16,128})/i;

/** The digital-invoice id in a Kvish 6 email, or null when the email has no such link. */
export function kvish6InvoiceId(html: string, text = ''): string | null {
  return (html.match(LINK) ?? text.match(LINK))?.[1] ?? null;
}

export function kvish6ApiUrl(id: string): string {
  return `https://service.kvish6.co.il/api/invoice/CheckLoginAndGetDigitalInvoice?id=${encodeURIComponent(id)}`;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' ? String(v) : null);

/** Picks the invoice the email is about (the month the page opens on) from the API answer. */
export function parseKvish6Response(data: unknown): Kvish6Invoice {
  const body = data as { Success?: unknown; Payload?: Record<string, unknown> } | null;
  const p = body?.Payload;
  if (!p || body?.Success === false) throw new LinkError('link_not_pdf', 'kvish6: no invoice data');
  if (p.IsLinkExpired === true) {
    throw new LinkError('link_failed', 'kvish6: the link expired (valid one month); download the invoice from the Kvish 6 personal area');
  }
  const months = Array.isArray(p.MonthInfo) ? (p.MonthInfo as Record<string, unknown>[]) : [];
  const month = months.find((m) => m.isDefualt === true && Array.isArray(m.InvoiceInfo) && m.InvoiceInfo.length > 0)
    ?? months.find((m) => Array.isArray(m.InvoiceInfo) && m.InvoiceInfo.length > 0);
  const inv = (month?.InvoiceInfo as Record<string, unknown>[] | undefined)?.[0];
  const invoiceNumber = str(inv?.InvoiceNum);
  const amount = str(inv?.InvoiceAmount);
  if (!inv || !invoiceNumber || !amount) throw new LinkError('link_not_pdf', 'kvish6: no invoice in the answer');
  const d = str(inv.InvoiceDate)?.match(/^(\d{4})(\d{2})(\d{2})$/);
  const trips = (Array.isArray(inv.VehicleTripsInfo) ? (inv.VehicleTripsInfo as Record<string, unknown>[]) : [])
    .map((t) => ({ plate: str(t.VehiclePlateNumber) ?? '', trips: Number(t.TripsCount) || 0, amount: str(t.TripsAmount) ?? '' }));
  return {
    invoiceNumber,
    amount,
    account: str(inv.AccountNumber) ?? str(p.AccountNumber) ?? '',
    customerName: str(p.CustomerName),
    period: str(inv.InvoicePeriod),
    issueDate: d ? `${d[3]}/${d[2]}/${d[1]}` : null,
    trips,
  };
}

/**
 * The document, worded like Kvish 6's own invoice so the kvish6 recipe reads it: "תאריך הפקת החשבונית",
 * "תקופת החשבונית", "מספר נסיעות" and "סה"כ כולל מע"מ (ש"ח)".
 */
export async function renderKvish6Pdf(inv: Kvish6Invoice): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const { regular, bold } = fontBytes();
  const font = await doc.embedFont(regular);
  const fontBold = await doc.embedFont(bold);
  doc.setTitle(`Kvish 6 invoice ${inv.invoiceNumber}`);
  doc.setProducer('Invoice Collector');

  const W = 595.28, H = 841.89, M = 48;
  const ink = rgb(0.1, 0.1, 0.1), muted = rgb(0.42, 0.42, 0.42);
  const page = doc.addPage([W, H]);
  let y = H - M;
  // Right-aligned, one logical line each: Hebrew label first, then its value.
  const line = (s: string, size = 11, f = font, color = ink) => {
    const shown = pdfLibOrder(s);
    page.drawText(shown, { x: W - M - f.widthOfTextAtSize(shown, size), y, size, font: f, color });
    y -= size + 8;
  };

  line('כביש 6 - פרטי החשבונית', 18, fontBold);
  line('המסמך נבנה מנתוני החשבונית הדיגיטלית באתר כביש 6, כי את הקובץ המקורי אי אפשר להוריד בלי הזדהות.', 8.5, font, muted);
  y -= 10;
  line(`מספר חשבונית ${inv.invoiceNumber}`);
  if (inv.issueDate) line(`תאריך הפקת החשבונית ${inv.issueDate}`);
  if (inv.period) line(`תקופת החשבונית ${inv.period}`);
  line(`מספר לקוח ${inv.account}`);
  if (inv.customerName) line(`שם הלקוח ${inv.customerName}`);
  const totalTrips = inv.trips.reduce((n, t) => n + t.trips, 0);
  line(`מספר נסיעות ${totalTrips}`);
  for (const t of inv.trips) line(`רכב ${t.plate}: ${t.trips} נסיעות, ${t.amount} ש"ח`, 10, font, muted);
  y -= 6;
  line(`סה"כ כולל מע"מ (ש"ח) ${inv.amount}`, 13, fontBold);
  return Buffer.from(await doc.save());
}

export interface Kvish6Document { name: string; data: Buffer; note: string }

export async function kvish6Document(id: string, opts: DownloadOptions = {}): Promise<Kvish6Document> {
  const inv = parseKvish6Response(await fetchJson(kvish6ApiUrl(id), opts));
  return {
    name: `kvish6-${inv.invoiceNumber.replace(/[^\w-]/g, '')}.pdf`,
    data: await renderKvish6Pdf(inv),
    note: 'made_from_vendor_data:kvish6',
  };
}
