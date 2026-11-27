import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshAccounts, TEST_EMAIL } from './helpers.js';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import type { ApiContext } from '../server/routes.js';
import { resetLoginLimiter } from '../server/auth.js';
import { createEmail, createItem, getItem, setItemFields, transition, updateItem } from '../server/core/items.js';
import { getSettings, updateSettings } from '../server/settings.js';
import { setSecret } from '../server/secrets.js';
import { matchDrafts, type DraftsSource } from '../server/core/drafts.js';
import { MorningDrafts, type ApproveInput, type PendingDraft } from '../server/destinations/morning.js';
import type { Deps, ExtractedFields } from '../server/core/types.js';
import type { GmailSource } from '../server/sources/gmail.js';

process.env.SECRET_KEY = 'test-key-for-unit-tests-only-0123456789';
process.env.APP_PASSWORD = 'correct horse';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });
beforeEach(() => { openDb(':memory:'); freshAccounts(); resetLoginLimiter(); });

const NOW = new Date('2026-06-15T09:00:00Z');
const F = (over: Partial<ExtractedFields> = {}): ExtractedFields => ({
  vendorName: 'פרטנר', vendorTaxId: '520044314', docType: 'tax_invoice', docNumber: '0042', issueDate: '2026-05-20',
  total: 118, vat: 18, net: 100, currency: 'ILS', allocationNumber: null, description: null, category: getSettings().categories[0].name, ...over,
});
const D = (over: Partial<PendingDraft> = {}): PendingDraft => ({
  id: 'd1', createdAt: '2026-05-21T00:00:00.000Z', number: '42', date: '2026-05-20', reportingDate: '2026-05-01', amount: 118, vat: 18,
  currency: 'ILS', supplierName: 'פרטנר תקשורת', supplierTaxId: '520044314', documentType: 305, paymentType: 3, classification: 'תקשורת',
  fileUrl: null, fileKey: null, ...over,
});

/** A document the pipeline sent to Morning as a draft (ref = the uploaded object key). */
function sent(tag: string, f: Partial<ExtractedFields> = {}, ref = `2026/05/21/biz/${tag}.pdf`) {
  createEmail({ messageId: `m-${tag}`, threadId: 't', sender: 's@x.com', subject: 's', receivedAt: '2026-05-21T00:00:00Z', mode: 'ongoing' });
  const { id } = createItem(`m-${tag}`, `${tag}.pdf`, Buffer.from(`%PDF-1.4 ${tag}`));
  setItemFields(id, F(f), 'recipe');
  updateItem(id, { storagePath: `/2026/${tag}.pdf`, accountingRef: ref, accountingMode: 'api_file' });
  transition(id, 'done');
  return id;
}

test('drafts are tied to our documents: by upload key first, then number+amount+supplier, then a maybe', () => {
  const a = sent('a', { docNumber: 'A-1' });
  const b = sent('b', { docNumber: '0077', total: 50 });
  const c = sent('c', { docNumber: '900', total: 10 });
  const rows = matchDrafts([
    D({ id: 'x', number: null, amount: null, supplierName: null, fileUrl: 'https://files.example/2026/05/21/biz/a.pdf?sig=1' }),
    D({ id: 'y', number: '77', amount: 50 }),
    D({ id: 'z', number: '900', amount: 11, supplierName: 'פרטנר' }),
    D({ id: 'w', number: '555', amount: 3, supplierName: 'אחר', supplierTaxId: null }),
  ], getSettings());
  assert.deepEqual(rows.map((r) => [r.draft.id, r.item?.id ?? null, r.match]), [
    ['x', a, 'ref'], ['y', b, 'found'], ['z', c, 'maybe'], ['w', null, null],
  ]);
  assert.equal(rows[0].item!.classificationId, null); // category not mapped to a Morning classification yet
});

test('an approved document is not offered again', () => {
  sent('a', {}, 'expense:e-1');
  assert.equal(matchDrafts([D()], getSettings())[0].item, null);
});

// ---------- the Morning client ----------
interface Call { url: string; init: RequestInit }
function fakeFetch(responder: (c: Call) => Response) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} }; calls.push(c); return responder(c);
  }) as typeof fetch;
  return { impl, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const path = (c: Call) => new URL(c.url).pathname;
const S3 = 'https://s3.example.com/up';
function morning(over: (c: Call) => Response | null = () => null) {
  return fakeFetch((c) => {
    const o = over(c); if (o) return o;
    const p = path(c);
    if (p.endsWith('/oauth/token')) return json(200, { accessToken: 'tok', expiresAt: NOW.getTime() / 1000 + 3600 });
    if (p.endsWith('/expenses/drafts/search')) return json(200, { items: [
      { id: 'd1', status: 10, creationDate: 1779321600, url: 'https://files/x.pdf', expense: { number: '42', amount: 118, vat: 18, date: '2026-05-20T00:00:00', reportingDate: '2026-06-01T00:00:00', supplier: { name: 'פרטנר' } } },
      { id: 'd2', status: 200, expense: {} }, { id: 'd3', status: 50, expense: {} },
    ] });
    if (p.endsWith('/expenses/search')) return json(200, { items: [] });
    if (p.endsWith('/expenses') && c.init.method === 'POST') return json(201, { id: 'exp-9' });
    if (p === '/file-upload/v1/url') return json(200, { url: S3, fields: { key: 'k/${filename}' } });
    if (c.url === S3) return new Response(null, { status: 204 });
    if (c.init.method === 'DELETE') return json(200, {});
    return json(404, { errorMessage: 'nope' });
  });
}
const client = (f: ReturnType<typeof fakeFetch>) => new MorningDrafts({ fetchImpl: f.impl, baseUrl: 'https://api.test/v1', gatewayUrl: 'https://gw.test', now: () => NOW });
const input = (d: PendingDraft, over: Partial<ExtractedFields> = {}): ApproveInput => ({ draft: d, fields: F(over), classificationId: 'cls-1', pdf: Buffer.from('%PDF'), filename: 'a.pdf' });

beforeEach(() => { setSecret('morning_id', 'id'); setSecret('morning_secret', 'secret'); });

test('listPending keeps only status 10 (new): failed and declined drafts are not waiting', async () => {
  const f = morning();
  const list = await client(f).listPending();
  assert.deepEqual(list.map((d) => d.id), ['d1']);
  assert.equal(list[0].date, '2026-05-20');
  assert.equal(list[0].fileUrl, 'https://files/x.pdf');
});

test('approve: creates the expense from our fields, attaches our PDF to it, then deletes the draft', async () => {
  const f = morning();
  const d = D({ reportingDate: '2026-06-01', paymentType: 3 });
  const r = await client(f).approve(input(d));
  assert.deepEqual(r, { expenseId: 'exp-9', existed: false, fileAttached: true, draftRemoved: true });
  const create = f.calls.find((c) => path(c).endsWith('/expenses') && c.init.method === 'POST')!;
  assert.deepEqual(JSON.parse(String(create.init.body)), {
    documentType: 305, number: '0042', date: '2026-05-20', reportingDate: '2026-06-01', currency: 'ILS', amount: 118, vat: 18,
    supplier: { name: 'פרטנר', taxId: '520044314' }, accountingClassification: { id: 'cls-1' }, paymentType: 3,
  });
  const presign = f.calls.find((c) => path(c) === '/file-upload/v1/url')!;
  assert.deepEqual(JSON.parse(new URL(presign.url).searchParams.get('data')!), { id: 'exp-9', source: 5, state: 'expense' });
  assert.equal(path(f.calls.at(-1)!), '/v1/expenses/drafts/d1');
  assert.equal(f.calls.at(-1)!.init.method, 'DELETE');
});

test('approve: an expense already in Morning is not created twice; its file is kept', async () => {
  const f = morning((c) => path(c).endsWith('/expenses/search')
    ? json(200, { items: [{ id: 'old', status: 10, number: '42', amount: 118, supplier: { name: 'פרטנר' }, url: 'https://files/old.pdf' }] }) : null);
  const r = await client(f).approve(input(D()));
  assert.deepEqual(r, { expenseId: 'old', existed: true, fileAttached: false, draftRemoved: true });
  assert.ok(!f.calls.some((c) => path(c).endsWith('/expenses') && c.init.method === 'POST'));
  assert.ok(!f.calls.some((c) => path(c) === '/file-upload/v1/url'));
});

test('approve: when the file cannot be attached the draft is kept (it still holds the file)', async () => {
  const f = morning((c) => (c.url === S3 ? new Response('boom', { status: 500 }) : null));
  const r = await client(f).approve(input(D()));
  assert.equal(r.fileAttached, false);
  assert.equal(r.draftRemoved, false);
  assert.match(r.draftReason!, /^file_not_attached/);
  assert.ok(!f.calls.some((c) => c.init.method === 'DELETE'));
});

test('approve: a refused draft delete is reported, the expense stands', async () => {
  const f = morning((c) => (c.init.method === 'DELETE' ? json(405, {}) : null));
  const r = await client(f).approve(input(D()));
  assert.equal(r.expenseId, 'exp-9');
  assert.equal(r.draftRemoved, false);
  assert.equal(r.draftReason, 'delete_not_supported');
});

test('approve: reporting month never earlier than the document month; Morning fills what we lack', () => {
  const m = client(morning());
  const b = m.expenseBody({ draft: D({ reportingDate: '2026-04-01' }), fields: F({ docNumber: null, vendorTaxId: null }), classificationId: 'c' });
  assert.equal(b.reportingDate, '2026-05-01');
  assert.equal(b.number, '42');
  assert.deepEqual(b.supplier, { name: 'פרטנר', taxId: '520044314' });
  assert.throws(() => m.expenseBody({ draft: D(), fields: F({ issueDate: '2026-07-01' }), classificationId: 'c' }), /future_date/);
});

// ---------- routes ----------
async function boot(src: DraftsSource | null) {
  const deps = (): Deps => ({
    storage: { exists: async () => ({ exists: false, sameContent: false }), put: async (f, n) => ({ path: `${f}/${n}`, existed: false }) },
    accounting: null, ai: null, settings: getSettings(), now: () => NOW,
  });
  const ctx: ApiContext = { getDeps: () => ({ deps: deps(), gmail: {} as GmailSource }), now: () => NOW, morningDrafts: () => src };
  const s = await new Promise<Server>((r) => { const x = createApp(ctx).listen(0, '127.0.0.1', () => r(x)); });
  servers.push(s);
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: TEST_EMAIL, password: 'correct horse' }) });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  return async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`${base}${p}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
}

test('routes: list, refuse without a classification, approve and record the expense on the document', async () => {
  const id = sent('a', { docNumber: '42' });
  const approved: ApproveInput[] = [];
  const src: DraftsSource = {
    listPending: async () => [D()],
    approve: async (i) => { approved.push(i); return { expenseId: 'exp-1', existed: false, fileAttached: true, draftRemoved: true }; },
  };
  const call = await boot(src);
  const list = await call('GET', '/api/morning/drafts');
  assert.equal(list.body.configured, true);
  assert.equal(list.body.rows[0].item.id, id);

  assert.equal((await call('POST', '/api/morning/drafts/d1/approve', { itemId: id })).body.error, 'no_classification');
  const cats = getSettings().categories.map((c, i) => (i === 0 ? { ...c, accountingClassification: 'cls-7' } : c));
  updateSettings({ categories: cats });

  assert.equal((await call('POST', '/api/morning/drafts/gone/approve', { itemId: id })).body.error, 'draft_gone');
  const ok = await call('POST', '/api/morning/drafts/d1/approve', { itemId: id });
  assert.equal(ok.status, 200);
  assert.equal(approved[0].classificationId, 'cls-7');
  assert.equal(getItem(id)!.accountingRef, 'expense:exp-1');
  assert.equal((await call('POST', '/api/morning/drafts/d1/approve', { itemId: id })).body.error, 'already_approved');
});

test('routes: without Morning API keys the page says so', async () => {
  const call = await boot(null);
  assert.deepEqual((await call('GET', '/api/morning/drafts')).body, { configured: false, rows: [] });
});
