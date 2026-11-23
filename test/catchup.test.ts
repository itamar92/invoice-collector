import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshAccounts, TEST_EMAIL } from './helpers.js';
import { openDb } from '../server/db.js';
import { listCatchup } from '../server/core/catchup.js';
import { createApp } from '../server/app.js';
import type { ApiContext } from '../server/routes.js';
import { resetLoginLimiter } from '../server/auth.js';
import { createEmail, createItem, getItem, setItemFields, setItemVendor, transition, updateItem } from '../server/core/items.js';
import { setVendorStatus, upsertVendor } from '../server/core/recipeStore.js';
import { getSettings, updateSettings } from '../server/settings.js';
import { setSecret } from '../server/secrets.js';
import { MorningLookup, type MorningMatch } from '../server/destinations/morning.js';
import type { AccountingDestination, Deps, ExtractedFields } from '../server/core/types.js';
import type { GmailSource } from '../server/sources/gmail.js';

process.env.SECRET_KEY = 'test-key-for-unit-tests-only-0123456789';
process.env.APP_PASSWORD = 'correct horse';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });
beforeEach(() => { openDb(':memory:'); freshAccounts(); resetLoginLimiter(); });

const CAT = () => getSettings().categories[0].name;
const FIELDS = (): ExtractedFields => ({
  vendorName: 'ספק', vendorTaxId: '512345678', docType: 'tax_invoice', docNumber: '0042', issueDate: '2026-03-01',
  total: 118, vat: 18, net: 100, currency: 'ILS', allocationNumber: null, description: null, category: CAT(),
});

/** A filed item that the pipeline finished without booking, as it does for the first import. */
function filed(tag: string, f: Partial<ExtractedFields> = {}, note = 'backfill_no_accounting', vendorStatus: 'business' | 'personal' = 'business') {
  createEmail({ messageId: `m-${tag}`, threadId: 't', sender: 's@x.com', subject: 's', receivedAt: '2026-03-01T00:00:00Z', mode: 'backfill' });
  const { id } = createItem(`m-${tag}`, `${tag}.pdf`, Buffer.from(`%PDF-1.4 ${tag}`));
  setItemFields(id, { ...FIELDS(), docNumber: tag, ...f }, 'ai');
  const key = `v-${tag}`;
  upsertVendor(key, 'ספק');
  setVendorStatus(key, vendorStatus);
  setItemVendor(id, key);
  updateItem(id, { storagePath: `/2026/${tag}.pdf` });
  transition(id, 'done', undefined, note);
  return id;
}

async function boot(over: Partial<ApiContext> & { accounting?: AccountingDestination | null } = {}) {
  const accounting = over.accounting === undefined ? null : over.accounting;
  const deps = (): Deps => ({
    storage: { exists: async () => ({ exists: false, sameContent: false }), put: async (f, n) => ({ path: `${f}/${n}`, existed: false }) },
    accounting, ai: null, settings: getSettings(), now: () => new Date('2026-06-15T09:00:00Z'),
  });
  const ctx: ApiContext = { getDeps: () => ({ deps: deps(), gmail: {} as GmailSource }), now: () => new Date('2026-06-15T09:00:00Z'), ...over };
  const s = await new Promise<Server>((r) => { const x = createApp(ctx).listen(0, '127.0.0.1', () => r(x)); });
  servers.push(s);
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: TEST_EMAIL, password: 'correct horse' }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  return async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
}

const lookupOf = (by: Record<string, MorningMatch['status']>) => ({
  find: async (f: ExtractedFields): Promise<MorningMatch> => {
    const status = by[f.docNumber ?? ''] ?? 'not_found';
    return status === 'found' || status === 'maybe' ? { status, where: 'expense', morningId: `exp-${f.docNumber}` } : { status };
  },
});

test('catch-up lists filed, unsent business documents only', async () => {
  updateSettings({ morning: { ...getSettings().morning, mode: 'api_file' } });
  const a = filed('a');
  const b = filed('b', {}, 'accounting_not_configured');
  filed('c', {}, 'vendor_personal', 'personal'); // personal vendor: never sent
  filed('d', {}, 'category_not_sent'); // category not booked
  const e = filed('e');
  updateItem(e, { accountingRef: 'ref' }); // already sent
  const call = await boot({ morningLookup: () => lookupOf({}) });
  const r = await call('GET', '/api/morning/catchup');
  assert.deepEqual(r.body.rows.map((x: any) => x.id).sort(), [a, b].sort());
  assert.equal(r.body.rows.find((x: any) => x.id === b).why, 'not_configured');
  assert.equal(r.body.canCheck, true);
});

test('catch-up check reports what Morning holds; send skips what it already has and records the rest', async () => {
  updateSettings({ morning: { ...getSettings().morning, mode: 'api_file' } });
  const there = filed('there');
  const missing = filed('missing');
  const maybe = filed('maybe');
  const sends: string[] = [];
  const accounting: AccountingDestination = { send: async (i) => { sends.push(i.fields.docNumber!); return { ref: `ref-${i.fields.docNumber}`, mode: 'api_file' }; } };
  const call = await boot({ accounting, morningLookup: () => lookupOf({ there: 'found', maybe: 'maybe' }) });

  const checked = await call('POST', '/api/morning/catchup/check', { ids: [there, missing, maybe] });
  assert.deepEqual(checked.body.results.map((x: any) => x.status), ['found', 'not_found', 'maybe']);

  const sent = await call('POST', '/api/morning/catchup/send', { ids: [there, missing, maybe] });
  assert.deepEqual(sent.body.results.map((x: any) => x.outcome), ['in_morning', 'sent', 'sent']);
  assert.deepEqual(sends, ['missing', 'maybe']); // the found one was never uploaded
  assert.equal(getItem(missing)!.accountingRef, 'ref-missing');
  assert.equal(getItem(there)!.accountingRef, 'expense:exp-there');
  assert.equal(getItem(there)!.state, 'done');
  assert.deepEqual((await call('GET', '/api/morning/catchup')).body.rows, []);
  // A second send of the same ids does nothing: they are no longer candidates.
  assert.deepEqual((await call('POST', '/api/morning/catchup/send', { ids: [missing] })).body.results, []);
});

test('catch-up send stops a document whose Morning lookup fails, and refuses without Morning', async () => {
  const id = filed('x');
  const accounting: AccountingDestination = { send: async () => { throw new Error('must not send'); } };
  let call = await boot({ accounting, morningLookup: () => ({ find: async () => { throw new Error('Morning 503'); } }) });
  assert.equal((await call('POST', '/api/morning/catchup/send', { ids: [id] })).status, 409); // mode not set
  updateSettings({ morning: { ...getSettings().morning, mode: 'api_file' } });
  const r = await call('POST', '/api/morning/catchup/send', { ids: [id] });
  assert.equal(r.body.results[0].outcome, 'failed');
  assert.equal(getItem(id)!.accountingRef, null);
  call = await boot({ accounting, morningLookup: () => null });
  assert.equal((await call('POST', '/api/morning/catchup/check', { ids: [id] })).status, 409);
});

test('catch-up mark: in Morning and skipped both leave the list; batches are capped', async () => {
  updateSettings({ morning: { ...getSettings().morning, mode: 'api_file' } });
  const a = filed('a');
  const b = filed('b');
  const call = await boot({ morningLookup: () => lookupOf({}) });
  assert.equal((await call('POST', '/api/morning/catchup/mark', { ids: [a], as: 'in_morning', refs: { [a]: { where: 'draft', morningId: 'd1' } } })).body.changed, 1);
  assert.equal(getItem(a)!.accountingRef, 'draft:d1');
  assert.equal((await call('POST', '/api/morning/catchup/mark', { ids: [b], as: 'skipped' })).body.changed, 1);
  assert.equal(getItem(b)!.accountingRef, null);
  assert.deepEqual((await call('GET', '/api/morning/catchup')).body.rows, []);
  assert.equal((await call('POST', '/api/morning/catchup/check', { ids: Array.from({ length: 26 }, (_, i) => `x${i}`) })).status, 400);
});

// ---------- MorningLookup against a fake Morning ----------

function morning(expenses: unknown[], drafts: unknown[]) {
  const calls: { path: string; body: any }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body });
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    if (path.endsWith('/idp/v1/oauth/token')) return json({ accessToken: 'T', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    if (path.endsWith('/expenses/search')) return json({ items: expenses, pages: 1 });
    if (path.endsWith('/expenses/drafts/search')) return json({ items: drafts, pages: 1 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { lookup: new MorningLookup({ fetchImpl, now: () => new Date('2026-06-15T00:00:00Z') }), calls };
}

test('MorningLookup: number, amount and supplier → found; two of three → maybe; deleted and declined do not count', async () => {
  setSecret('morning_id', 'id'); setSecret('morning_secret', 'sec');
  const f = { ...FIELDS(), docNumber: '0042', category: 'x' };
  const exact = { id: 'e1', status: 10, number: '42', amount: 118, supplier: { name: 'Other name', taxId: '512345678' }, date: '2026-03-01' };
  let m = morning([exact], []);
  assert.deepEqual(await m.lookup.find(f), { status: 'found', where: 'expense', morningId: 'e1', seen: { number: '42', amount: 118, supplier: 'Other name', date: '2026-03-01' } });
  assert.equal(m.calls.find((c) => c.path.endsWith('/expenses/search'))!.body.number, '0042');

  m = morning([{ ...exact, supplier: { name: 'OCR typo' } }], []);
  assert.equal((await m.lookup.find(f)).status, 'maybe');

  m = morning([{ ...exact, status: 100 }], [{ id: 'd1', status: 200, expense: { number: '42', amount: 118, supplier: { taxId: '512345678' } } }]);
  assert.equal((await m.lookup.find(f)).status, 'not_found');

  m = morning([], [{ id: 'd2', status: 10, expense: { number: '42', amount: 118, supplier: { taxId: '512345678' }, date: '2026-03-01T00:00:00Z' } }]);
  const d = await m.lookup.find(f);
  assert.equal(d.status, 'found'); assert.equal(d.where, 'draft');
  await m.lookup.find(f);
  assert.equal(m.calls.filter((c) => c.path.endsWith('/drafts/search')).length, 1); // drafts are cached between lookups

  assert.equal((await morning([], []).lookup.find({ ...f, docNumber: null, total: null })).status, 'unknown');
});

test('MorningLookup: without a document number, searches by supplier and amount and needs the same day', async () => {
  setSecret('morning_id', 'id'); setSecret('morning_secret', 'sec');
  const f = { ...FIELDS(), docNumber: null };
  const e = { id: 'e9', status: 10, number: '7', amount: 118, supplier: { taxId: '512345678' }, date: '2026-03-01' };
  const m = morning([e], []);
  assert.equal((await m.lookup.find(f)).status, 'maybe');
  const q = m.calls.find((c) => c.path.endsWith('/expenses/search'))!.body;
  assert.equal(q.minAmount, 118); assert.equal(q.maxAmount, 118); assert.equal(q.number, undefined);
  assert.equal((await morning([{ ...e, date: '2026-03-02' }], []).lookup.find(f)).status, 'not_found');
});

test('catch-up leaves out a receipt finished as part of an invoice already sent', () => {
  filed('z', {}, 'receipt_for_sent_invoice');
  assert.deepEqual(listCatchup(getSettings()), []);
});
