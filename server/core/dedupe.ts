import { createHash } from 'node:crypto';
import { getDb } from '../db.js';
import type { ExtractedFields } from './types.js';

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

const WINDOW_DAYS = 120;
const DAY_MS = 86_400_000;

function mentions(haystack: string, docNumber: string): boolean {
  const esc = docNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'u').test(haystack);
}

/** Records that a receipt item belongs to an already-sent invoice, so the invoice cannot absorb a second receipt. */
export function markReceiptFor(receiptId: string, invoiceId: string): void {
  const db = getDb();
  const state = db.prepare('SELECT state FROM items WHERE id = ?').pluck().get(receiptId) as string | undefined;
  if (!state) throw new Error(`Unknown item: ${receiptId}`);
  db.prepare('INSERT INTO item_events (item_id, at, from_state, to_state, note) VALUES (?, ?, ?, ?, ?)')
    .run(receiptId, new Date().toISOString(), state, state, `receipt_for:${invoiceId}`);
}

/**
 * When a receipt arrives for an invoice that was already sent to accounting,
 * return that invoice's item id so the receipt is not booked as a second expense.
 * Each invoice absorbs at most one receipt; docNumber matches beat total-only matches;
 * ties go to the most recent invoice.
 */
export function findReceiptForSentInvoice(f: ExtractedFields, vendorKey: string, text?: string): string | null {
  if (f.docType !== 'receipt' || !f.issueDate) return null;
  const receiptAt = Date.parse(f.issueDate);
  if (Number.isNaN(receiptAt)) return null;
  const rows = getDb()
    .prepare(`SELECT id, fields_json FROM items i
              WHERE state = 'done' AND vendor_key = ? AND accounting_ref IS NOT NULL
                AND json_extract(fields_json, '$.docType') = 'tax_invoice'
                AND NOT EXISTS (SELECT 1 FROM item_events e WHERE e.note = 'receipt_for:' || i.id)
              ORDER BY json_extract(fields_json, '$.issueDate') DESC, created_at DESC, rowid DESC`)
    .all(vendorKey) as { id: string; fields_json: string }[];
  const haystack = `${f.description ?? ''}\n${text ?? ''}`;
  let totalOnly: string | null = null;
  for (const row of rows) {
    const inv = JSON.parse(row.fields_json) as ExtractedFields;
    if (!inv.issueDate) continue;
    const age = (receiptAt - Date.parse(inv.issueDate)) / DAY_MS;
    if (!(age >= 0 && age <= WINDOW_DAYS)) continue;
    if (inv.docNumber && mentions(haystack, inv.docNumber)) return row.id;
    const sameTotal = inv.total !== null && f.total !== null && Math.abs(inv.total - f.total) <= 0.01;
    if (sameTotal && totalOnly === null) totalOnly = row.id;
  }
  return totalOnly;
}

/** A receipt may be dated a few days before its invoice (paid first, invoiced after). */
const EARLY_DAYS = 7;

/** How a receipt belongs to an invoice: it names the invoice number, or only the amounts agree; null if neither. */
function pairing(receipt: ExtractedFields, receiptText: string, inv: ExtractedFields): 'doc' | 'total' | null {
  if (!receipt.issueDate || !inv.issueDate) return null;
  const age = (Date.parse(receipt.issueDate) - Date.parse(inv.issueDate)) / DAY_MS;
  if (!(age >= -EARLY_DAYS && age <= WINDOW_DAYS)) return null;
  if (inv.docNumber && mentions(`${receipt.description ?? ''}\n${receiptText}`, inv.docNumber)) return 'doc';
  const sameCurrency = !receipt.currency || !inv.currency || receipt.currency === inv.currency;
  const sameTotal = inv.total !== null && receipt.total !== null && Math.abs(inv.total - receipt.total) <= 0.01;
  return sameTotal && sameCurrency && age >= 0 ? 'total' : null;
}

const NOT_PAIRED = `NOT EXISTS (SELECT 1 FROM item_events e WHERE e.note = 'receipt_for:' || i.id)`;

/**
 * The vendor's tax invoice (in any state but dismissed/ignored) that this receipt pays, so the receipt is not
 * filed or booked as a second expense. Each invoice takes one receipt; an invoice-number match beats an
 * amount-only match; ties go to the nearest earlier invoice.
 */
export function findInvoiceForReceipt(f: ExtractedFields, vendorKey: string, text: string, selfId: string): string | null {
  if (f.docType !== 'receipt' || !f.issueDate || Number.isNaN(Date.parse(f.issueDate))) return null;
  const rows = getDb()
    .prepare(`SELECT id, fields_json FROM items i
              WHERE vendor_key = ? AND id != ? AND state NOT IN ('dismissed', 'ignored')
                AND json_extract(fields_json, '$.docType') = 'tax_invoice' AND ${NOT_PAIRED}
              ORDER BY json_extract(fields_json, '$.issueDate') DESC, created_at DESC, rowid DESC`)
    .all(vendorKey, selfId) as { id: string; fields_json: string }[];
  let totalOnly: string | null = null;
  for (const row of rows) {
    const p = pairing(f, text, JSON.parse(row.fields_json) as ExtractedFields);
    if (p === 'doc') return row.id;
    if (p === 'total' && totalOnly === null) totalOnly = row.id;
  }
  return totalOnly;
}

/**
 * The reverse case: an invoice that arrived after its receipt. Returns the one receipt (if any) it pays among the
 * vendor's receipts that are still unfiled and unfinished, so it can be set aside before it is filed.
 */
export function findReceiptsForInvoice(inv: ExtractedFields, vendorKey: string, invoiceId: string): string[] {
  if (inv.docType !== 'tax_invoice' || !inv.issueDate || Number.isNaN(Date.parse(inv.issueDate))) return [];
  const db = getDb();
  const taken = db.prepare(`SELECT 1 FROM item_events WHERE note = ? LIMIT 1`).get(`receipt_for:${invoiceId}`);
  if (taken) return [];
  const rows = db
    .prepare(`SELECT id, fields_json, text FROM items r
              WHERE vendor_key = ? AND id != ? AND storage_path IS NULL
                AND state NOT IN ('done', 'ignored', 'dismissed', 'stored')
                AND json_extract(fields_json, '$.docType') = 'receipt'
                AND NOT EXISTS (SELECT 1 FROM item_events e WHERE e.item_id = r.id AND e.note LIKE 'receipt\\_for:%' ESCAPE '\\')
              ORDER BY json_extract(fields_json, '$.issueDate'), created_at, rowid`)
    .all(vendorKey, invoiceId) as { id: string; fields_json: string; text: string | null }[];
  let totalOnly: string | null = null;
  for (const row of rows) {
    const p = pairing(JSON.parse(row.fields_json) as ExtractedFields, row.text ?? '', inv);
    if (p === 'doc') return [row.id];
    if (p === 'total' && totalOnly === null) totalOnly = row.id;
  }
  return totalOnly ? [totalOnly] : [];
}
