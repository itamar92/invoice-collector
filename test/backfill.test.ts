import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { getItem, listItems } from '../server/core/items.js';
import { saveRecipe, setVendorCategory, setVendorStatus } from '../server/core/recipeStore.js';
import type { Recipe } from '../server/core/recipe.js';
import type { AccountingDestination, Deps, StorageDestination } from '../server/core/types.js';
import { IL_DEFAULTS } from '../server/defaults/il.js';
import { getSettings, updateSettings } from '../server/settings.js';
import { approveBackfill, backfillList, finishBackfill, markInterruptedBackfill, skipBackfill, startBackfill } from '../server/core/backfill.js';
import type { GmailMessage, GmailSource } from '../server/sources/gmail.js';

const NOW = new Date('2026-06-15T09:00:00Z');
const SETTINGS = { ...IL_DEFAULTS, storageRoot: '/Inv' };
beforeEach(() => { openDb(':memory:'); });

const pdfOf = (n: string, date = '05/06/2026') =>
  Buffer.from(`%PDF-synthetic\nDemo Widgets Ltd\nInvoice ${n}\nDate: ${date}\nTotal: 117.00`);
async function fakeExtract(pdf: Buffer) {
  const text = pdf.toString('utf8').replace(/^%PDF-synthetic\n/, '');
  return { text, pages: 1, isScan: false };
}
const recipe = (): Recipe => ({
  schemaVersion: 1, vendorKey: 'demo', displayName: 'Demo', match: { senders: ['billing@acme.example'] },
  fields: {
    vendorName: { kind: 'regex', pattern: '^(.+)$', flags: 'm', parse: 'text' },
    docType: { kind: 'const', value: 'tax_invoice' },
    docNumber: { kind: 'regex', pattern: 'Invoice (\\d+)', parse: 'text' },
    issueDate: { kind: 'regex', pattern: 'Date: (\\d{2}/\\d{2}/\\d{4})', parse: 'date', dateFormat: 'DD/MM/YYYY' },
    total: { kind: 'regex', pattern: 'Total: ([\\d.,]+)', parse: 'amount' },
    currency: { kind: 'const', value: 'ILS' },
  },
});
function setup(status: 'business' | 'personal' = 'business') {
  saveRecipe(recipe(), 'starter');
  setVendorStatus('demo', status);
  setVendorCategory('demo', 'תוכנות');
}
function fakeStorage(seed: Record<string, Buffer> = {}) {
  const files = new Map(Object.entries(seed));
  return {
    files,
    async exists(folder: string, filename: string, pdf: Buffer) {
      const f = files.get(`${folder}/${filename}`);
      return { exists: !!f, sameContent: !!f && f.equals(pdf) };
    },
    async put(folder: string, filename: string, pdf: Buffer) {
      const path = `${folder}/${filename}`;
      const existed = files.has(path);
      files.set(path, pdf);
      return { path, existed };
    },
  } as StorageDestination & { files: Map<string, Buffer> };
}
function fakeAccounting() {
  const a = { calls: 0, async send() { a.calls++; return { ref: 'x', mode: 'api_fields' as const }; } };
  return a satisfies AccountingDestination;
}
function mkDeps(storage: StorageDestination, accounting: AccountingDestination | null): Deps {
  return { storage, accounting, ai: null, settings: SETTINGS, now: () => NOW, extractText: fakeExtract };
}
function gmailWith(messages: Record<string, Buffer[]>, queries: { after: string; labelled: boolean }[] = []): GmailSource {
  const msg = (id: string): GmailMessage => ({
    id, threadId: `t${id}`, sender: 'billing@acme.example', subject: 's', receivedAt: '2026-03-01T00:00:00.000Z',
    pdfs: (messages[id] ?? []).map((data, i) => ({ name: `${i}.pdf`, data })), html: '', text: '',
  });
  return {
    listCandidateMessages: async (o) => { queries.push(o); return Object.keys(messages); },
    searchMessages: async () => [],
    fetchHeaders: async (id) => ({ id, sender: 's', subject: 's', receivedAt: '' }),
    fetchMessage: async (id) => {
      if (!messages[id]) throw new Error('gone');
      return msg(id);
    },
    markHandled: async () => {},
  };
}

test('startBackfill ingests as backfill, stops at approval, never touches storage or accounting', async () => {
  setup();
  const storage = fakeStorage();
  const acc = fakeAccounting();
  const queries: { after: string; labelled: boolean }[] = [];
  const gm = gmailWith({ m1: [pdfOf('1')], m2: [pdfOf('2')] }, queries);
  const orig = gm.listCandidateMessages;
  gm.listCandidateMessages = async (o) => [...await orig(o), 'missing']; // a failing fetch must not abort
  const r = await startBackfill(gm, mkDeps(storage, acc));
  assert.deepEqual(r, { emails: 2, items: 2, failed: 1 });
  assert.deepEqual(queries[0], { after: '2026/01/01', labelled: false });
  assert.equal(listItems({ state: 'awaiting_backfill_approval' }).length, 2);
  assert.equal(storage.files.size, 0);
  assert.equal(acc.calls, 0);
  assert.equal(getSettings().backfillDone, false);
  assert.equal(getSettings().backfillStartedAt, NOW.toISOString());
});

test('labelled is true when a gmail label is set', async () => {
  setup();
  updateSettings({ gmailLabel: 'invoices' });
  const queries: { after: string; labelled: boolean }[] = [];
  await startBackfill(gmailWith({}, queries), mkDeps(fakeStorage(), null));
  assert.equal(queries[0].labelled, true);
});

test('approved items are filed but never sent to accounting; unapproved are not filed', async () => {
  setup();
  const storage = fakeStorage();
  const acc = fakeAccounting();
  const d = mkDeps(storage, acc);
  await startBackfill(gmailWith({ m1: [pdfOf('1')], m2: [pdfOf('2')] }), d);
  const [a, b] = listItems({ state: 'awaiting_backfill_approval' });
  await approveBackfill([a.id, 'nope'], d);
  assert.equal(getItem(a.id)?.state, 'done');
  assert.equal(storage.files.size, 1);
  assert.equal(acc.calls, 0);
  assert.equal(getItem(b.id)?.state, 'awaiting_backfill_approval');
  // approving an already-done item is ignored
  await approveBackfill([a.id], d);
  assert.equal(storage.files.size, 1);
});

test('backfillList: proposed names, likelyDuplicate from storage, attention rows without names', async () => {
  setup();
  const d0 = mkDeps(fakeStorage(), null);
  await startBackfill(gmailWith({ m1: [pdfOf('1')], m2: [pdfOf('2', '06/06/2026')], m3: [] }), d0);
  const base = await backfillList(d0);
  assert.equal(base.length, 3);
  const withName = base.filter((r) => r.filename);
  assert.equal(withName.length, 2);
  assert.ok(withName[0].filename!.endsWith('.pdf'));
  assert.equal(withName[0].folder, '/Inv/2026/תוכנות');
  assert.equal(withName[0].vendor, 'Demo Widgets Ltd');
  assert.equal(withName[0].total, 117);
  assert.ok(withName.every((r) => !r.likelyDuplicate && r.state === 'awaiting_backfill_approval'));
  const att = base.find((r) => r.state === 'needs_attention')!;
  assert.equal(att.filename, null);
  assert.equal(att.folder, null);
  assert.equal(att.likelyDuplicate, false);

  const dup = withName[0];
  const d1 = mkDeps(fakeStorage({ [`${dup.folder}/${dup.filename}`]: Buffer.from('x') }), null);
  const again = await backfillList(d1);
  assert.equal(again.find((r) => r.id === dup.id)!.likelyDuplicate, true);
  assert.equal(again.find((r) => r.id === withName[1].id)!.likelyDuplicate, false);
});

test('skipBackfill dismisses only awaiting items; finishBackfill dismisses the rest and sets backfillDone', async () => {
  setup();
  const d = mkDeps(fakeStorage(), null);
  await startBackfill(gmailWith({ m1: [pdfOf('1')], m2: [pdfOf('2')], m3: [pdfOf('3')], m4: [] }), d);
  const awaiting = listItems({ state: 'awaiting_backfill_approval' });
  assert.equal(awaiting.length, 3);
  assert.equal(skipBackfill([awaiting[0].id, 'nope']), 1);
  assert.equal(getItem(awaiting[0].id)?.state, 'dismissed');
  assert.equal(skipBackfill([awaiting[0].id]), 0);
  assert.equal(finishBackfill(), 2);
  assert.equal(getSettings().backfillDone, true);
  assert.equal(listItems({ state: 'awaiting_backfill_approval' }).length, 0);
  assert.equal(listItems({ state: 'needs_attention' }).length, 1); // left alone
});

import { listIngestFailures } from '../server/core/ingestFailures.js';
import { retryIngestFailures } from '../server/core/backfill.js';

test('a failing fetch is recorded, the run continues, retry succeeds and clears; repeat failure counts attempts', async () => {
  setup();
  let broken = true;
  const base = gmailWith({ m1: [pdfOf('1')], m2: [pdfOf('2')] });
  const g: GmailSource = {
    ...base,
    fetchMessage: async (id) => { if (broken && id === 'm1') throw new Error('Gmail 503'); return base.fetchMessage(id); },
  };
  const d = mkDeps(fakeStorage(), null);
  const r = await startBackfill(g, d);
  assert.deepEqual(r, { emails: 1, items: 1, failed: 1 });
  const rows = listIngestFailures();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageId, 'm1');
  assert.equal(rows[0].mode, 'backfill');
  assert.equal(rows[0].attempts, 1);

  assert.deepEqual(await retryIngestFailures(g, d), { retried: 1, succeeded: 0 });
  assert.equal(listIngestFailures()[0].attempts, 2);

  broken = false;
  assert.deepEqual(await retryIngestFailures(g, d), { retried: 1, succeeded: 1 });
  assert.equal(listIngestFailures().length, 0);
  assert.equal(listItems({ messageId: 'm1' }).length, 1);
  assert.equal(listItems({ state: 'awaiting_backfill_approval' }).length, 2);
});

test('boot after a run that never finished marks it interrupted; finished or never-started runs are left alone', () => {
  updateSettings({ backfillStartedAt: '2026-06-15T08:00:00Z', backfillFinishedAt: null, backfillDone: false, backfillError: null });
  assert.equal(markInterruptedBackfill(), true);
  assert.equal(getSettings().backfillError, 'interrupted');
  updateSettings({ backfillError: null, backfillFinishedAt: '2026-06-15T09:00:00Z' });
  assert.equal(markInterruptedBackfill(), false);
  assert.equal(getSettings().backfillError, null);
  updateSettings({ backfillFinishedAt: null, backfillDone: true });
  assert.equal(markInterruptedBackfill(), false);
  updateSettings({ backfillStartedAt: null, backfillDone: false });
  assert.equal(markInterruptedBackfill(), false);
});
