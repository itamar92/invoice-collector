import { getDb } from '../db.js';
import type { Settings } from '../settings.js';
import type { ExtractedFields } from './types.js';

/**
 * Documents that arrive with invoices but are not expenses: price quotes, insurance papers, and copies of the
 * owner's own invoices (issued to customers and mailed back as a backup). They are ignored, never filed or sent.
 */
export type NotInvoiceKind = 'quote' | 'insurance' | 'own_document' | 'zero_total';

/** Only the top of the document is its title; a footer may well mention a quote or a policy number. */
const HEAD_CHARS = 1500;
/** A word that names a tax document anywhere in the text keeps it, whatever else the title says. */
const TAX_DOC = /חשבונית[\s-]*מס|(?<![\p{L}])קבלה(?![\p{L}])|tax\s+invoice|(?<![\p{L}])(?:invoice|receipt)(?![\p{L}])/iu;
const QUOTE = /הצעת[\s-]*מחיר|(?<![\p{L}])(?:quote|quotation|proposal)(?![\p{L}])/iu;
const INSURANCE =
  /פוליס[הת]|רשימת\s+(?:ה)?ביטוח|דף\s+פרטי\s+(?:ה)?ביטוח|מסמכי\s+(?:ה)?ביטוח|הצעת\s+ביטוח|insurance\s+policy|policy\s+schedule/iu;

/** From the PDF text alone: a quote or insurance paper that names no tax document. */
export function notInvoiceKind(text: string): 'quote' | 'insurance' | null {
  if (TAX_DOC.test(text)) return null;
  const head = text.slice(0, HEAD_CHARS);
  if (QUOTE.test(head)) return 'quote';
  if (INSURANCE.test(head)) return 'insurance';
  return null;
}

/** A free-plan invoice (e.g. Cloudflare's monthly $0.00): nothing to file or book. Credit notes are not zero bills. */
export function isZeroTotal(f: Pick<ExtractedFields, 'total' | 'docType'>): boolean {
  return f.total !== null && Math.abs(f.total) < 0.005 && f.docType !== 'credit_note';
}

export const digits = (s: string | null | undefined): string => (s ?? '').replace(/\D/g, '');

/** The issuer is the owner's own business (ע.מ / ח.פ in settings): a copy of an invoice they sent a customer. */
export function isOwnDocument(f: Pick<ExtractedFields, 'vendorTaxId'>, settings: Pick<Settings, 'ownTaxIds'>): boolean {
  const id = digits(f.vendorTaxId);
  return id !== '' && (settings.ownTaxIds ?? []).some((own) => digits(own) === id);
}

/**
 * Likely tax ids of the owner's business, from what was already read: a 9-digit number printed on documents of
 * at least `minVendors` different vendors (the "לכבוד" block of an expense carries the customer's id), that is no
 * vendor's own id. Most frequent first.
 */
export function suggestOwnTaxIds(minVendors = 3): { taxId: string; vendors: number }[] {
  const rows = getDb().prepare(
    `SELECT vendor_key, text, json_extract(fields_json, '$.vendorTaxId') AS vid FROM items
     WHERE text IS NOT NULL AND vendor_key IS NOT NULL`).all() as { vendor_key: string; text: string; vid: string | null }[];
  const vendorIds = new Set(rows.map((r) => digits(r.vid)).filter((x) => x !== ''));
  const seen = new Map<string, Set<string>>();
  for (const r of rows) {
    for (const m of r.text.matchAll(/(?<!\d)(\d{9})(?!\d)/g)) {
      const id = m[1];
      if (id.startsWith('0') || vendorIds.has(id)) continue; // 0…: a landline number, not a business id
      let s = seen.get(id);
      if (!s) seen.set(id, (s = new Set()));
      s.add(r.vendor_key);
    }
  }
  return [...seen.entries()]
    .filter(([, s]) => s.size >= minVendors)
    .map(([taxId, s]) => ({ taxId, vendors: s.size }))
    .sort((a, b) => b.vendors - a.vendors || a.taxId.localeCompare(b.taxId))
    .slice(0, 3);
}
