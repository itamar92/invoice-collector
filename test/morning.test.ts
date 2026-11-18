import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { setSecret } from '../server/secrets.js';
import { MorningAccounting, detectMorningModes } from '../server/destinations/morning.js';
import { TransientError, AccountingRejected, type ExtractedFields } from '../server/core/types.js';
import type { Settings } from '../server/settings.js';

process.env.SECRET_KEY = 'test-key-for-unit-tests-only-0123456789';

interface Call { url: string; init: RequestInit }
function fakeFetch(responder: (c: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} };
    const n = calls.length;
    calls.push(c);
    return responder(c, n);
  }) as typeof fetch;
  return { impl, calls };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const path = (c: Call) => new URL(c.url).pathname;
const body = (c: Call) => JSON.parse(String(c.init.body));

/** Standard Morning: token ok, empty draft search, upload ok. */
const happy = (c: Call) => {
  const p = path(c);
  if (p.endsWith('/account/token')) return json(200, { token: 'T', expires: Math.floor(Date.now() / 1000) + 3600 });
  if (p.endsWith('/expenses/drafts/search')) return json(200, { total: 0, items: [] });
  if (p.endsWith('/expenses/file')) return json(201, { id: 'draft-1', status: 10 });
  return json(404, { errorCode: 1, errorMessage: 'nope' });
};

const fields: ExtractedFields = {
  vendorName: 'Acme', vendorTaxId: null, docType: 'tax_invoice', docNumber: 'INV-7', issueDate: '2026-01-02',
  total: 118, vat: 18, net: 100, currency: 'ILS', allocationNumber: null, description: 'x', category: 'Fuel',
};
const cat = { name: 'Fuel', sendToAccounting: true, accountingClassification: '123' };
const item = (extra: Partial<ExtractedFields> = {}) =>
  ({ pdf: Buffer.from('%PDF-fake'), filename: 'a.pdf', fields: { ...fields, ...extra }, category: cat });
const settings = (mode: Settings['morning']['mode'], inboxEmail?: string) =>
  () => ({ morning: { mode, inboxEmail } }) as Settings;
const NOW = new Date('2026-01-10T12:00:00Z');

beforeEach(() => {
  openDb(':memory:');
  setSecret('morning_id', 'id1');
  setSecret('morning_secret', 'sec1');
});

test('api_file: first send uploads the PDF as base64 data URI without searching drafts', async () => {
  const f = fakeFetch(happy);
  const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
  const r = await m.send(item());
  assert.deepEqual(r, { ref: 'draft-1', mode: 'api_file' });
  assert.deepEqual(f.calls.map(path), ['/api/v1/account/token', '/api/v1/expenses/file']);
  assert.equal(body(f.calls[1]).file, 'data:application/pdf;base64,' + Buffer.from('%PDF-fake').toString('base64'));
  assert.equal((f.calls[1].init.headers as Record<string, string>).Authorization, 'Bearer T');
});

test('api_file retry: searches drafts of the last 7 days before uploading', async () => {
  const f = fakeFetch(happy);
  const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
  assert.deepEqual(await m.send({ ...item(), retry: true }), { ref: 'draft-1', mode: 'api_file' });
  assert.deepEqual(f.calls.map(path), ['/api/v1/account/token', '/api/v1/expenses/drafts/search', '/api/v1/expenses/file']);
  assert.equal(body(f.calls[1]).fromDate, '2026-01-03');
});

test('api_fields setting falls back to file-only upload and reports api_file', async () => {
  const f = fakeFetch(happy);
  const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_fields'), now: () => NOW });
  assert.equal((await m.send(item())).mode, 'api_file');
  assert.ok(f.calls.some((c) => path(c).endsWith('/expenses/file')));
});

const draft = (id: string, expense: Record<string, unknown>) => ({ id, expense });
const drafts = (...items: unknown[]) => (c: Call) => path(c).endsWith('/expenses/drafts/search')
  ? json(200, { items }) : happy(c);

test('retry safety: a retried item finds its draft by number + amount + supplier, no second upload', async () => {
  const f = fakeFetch(drafts(draft('old-9', { number: 'INV-7', amount: 118, supplier: { name: ' ACME ' } })));
  const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
  assert.deepEqual(await m.send({ ...item(), retry: true }), { ref: 'old-9', mode: 'api_file' });
  assert.ok(!f.calls.some((c) => path(c).endsWith('/expenses/file')));
  const byTaxId = fakeFetch(drafts(draft('old-8', { number: 'INV-7', amount: 118, supplier: { name: 'Other name', taxId: '51-234567-8' } })));
  const m2 = new MorningAccounting({ fetchImpl: byTaxId.impl, getSettings: settings('api_file'), now: () => NOW });
  assert.deepEqual(await m2.send({ ...item({ vendorTaxId: '512345678' }), retry: true }), { ref: 'old-8', mode: 'api_file' });
});

test('two vendors sharing a document number: both are sent (first send never looks up drafts)', async () => {
  // Vendor A's INV-7 is already a draft in Morning; vendor B's INV-7 must still be uploaded.
  const f = fakeFetch(drafts(draft('a-1', { number: 'INV-7', amount: 118, supplier: { name: 'Acme' } })));
  const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
  assert.deepEqual(await m.send(item({ vendorName: 'Beta Co', total: 50 })), { ref: 'draft-1', mode: 'api_file' });
  assert.ok(!f.calls.some((c) => path(c).endsWith('/drafts/search')));
});

test('retry safety: a draft matching only the number (other supplier or amount) is not ours → upload', async () => {
  for (const exp of [
    { number: 'INV-7', amount: 118, supplier: { name: 'Beta Co' } },
    { number: 'INV-7', amount: 50, supplier: { name: 'Acme' } },
    { number: 'INV-7', amount: 118 }, // supplier not filled yet: not provably ours
  ]) {
    const f = fakeFetch(drafts(draft('other', exp)));
    const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
    assert.deepEqual(await m.send({ ...item(), retry: true }), { ref: 'draft-1', mode: 'api_file' });
  }
});

test('email mode sends via mailer with subject = filename without .pdf', async () => {
  const sent: unknown[][] = [];
  const m = new MorningAccounting({
    getSettings: settings('email', 'inbox@example.test'),
    mailer: async (...a) => { sent.push(a); return 'gmail-42'; },
  });
  const r = await m.send(item());
  assert.deepEqual(r, { ref: 'gmail-42', mode: 'email' });
  assert.deepEqual(sent[0].slice(0, 3), ['inbox@example.test', 'a', 'a.pdf']);
});

test('email mode without inboxEmail is rejected', async () => {
  const m = new MorningAccounting({ getSettings: settings('email'), mailer: async () => 'x' });
  await assert.rejects(m.send(item()), (e: Error) => e instanceof AccountingRejected && e.message === 'no Morning inbox email configured');
});

test('5xx, 429 and network failure are transient', async () => {
  for (const mk of [() => json(503, {}), () => json(429, {}), () => { throw new TypeError('fetch failed'); }]) {
    const f = fakeFetch((c) => path(c).endsWith('/expenses/file') ? mk() : happy(c));
    const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
    await assert.rejects(m.send(item()), TransientError);
  }
});

test('4xx rejection carries Morning errorMessage', async () => {
  const f = fakeFetch((c) => path(c).endsWith('/expenses/file') ? json(400, { errorCode: 5, errorMessage: 'bad file' }) : happy(c));
  const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
  await assert.rejects(m.send(item()), (e: Error) => e instanceof AccountingRejected && e.message === 'bad file');
});

test('401 resets the token cache and is transient once; next call re-authenticates', async () => {
  let uploads = 0;
  const f = fakeFetch((c) => {
    if (path(c).endsWith('/expenses/file') && uploads++ === 0) return json(401, {});
    return happy(c);
  });
  const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
  await assert.rejects(m.send(item()), TransientError);
  await m.send(item());
  assert.equal(f.calls.filter((c) => path(c).endsWith('/account/token')).length, 2);
});

test('token endpoint 401/403 means credentials rejected', async () => {
  for (const s of [401, 403]) {
    const f = fakeFetch(() => json(s, {}));
    const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
    await assert.rejects(m.send(item()), (e: Error) => e instanceof AccountingRejected && e.message === 'Morning credentials rejected');
  }
});

test('token is cached between sends', async () => {
  const f = fakeFetch(happy);
  const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
  await m.send(item()); await m.send(item({ docNumber: 'INV-8' }));
  assert.equal(f.calls.filter((c) => path(c).endsWith('/account/token')).length, 1);
});

test('no mode configured is rejected', async () => {
  const m = new MorningAccounting({ getSettings: settings(null) });
  await assert.rejects(m.send(item()), AccountingRejected);
});

test('no write call ever targets approve or report paths', async () => {
  const f = fakeFetch(happy);
  const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
  await m.send(item());
  await detectMorningModes({ fetchImpl: f.impl });
  for (const c of f.calls) assert.doesNotMatch(path(c), /approve|report/i);
});

test('detect: api_file true when drafts search works; api_fields always false', async () => {
  const f = fakeFetch(happy);
  assert.deepEqual(await detectMorningModes({ fetchImpl: f.impl }), { api_fields: false, api_file: true });
  assert.ok(f.calls.every((c) => c.init.method === 'POST' && /token|drafts\/search/.test(path(c))));
});

test('detect: false when drafts search fails or auth fails; never throws', async () => {
  const f1 = fakeFetch((c) => path(c).endsWith('/drafts/search') ? json(404, {}) : happy(c));
  assert.equal((await detectMorningModes({ fetchImpl: f1.impl })).api_file, false);
  const f2 = fakeFetch(() => json(401, {}));
  assert.equal((await detectMorningModes({ fetchImpl: f2.impl })).api_file, false);
  const f3 = fakeFetch(() => { throw new Error('down'); });
  assert.equal((await detectMorningModes({ fetchImpl: f3.impl })).api_file, false);
});
