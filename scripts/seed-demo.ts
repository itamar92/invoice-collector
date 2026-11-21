/**
 * Seeds a throwaway demo database for the UI preview. Synthetic data only: invented vendors, no real names,
 * tax ids, emails or amounts. Recreates DATA_DIR/app.db from scratch, so it refuses any DATA_DIR whose folder
 * name does not contain "demo" (it must never touch a real data folder).
 *
 *   SECRET_KEY=… DATA_DIR=./data-demo tsx scripts/seed-demo.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { setSecret } from '../server/secrets.js';
import { updateSettings } from '../server/settings.js';
import { createEmail, createItem, createPlaceholderItem, setItemFields, setItemVendor, transition, updateItem } from '../server/core/items.js';
import { compileRecipe } from '../server/core/recipe.js';
import { saveRecipe, setVendorCategory, setVendorStatus, upsertVendor } from '../server/core/recipeStore.js';
import type { VendorStatus } from '../server/core/recipeStore.js';
import { recordIngestFailure } from '../server/core/ingestFailures.js';
import type { ExtractedFields, ItemState, Reason } from '../server/core/types.js';
import { getDb } from '../server/db.js';

if (!process.env.SECRET_KEY) throw new Error('SECRET_KEY is not set');
const dataDir = path.resolve(process.env.DATA_DIR || './data-demo');
if (!path.basename(dataDir).includes('demo')) throw new Error(`refusing to seed ${dataDir}: folder name must contain "demo"`);
fs.mkdirSync(dataDir, { recursive: true });
const dbFile = path.join(dataDir, 'app.db');
for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
openDb(dbFile);

const year = new Date().getFullYear();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const dateAgo = (n: number) => daysAgo(n).slice(0, 10);

/** A tiny valid one-page PDF with ASCII text, so the item iframe has something to show. */
function demoPdf(title: string): Buffer {
  const text = title.replace(/[()\\]/g, '');
  const stream = `BT /F1 20 Tf 60 760 Td (Synthetic demo document) Tj 0 -30 Td /F1 14 Tf (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---------- settings + (fake) connections ----------
updateSettings({
  setupComplete: true,
  backfillDone: false,
  backfillStartedAt: daysAgo(1),
  gmailLabel: 'חשבוניות',
  storageRoot: '/חשבוניות',
  morning: { mode: 'api_file' }, // Morning id/secret left unset -> the "disconnected" banner shows
  ai: { mode: 'none' },
  lastTickAt: daysAgo(0.01),
  lastTickError: 'Dropbox 503: synthetic demo outage',
});
// Not real tokens: with no GOOGLE_/DROPBOX_ env set, the clients fail before any network call.
setSecret('gmail_refresh', 'demo-not-a-real-token');
setSecret('dropbox_refresh', 'demo-not-a-real-token');

// ---------- vendors ----------
const VENDORS: { key: string; name: string; status: VendorStatus; category?: string; sender: string }[] = [
  { key: 'demo-cell', name: 'סלולר לדוגמה', status: 'business', category: 'הוצאות טלפון נייד', sender: 'billing@demo-cell.example' },
  { key: 'demo-hosting', name: 'אחסון לדוגמה', status: 'business', category: 'תוכנה', sender: 'invoices@demo-hosting.example' },
  { key: 'demo-clinic', name: 'מרפאה לדוגמה', status: 'personal', category: 'עלויות אחרות', sender: 'office@demo-clinic.example' },
  { key: 'demo-newsletter', name: 'ניוזלטר לדוגמה', status: 'ignored', sender: 'news@demo-newsletter.example' },
  { key: 'demo-studio', name: 'אולפן לדוגמה', status: 'unreviewed', sender: 'pay@demo-studio.example' },
  { key: 'demo-print', name: 'דפוס לדוגמה', status: 'unreviewed', sender: 'print@demo-print.example' },
];
for (const v of VENDORS) {
  upsertVendor(v.key, v.name);
  setVendorStatus(v.key, v.status);
  if (v.category) setVendorCategory(v.key, v.category);
}
for (const v of VENDORS.slice(0, 2)) {
  saveRecipe(compileRecipe({
    schemaVersion: 1, vendorKey: v.key, displayName: v.name, match: { senders: [v.sender] },
    fields: {
      vendorName: { kind: 'const', value: v.name },
      currency: { kind: 'const', value: 'ILS' },
      total: { kind: 'regex', pattern: 'סה"כ לתשלום:\\s*([\\d.,]+)', parse: 'amount' },
    },
  }), 'ai');
}

// ---------- items ----------
let n = 0;
function fields(vendor: string, total: number | null, over: Partial<ExtractedFields> = {}): ExtractedFields {
  const vat = total === null ? null : Math.round((total * 18) / 118 * 100) / 100;
  return {
    vendorName: vendor, vendorTaxId: null, docType: 'tax_invoice', docNumber: String(5000 + n), issueDate: dateAgo(10 + n),
    total, vat, net: total === null || vat === null ? null : Math.round((total - vat) * 100) / 100, currency: 'ILS',
    allocationNumber: null, description: 'שירות חודשי', category: null, ...over,
  };
}

function seedItem(opts: {
  vendor: (typeof VENDORS)[number]; state: ItemState; reason?: Reason; total?: number | null; mode?: 'ongoing' | 'backfill';
  over?: Partial<ExtractedFields>; worth?: boolean; storagePath?: string; accounting?: boolean;
}): string {
  n++;
  const msgId = `demo-msg-${n}`;
  createEmail({
    messageId: msgId, threadId: `demo-thread-${n}`, sender: opts.vendor.sender, subject: `חשבונית מס ${5000 + n}`,
    receivedAt: daysAgo(10 + n), mode: opts.mode ?? 'ongoing',
  });
  const { id } = createItem(msgId, `invoice-${5000 + n}.pdf`, demoPdf(`Invoice ${5000 + n} - ${opts.vendor.key}`));
  setItemVendor(id, opts.vendor.key);
  if (opts.total !== undefined || opts.over) {
    const category = opts.vendor.category ?? null;
    setItemFields(id, fields(opts.vendor.name, opts.total ?? null, { category, ...opts.over }), 'recipe');
  }
  if (opts.state !== 'queued') transition(id, opts.state, opts.reason, 'demo_seed');
  if (opts.storagePath) updateItem(id, { storagePath: opts.storagePath });
  if (opts.accounting) updateItem(id, { accountingRef: `demo-ref-${n}`, accountingMode: 'api_file' });
  if (opts.worth) updateItem(id, { recipeFailed: true });
  return id;
}

const [cell, hosting, clinic, newsletter, studio, print] = VENDORS;
seedItem({ vendor: cell, state: 'queued' });
seedItem({ vendor: hosting, state: 'waiting_ai' });
seedItem({ vendor: cell, state: 'needs_attention', reason: 'missing_total', total: null });
seedItem({ vendor: hosting, state: 'needs_attention', reason: 'vat_mismatch', total: 236, over: { vat: 50 } });
seedItem({ vendor: cell, state: 'needs_attention', reason: 'storage_error', total: 118 });
seedItem({ vendor: studio, state: 'awaiting_vendor', reason: 'new_vendor', total: 590 });
seedItem({ vendor: studio, state: 'awaiting_vendor', reason: 'new_vendor', total: 354 });
seedItem({ vendor: print, state: 'awaiting_vendor', reason: 'new_vendor', total: 82.6 });
seedItem({ vendor: cell, state: 'awaiting_backfill_approval', total: 99.9, mode: 'backfill', over: { issueDate: `${year}-01-12` } });
seedItem({ vendor: hosting, state: 'awaiting_backfill_approval', total: 47.2, mode: 'backfill', over: { issueDate: `${year}-02-03` } });
seedItem({ vendor: clinic, state: 'awaiting_backfill_approval', total: 250, mode: 'backfill', over: { issueDate: `${year}-02-20`, vat: 0, net: 250 } });
seedItem({ vendor: hosting, state: 'ready', total: 59 });
seedItem({ vendor: cell, state: 'stored', total: 120.5, storagePath: `/חשבוניות/${year}/טלפון/demo.pdf` });
seedItem({ vendor: hosting, state: 'done', total: 47.2, storagePath: `/חשבוניות/${year}/תוכנות/demo.pdf`, accounting: true, worth: true });
seedItem({ vendor: cell, state: 'done', total: 99.9, storagePath: `/חשבוניות/${year}/טלפון/demo-2.pdf`, accounting: true });
// A spread of filed documents over the year, so the dashboard has something to show.
const FILED: [(typeof VENDORS)[number], number, string | undefined][] = [
  [cell, 99.9, undefined], [hosting, 47.2, undefined], [clinic, 320, undefined], [cell, 104.5, undefined],
  [hosting, 47.2, 'ציוד לעסק'], [cell, 99.9, undefined], [hosting, 189, 'פרסום וקידום מכירות'], [clinic, 180, undefined],
  [cell, 112.3, undefined], [hosting, 47.2, undefined], [hosting, 640, 'ציוד לעסק'], [cell, 99.9, undefined],
  [hosting, 47.2, undefined], [cell, 99.9, undefined], [hosting, 75, undefined],
];
const thisMonth = new Date().getMonth() + 1;
FILED.forEach(([vendor, total, category], i) => {
  const month = String((i % thisMonth) + 1).padStart(2, '0');
  seedItem({
    vendor, state: vendor.status === 'business' ? 'done' : 'stored', total, accounting: vendor.status === 'business',
    storagePath: `/חשבוניות/${year}/${category ?? vendor.category}/demo-${i}.pdf`,
    over: { issueDate: `${year}-${month}-${String(3 + (i % 20)).padStart(2, '0')}`, ...(category ? { category } : {}), ...(i === 6 ? { category: null } : {}) },
  });
});
seedItem({ vendor: newsletter, state: 'ignored' });
seedItem({ vendor: clinic, state: 'dismissed', total: 180 });

// An email with no PDF and no link: a placeholder item.
createEmail({ messageId: 'demo-msg-nodoc', threadId: 'demo-thread-nodoc', sender: 'hello@demo-shop.example', subject: 'תודה על ההזמנה', receivedAt: daysAgo(3), mode: 'ongoing' });
createPlaceholderItem('demo-msg-nodoc', 'no_document');

// ---------- missed + ingest failure ----------
getDb().prepare(`INSERT INTO missed (message_id, sender, subject, received_at, found_at, status) VALUES (?, ?, ?, ?, ?, ?)`)
  .run('demo-missed-1', 'receipts@demo-parking.example', 'קבלה על תשלום חניה', daysAgo(5), daysAgo(1), 'open');
getDb().prepare(`INSERT INTO missed (message_id, sender, subject, received_at, found_at, status) VALUES (?, ?, ?, ?, ?, ?)`)
  .run('demo-missed-2', 'billing@demo-cloud.example', 'Your invoice is ready', daysAgo(8), daysAgo(1), 'hidden');
recordIngestFailure('demo-msg-broken', 'ongoing', new Error('Gmail 500: synthetic demo failure'));

const count = (q: string) => getDb().prepare(q).pluck().get() as number;
console.log(`seeded ${dbFile}: ${count('SELECT COUNT(*) FROM items')} items, ${count('SELECT COUNT(*) FROM vendors')} vendors, ` +
  `attention=${count(`SELECT COUNT(*) FROM items WHERE state IN ('needs_attention','awaiting_vendor')`) + 1}`);
