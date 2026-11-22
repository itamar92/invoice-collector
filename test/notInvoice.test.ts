import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, openDb } from '../server/db.js';
import { createEmail, createItem, setItemFields, setItemText, setItemVendor, transition } from '../server/core/items.js';
import { isOwnDocument, notInvoiceKind, suggestOwnTaxIds } from '../server/core/notInvoice.js';
import { senderKey, suggestFilter } from '../server/core/labelSuggest.js';
import { knownVendorSenders, saveRecipe, setVendorStatus, upsertVendor } from '../server/core/recipeStore.js';
import { INVOICE_QUERY, invoiceQuery } from '../server/sources/gmail.js';
import type { ExtractedFields } from '../server/core/types.js';

beforeEach(() => { openDb(':memory:'); });

test('notInvoiceKind: quotes and insurance papers without a tax-document word', () => {
  assert.equal(notInvoiceKind('הצעת מחיר מס\' 12\nסה"כ 500'), 'quote');
  assert.equal(notInvoiceKind('Quotation #44\nTotal 500'), 'quote');
  assert.equal(notInvoiceKind('הראל ביטוח\nפוליסה 778899\nרשימת הביטוח'), 'insurance');
  assert.equal(notInvoiceKind('חשבונית מס 100\nבהתאם להצעת מחיר 12'), null);
  assert.equal(notInvoiceKind('קבלה 55\nתשלום פוליסה 778899'), null);
  assert.equal(notInvoiceKind('Invoice 9\nper quote 12'), null);
  assert.equal(notInvoiceKind('חשבון תקופתי\nסה"כ 100'), null);
  // only the title area counts: a quote mentioned deep in a long document is no title
  assert.equal(notInvoiceKind(`${'x'.repeat(2000)}\nהצעת מחיר`), null);
});

test('isOwnDocument compares digits only', () => {
  const f = { vendorTaxId: '51-234567-8' } as ExtractedFields;
  assert.equal(isOwnDocument(f, { ownTaxIds: ['512345678'] }), true);
  assert.equal(isOwnDocument(f, { ownTaxIds: ['999999999'] }), false);
  assert.equal(isOwnDocument({ vendorTaxId: null }, { ownTaxIds: ['512345678'] }), false);
  assert.equal(isOwnDocument(f, { ownTaxIds: [] }), false);
});

test('unlabelled query: tax-document words, known vendor senders, quotes and insurance left out', () => {
  assert.equal(invoiceQuery([]), INVOICE_QUERY);
  saveRecipe({
    schemaVersion: 1, vendorKey: 'partner', displayName: 'P', match: { senders: ['thankyou@partner.net.il', '*@bug.co.il'] },
    fields: { total: { kind: 'regex', pattern: 'Total: ([\\d.]+)', parse: 'amount' } },
  }, 'starter');
  saveRecipe({
    schemaVersion: 1, vendorKey: 'spam', displayName: 'S', match: { senders: ['news@spam.example'] },
    fields: { total: { kind: 'regex', pattern: 'Total: ([\\d.]+)', parse: 'amount' } },
  }, 'starter');
  upsertVendor('spam', 'S');
  setVendorStatus('spam', 'ignored');
  assert.deepEqual(knownVendorSenders(), ['thankyou@partner.net.il', 'bug.co.il']);
  const q = invoiceQuery(knownVendorSenders());
  assert.match(q, /^\("חשבונית מס" OR "קבלה" OR "tax invoice" OR invoice OR receipt OR from:\(thankyou@partner\.net\.il OR bug\.co\.il\)\) /);
  assert.ok(q.includes('-subject:"הצעת מחיר"'));
});

let n = 0;
function email(sender: string, subject: string, o: { vendor?: string; state?: 'done' | 'ignored'; taxId?: string; text?: string } = {}) {
  const id = `e${++n}`;
  createEmail({ messageId: id, threadId: id, sender, subject, receivedAt: '2026-03-01T00:00:00Z', mode: 'backfill' });
  const { id: item } = createItem(id, 'a.pdf', Buffer.from(`%PDF ${id}`));
  const vendor = o.vendor ?? senderKey(sender);
  upsertVendor(vendor, vendor);
  setItemVendor(item, vendor);
  setItemFields(item, { vendorTaxId: o.taxId ?? null } as ExtractedFields, 'ai');
  if (o.text) setItemText(item, o.text);
  transition(item, o.state ?? 'done');
  return item;
}

test('senderKey: registrable domain, whole address for free mail', () => {
  assert.equal(senderKey('billing@mail.partner.net.il'), 'partner.net.il');
  assert.equal(senderKey('no-reply@stripe.com'), 'stripe.com');
  assert.equal(senderKey('Someone@Gmail.com'), 'someone@gmail.com');
});

test('suggestFilter: a few subject words, then only the senders they miss; noise counted', () => {
  assert.equal(suggestFilter().query, '');
  email('a@one.co.il', 'חשבונית מס 1');
  email('b@two.com', 'חשבונית מס 2');
  email('c@three.com', 'Your receipt from Three');
  email('c@three.com', 'Receipt #2');
  email('d@four.com', 'Receipt #3');
  email('billing@partner.net.il', 'החשבון החודשי שלך');
  email('x@iec.co.il', 'הודעה על תשלום');
  email('promo@shop.com', 'Receipt of your order? no: a newsletter', { state: 'ignored' });
  const s = suggestFilter();
  assert.deepEqual(s.subjects.map((x) => x.term).sort(), ['receipt', 'חשבונית מס']);
  assert.deepEqual(s.senders.map((x) => x.sender).sort(), ['iec.co.il', 'partner.net.il']);
  assert.equal(s.invoices, 7);
  assert.equal(s.noise, 1);
  assert.match(s.query, /^\{subject:\(.+\) from:\(.+\)\} -subject:/);
  assert.ok(s.query.includes('"חשבונית מס"'));
});

test('suggestOwnTaxIds: a 9-digit id on documents of 3+ vendors that is no vendor\'s own', () => {
  const me = 'לכבוד: הסטודיו שלי ע.מ 312345678';
  email('a@one.co.il', 's', { text: `ספק א ח.פ 511111111\n${me}`, taxId: '511111111' });
  email('b@two.co.il', 's', { text: `ספק ב ח.פ 522222222\n${me}\nטל 035551234`, taxId: '522222222' });
  email('c@three.co.il', 's', { text: `ספק ג\n${me}\nטל 035551234\n511111111` });
  email('d@four.co.il', 's', { text: 'טל 035551234' });
  assert.deepEqual(suggestOwnTaxIds(), [{ taxId: '312345678', vendors: 3 }]);
  assert.equal(getDb().prepare('SELECT COUNT(*) FROM items').pluck().get(), 4);
});
