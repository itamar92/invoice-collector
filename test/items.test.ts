import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, getDb } from '../server/db.js';
import {
  createEmail, getEmail, createItem, createPlaceholderItem, transition, getItem, listItems,
  isTerminal, setItemFields, setItemVendor, setItemText, updateItem,
} from '../server/core/items.js';
import { findReceiptForSentInvoice, markReceiptFor } from '../server/core/dedupe.js';
import { TERMINAL_STATES, type ExtractedFields } from '../server/core/types.js';

function fields(over: Partial<ExtractedFields> = {}): ExtractedFields {
  return {
    vendorName: 'Demo Ltd', vendorTaxId: null, docType: 'tax_invoice', docNumber: '1001', issueDate: '2026-03-05',
    total: 117, vat: 17, net: 100, currency: 'ILS', allocationNumber: null, description: null, category: null, ...over,
  };
}
const events = (id: string) =>
  getDb().prepare('SELECT * FROM item_events WHERE item_id = ? ORDER BY id').all(id) as
    { from_state: string | null; to_state: string; note: string | null }[];

beforeEach(() => {
  openDb(join(mkdtempSync(join(tmpdir(), 'ic-items-')), 't.db'));
  createEmail({ messageId: 'm1', threadId: 't1', sender: 'a@b.co', subject: 's', receivedAt: '2026-03-05T10:00:00Z', mode: 'ongoing' });
});

test('email insert-or-ignore and get', () => {
  createEmail({ messageId: 'm1', threadId: 'x', sender: 'z', subject: 'z', receivedAt: 'z', mode: 'manual' });
  const e = getEmail('m1');
  assert.equal(e?.threadId, 't1');
  assert.equal(e?.mode, 'ongoing');
  assert.equal(e?.gmailMarked, false);
  assert.equal(getEmail('nope'), undefined);
});

test('same PDF twice: second is dismissed/duplicate with note and null sha256', () => {
  const pdf = Buffer.from('%PDF-1 synthetic');
  const a = createItem('m1', 'a.pdf', pdf);
  assert.equal(a.duplicateOf, undefined);
  assert.equal(getItem(a.id)?.state, 'queued');
  const b = createItem('m1', 'b.pdf', pdf);
  assert.equal(b.duplicateOf, a.id);
  const it = getItem(b.id);
  assert.equal(it?.state, 'dismissed');
  assert.equal(it?.reason, 'duplicate');
  assert.equal(it?.sha256, null);
  assert.deepEqual(events(b.id).map((e) => e.note), [`duplicate_of:${a.id}`]);
});

test('every transition writes an event; unknown id throws', () => {
  const { id } = createItem('m1', 'a.pdf', Buffer.from('x'));
  transition(id, 'waiting_ai', 'no_recipe_no_ai', 'n1');
  transition(id, 'ready');
  const ev = events(id);
  assert.equal(ev.length, 3);
  assert.deepEqual(ev.slice(1).map((e) => [e.from_state, e.to_state, e.note]),
    [['queued', 'waiting_ai', 'n1'], ['waiting_ai', 'ready', null]]);
  assert.equal(getItem(id)?.reason, null);
  assert.throws(() => transition('nope', 'ready'));
});

test('terminal states helper', () => {
  assert.deepEqual([...TERMINAL_STATES], ['done', 'ignored', 'dismissed']);
  assert.equal(isTerminal('done'), true);
  assert.equal(isTerminal('stored'), false);
});

test('placeholder item has no pdf and needs attention', () => {
  const id = createPlaceholderItem('m1', 'link_failed');
  const it = getItem(id);
  assert.equal(it?.state, 'needs_attention');
  assert.equal(it?.reason, 'link_failed');
  assert.equal(it?.hasPdf, false);
  assert.equal(it?.sha256, null);
});

test('listItems filters by state, message, q, paging', () => {
  const a = createItem('m1', 'alpha.pdf', Buffer.from('1')).id;
  const b = createItem('m1', 'beta.pdf', Buffer.from('2')).id;
  transition(b, 'done');
  assert.deepEqual(listItems({ state: 'done' }).map((i) => i.id), [b]);
  assert.equal(listItems({ state: ['done', 'queued'] }).length, 2);
  assert.equal(listItems({ messageId: 'other' }).length, 0);
  assert.deepEqual(listItems({ q: 'alph' }).map((i) => i.id), [a]);
  assert.equal(listItems({ limit: 1 }).length, 1);
  assert.equal(listItems({ limit: 1, offset: 1 }).length, 1);
});

test('listItems excludeState leaves out ignored and dismissed', () => {
  const a = createItem('m1', 'a.pdf', Buffer.from('1')).id;
  const b = createItem('m1', 'b.pdf', Buffer.from('2')).id;
  const c = createItem('m1', 'c.pdf', Buffer.from('3')).id;
  transition(b, 'ignored');
  transition(c, 'dismissed');
  assert.deepEqual(listItems({ excludeState: ['ignored', 'dismissed'] }).map((i) => i.id), [a]);
  assert.equal(listItems({}).length, 3);
});

test('thin setters and updateItem', () => {
  const { id } = createItem('m1', 'a.pdf', Buffer.from('x'));
  setItemText(id, 'hello');
  setItemVendor(id, 'demo');
  setItemFields(id, fields(), 'recipe');
  updateItem(id, { storagePath: '/p', accountingRef: 'r1', accountingMode: 'm', attempts: 2, nextAttemptAt: 't', recipeFailed: true });
  const it = getItem(id);
  assert.equal(it?.text, 'hello');
  assert.equal(it?.vendorKey, 'demo');
  assert.equal(it?.fields?.docNumber, '1001');
  assert.equal(it?.provenance, 'recipe');
  assert.deepEqual([it?.storagePath, it?.accountingRef, it?.accountingMode, it?.attempts, it?.nextAttemptAt, it?.recipeFailed],
    ['/p', 'r1', 'm', 2, 't', true]);
});

test('same vendor+docNumber+docType: second item is dismissed as duplicate naming the original', () => {
  const a = createItem('m1', 'a.pdf', Buffer.from('1')).id;
  const b = createItem('m1', 'b.pdf', Buffer.from('2')).id;
  setItemVendor(a, 'demo'); setItemFields(a, fields(), 'ai');
  setItemVendor(b, 'demo'); setItemFields(b, fields(), 'ai');
  assert.equal(getItem(a)?.state, 'queued');
  const it = getItem(b);
  assert.equal(it?.state, 'dismissed');
  assert.equal(it?.reason, 'duplicate');
  assert.ok(events(b).some((e) => e.note === `duplicate_of:${a}`));
  // different docType or vendor does not collide
  const c = createItem('m1', 'c.pdf', Buffer.from('3')).id;
  setItemVendor(c, 'demo'); setItemFields(c, fields({ docType: 'receipt' }), 'ai');
  assert.equal(getItem(c)?.state, 'queued');
});

test('collision when vendor is set after fields', () => {
  const a = createItem('m1', 'a.pdf', Buffer.from('1')).id;
  const b = createItem('m1', 'b.pdf', Buffer.from('2')).id;
  setItemFields(a, fields(), 'ai'); setItemVendor(a, 'demo');
  setItemFields(b, fields(), 'ai'); setItemVendor(b, 'demo');
  assert.equal(getItem(b)?.state, 'dismissed');
  assert.ok(events(b).some((e) => e.note === `duplicate_of:${a}`));
});

function sentInvoice(vendor: string, over: Partial<ExtractedFields>, ref: string | null = 'acc-1'): string {
  const id = createItem('m1', 'i.pdf', Buffer.from(`inv-${vendor}-${JSON.stringify(over)}`)).id;
  setItemVendor(id, vendor);
  setItemFields(id, fields(over), 'ai');
  updateItem(id, { accountingRef: ref });
  transition(id, 'done');
  return id;
}
const receipt = (over: Partial<ExtractedFields> = {}) =>
  fields({ docType: 'receipt', docNumber: 'R7', issueDate: '2026-03-20', ...over });

test('findReceiptForSentInvoice: matches by total, by docNumber in description/text', () => {
  const inv = sentInvoice('demo', {});
  assert.equal(findReceiptForSentInvoice(receipt(), 'demo'), inv);
  assert.equal(findReceiptForSentInvoice(receipt({ total: 5 }), 'demo'), null);
  assert.equal(findReceiptForSentInvoice(receipt({ total: 5, description: 'for invoice 1001' }), 'demo'), inv);
  assert.equal(findReceiptForSentInvoice(receipt({ total: 5 }), 'demo', 'ref 1001'), inv);
  assert.equal(findReceiptForSentInvoice(receipt({ total: 117.005 }), 'demo'), inv);
});

test('findReceiptForSentInvoice: other vendor, non-receipt, window, unsent, not done', () => {
  const inv = sentInvoice('demo', {});
  assert.equal(findReceiptForSentInvoice(receipt(), 'other'), null);
  assert.equal(findReceiptForSentInvoice(receipt({ docType: 'tax_invoice' }), 'demo'), null);
  assert.equal(findReceiptForSentInvoice(receipt({ issueDate: '2026-08-01' }), 'demo'), null); // > 120 days
  assert.equal(findReceiptForSentInvoice(receipt({ issueDate: '2026-03-01' }), 'demo'), null); // before invoice
  assert.equal(findReceiptForSentInvoice(receipt({ issueDate: '2026-07-03' }), 'demo'), inv); // day 120
  sentInvoice('v2', { docNumber: '2' }, null);
  assert.equal(findReceiptForSentInvoice(receipt(), 'v2'), null);
  const q = createItem('m1', 'q.pdf', Buffer.from('q')).id;
  setItemVendor(q, 'v3'); setItemFields(q, fields(), 'ai'); updateItem(q, { accountingRef: 'x' });
  assert.equal(findReceiptForSentInvoice(receipt(), 'v3'), null);
});

test('docNumber match needs token boundaries', () => {
  const one = sentInvoice('b1', { docNumber: '1', total: 50 });
  assert.equal(findReceiptForSentInvoice(receipt({ total: 5, description: 'date 2026-03-10' }), 'b1'), null);
  assert.equal(findReceiptForSentInvoice(receipt({ total: 5, description: 'invoice 1.' }), 'b1'), one);
  const inv = sentInvoice('b2', { docNumber: '1001' });
  assert.equal(findReceiptForSentInvoice(receipt({ total: 5, description: 'ref 21001' }), 'b2'), null);
  assert.equal(findReceiptForSentInvoice(receipt({ total: 5 }), 'b2', 'קבלה עבור חשבונית 1001.'), inv);
});

test('collision dismissal is one event, with note', () => {
  const a = createItem('m1', 'a.pdf', Buffer.from('1')).id;
  const b = createItem('m1', 'b.pdf', Buffer.from('2')).id;
  setItemVendor(a, 'demo'); setItemFields(a, fields(), 'ai');
  setItemVendor(b, 'demo'); setItemFields(b, fields(), 'ai');
  assert.deepEqual(events(b).map((e) => [e.from_state, e.to_state, e.note]),
    [[null, 'queued', null], ['queued', 'dismissed', `duplicate_of:${a}`]]);
  assert.equal(getItem(b)?.fields?.docNumber, '1001');
});

test('each invoice absorbs one receipt; docNumber beats total-only; ties pick most recent', () => {
  const inv = sentInvoice('c1', {});
  const r1 = createItem('m1', 'r1.pdf', Buffer.from('r1')).id;
  assert.equal(findReceiptForSentInvoice(receipt(), 'c1'), inv);
  markReceiptFor(r1, inv);
  assert.ok(events(r1).some((e) => e.note === `receipt_for:${inv}`));
  assert.equal(findReceiptForSentInvoice(receipt(), 'c1'), null);

  const old = sentInvoice('c2', { docNumber: '10', total: 117, issueDate: '2026-02-01' });
  const num = sentInvoice('c2', { docNumber: '20', total: 300, issueDate: '2026-02-10' });
  assert.equal(findReceiptForSentInvoice(receipt({ total: 117, description: 'inv 20' }), 'c2'), num);
  const newer = sentInvoice('c2', { docNumber: '30', total: 117, issueDate: '2026-03-01' });
  assert.equal(findReceiptForSentInvoice(receipt({ total: 117 }), 'c2'), newer);
  assert.notEqual(old, newer);
});
