import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { setSecret } from '../server/secrets.js';
import { MorningAccounting, detectMorningModes, fetchMorningClassifications } from '../server/destinations/morning.js';
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
const host = (c: Call) => new URL(c.url).host;
const body = (c: Call) => JSON.parse(String(c.init.body));

const S3 = 'https://s3.eu-west-1.amazonaws.com/file-upload-service-uploaded';
const KEY = '2026/01/10/biz-1/${filename}';
const presign = { url: S3, fields: { key: KEY, Policy: 'P', 'X-Amz-Signature': 'S', bucket: 'b' }, maxFileSize: 20_971_520 };
const isS3 = (c: Call) => c.url === S3;
const isUploadUrl = (c: Call) => path(c) === '/file-upload/v1/url';
const isOauth = (c: Call) => path(c).endsWith('/idp/v1/oauth/token');

/** Standard Morning v2: OAuth ok, empty draft search, presign ok, S3 204. */
const happy = (c: Call) => {
  const p = path(c);
  if (isOauth(c)) return json(200, { accessToken: 'T', tokenType: 'Bearer', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  if (p.endsWith('/expenses/drafts/search')) return json(200, { total: 0, items: [] });
  if (isUploadUrl(c)) return json(201, presign);
  if (isS3(c)) return new Response(null, { status: 204 });
  return json(404, { errorCode: 1, errorMessage: 'nope' });
};
const REF = '2026/01/10/biz-1/a.pdf';

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

test('api_file: OAuth, presigned URL for a new draft, then multipart to S3 with the file last; no draft search', async () => {
  const f = fakeFetch(happy);
  const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
  const r = await m.send(item());
  assert.deepEqual(r, { ref: REF, mode: 'api_file' });
  assert.deepEqual(f.calls.map((c) => host(c) + path(c)), [
    'api.morning.co/idp/v1/oauth/token', 'api.morning.co/file-upload/v1/url', 's3.eu-west-1.amazonaws.com/file-upload-service-uploaded',
  ]);
  assert.deepEqual(body(f.calls[0]), { grant_type: 'client_credentials', client_id: 'id1', client_secret: 'sec1' });
  const u = new URL(f.calls[1].url);
  assert.equal(u.searchParams.get('context'), 'expense');
  assert.deepEqual(JSON.parse(u.searchParams.get('data')!), { source: 5 });
  assert.equal(f.calls[1].init.method, 'GET');
  assert.equal((f.calls[1].init.headers as Record<string, string>).Authorization, 'Bearer T');
  const s3 = f.calls[2];
  assert.equal(s3.init.method, 'POST');
  assert.equal(s3.init.headers, undefined); // no Morning token to S3; fetch sets the multipart boundary
  const form = s3.init.body as FormData;
  assert.deepEqual([...form.keys()], ['key', 'Policy', 'X-Amz-Signature', 'bucket', 'file']);
  assert.equal(form.get('key'), KEY);
  const file = form.get('file') as File;
  assert.equal(file.name, 'a.pdf');
  assert.equal(file.type, 'application/pdf');
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), '%PDF-fake');
});

test('api_file: legacy /account/token is used when the OAuth IDP is missing, unreachable or refuses the keys', async () => {
  for (const idp of [() => json(404, {}), () => { throw new TypeError('fetch failed'); }, () => json(401, { error: 'invalid_client' })]) {
    const f = fakeFetch((c) => {
      if (isOauth(c)) return idp();
      if (path(c).endsWith('/account/token')) return json(200, { token: 'L', expires: Math.floor(Date.now() / 1000) + 3600 });
      return happy(c);
    });
    const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
    assert.equal((await m.send(item())).ref, REF);
    assert.equal((f.calls.find(isUploadUrl)!.init.headers as Record<string, string>).Authorization, 'Bearer L');
  }
});

test('api_file: hosts come from options (sandbox splits login and upload hosts)', async () => {
  const f = fakeFetch(happy);
  const m = new MorningAccounting({
    fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW,
    gatewayUrl: 'https://api.sandbox.morning.dev/', uploadUrl: 'https://api.sandbox.d.greeninvoice.co.il',
  });
  await m.send(item());
  assert.equal(host(f.calls.find(isOauth)!), 'api.sandbox.morning.dev');
  assert.equal(host(f.calls.find(isUploadUrl)!), 'api.sandbox.d.greeninvoice.co.il');
});

test('api_file: S3 failures — expired presign/5xx/network are transient, EntityTooLarge is rejected', async () => {
  for (const mk of [() => new Response('<Error>AccessDenied</Error>', { status: 403 }), () => new Response('', { status: 503 }), () => { throw new TypeError('fetch failed'); }]) {
    const f = fakeFetch((c) => isS3(c) ? mk() : happy(c));
    const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
    await assert.rejects(m.send(item()), TransientError);
  }
  const big = fakeFetch((c) => isS3(c) ? new Response('<Error><Code>EntityTooLarge</Code></Error>', { status: 400 }) : happy(c));
  const m = new MorningAccounting({ fetchImpl: big.impl, getSettings: settings('api_file'), now: () => NOW });
  await assert.rejects(m.send(item()), AccountingRejected);
});

test('api_file: a PDF over maxFileSize is rejected before uploading; a bad presign is transient', async () => {
  const small = fakeFetch((c) => isUploadUrl(c) ? json(201, { ...presign, maxFileSize: 4 }) : happy(c));
  const m = new MorningAccounting({ fetchImpl: small.impl, getSettings: settings('api_file'), now: () => NOW });
  await assert.rejects(m.send(item()), AccountingRejected);
  assert.ok(!small.calls.some(isS3));
  for (const bad of [{}, { url: 'http://insecure.example/x', fields: {} }, { url: S3 }]) {
    const f = fakeFetch((c) => isUploadUrl(c) ? json(201, bad) : happy(c));
    const m2 = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
    await assert.rejects(m2.send(item()), TransientError);
    assert.ok(!f.calls.some((c) => c.init.body instanceof FormData));
  }
});

test('api_file: the uploaded name has no path parts or quotes and always ends in .pdf', async () => {
  const f = fakeFetch(happy);
  const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
  const r = await m.send({ ...item(), filename: '../x/חשבונית "7"' });
  const file = (f.calls.find(isS3)!.init.body as FormData).get('file') as File;
  assert.equal(file.name, 'חשבונית 7.pdf');
  assert.equal(r.ref, '2026/01/10/biz-1/חשבונית 7.pdf');
});

test('api_file retry: searches drafts of the last 7 days before uploading', async () => {
  const f = fakeFetch(happy);
  const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
  assert.deepEqual(await m.send({ ...item(), retry: true }), { ref: REF, mode: 'api_file' });
  assert.deepEqual(f.calls.map(path), ['/idp/v1/oauth/token', '/api/v1/expenses/drafts/search', '/file-upload/v1/url', '/file-upload-service-uploaded']);
  assert.equal(body(f.calls[1]).fromDate, '2026-01-03');
});

test('api_fields setting falls back to file-only upload and reports api_file', async () => {
  const f = fakeFetch(happy);
  const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_fields'), now: () => NOW });
  assert.equal((await m.send(item())).mode, 'api_file');
  assert.ok(f.calls.some(isS3));
});

const draft = (id: string, expense: Record<string, unknown>) => ({ id, expense });
const drafts = (...items: unknown[]) => (c: Call) => path(c).endsWith('/expenses/drafts/search')
  ? json(200, { items }) : happy(c);

test('retry safety: a retried item finds its draft by number + amount + supplier, no second upload', async () => {
  const f = fakeFetch(drafts(draft('old-9', { number: 'INV-7', amount: 118, supplier: { name: ' ACME ' } })));
  const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
  assert.deepEqual(await m.send({ ...item(), retry: true }), { ref: 'old-9', mode: 'api_file' });
  assert.ok(!f.calls.some((c) => isUploadUrl(c) || isS3(c)));
  const byTaxId = fakeFetch(drafts(draft('old-8', { number: 'INV-7', amount: 118, supplier: { name: 'Other name', taxId: '51-234567-8' } })));
  const m2 = new MorningAccounting({ fetchImpl: byTaxId.impl, getSettings: settings('api_file'), now: () => NOW });
  assert.deepEqual(await m2.send({ ...item({ vendorTaxId: '512345678' }), retry: true }), { ref: 'old-8', mode: 'api_file' });
});

test('two vendors sharing a document number: both are sent (first send never looks up drafts)', async () => {
  // Vendor A's INV-7 is already a draft in Morning; vendor B's INV-7 must still be uploaded.
  const f = fakeFetch(drafts(draft('a-1', { number: 'INV-7', amount: 118, supplier: { name: 'Acme' } })));
  const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
  assert.deepEqual(await m.send(item({ vendorName: 'Beta Co', total: 50 })), { ref: REF, mode: 'api_file' });
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
    assert.deepEqual(await m.send({ ...item(), retry: true }), { ref: REF, mode: 'api_file' });
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
    const f = fakeFetch((c) => isUploadUrl(c) ? mk() : happy(c));
    const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
    await assert.rejects(m.send(item()), TransientError);
  }
});

test('4xx rejection carries Morning errorMessage', async () => {
  const f = fakeFetch((c) => isUploadUrl(c) ? json(400, { errorCode: 5, errorMessage: 'bad file' }) : happy(c));
  const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
  await assert.rejects(m.send(item()), (e: Error) => e instanceof AccountingRejected && e.message === 'bad file');
});

test('401 resets the token cache and is transient once; next call re-authenticates', async () => {
  let uploads = 0;
  const f = fakeFetch((c) => {
    if (isUploadUrl(c) && uploads++ === 0) return json(401, {});
    return happy(c);
  });
  const m = new MorningAccounting({ fetchImpl: f.impl, getSettings: settings('api_file'), now: () => NOW });
  await assert.rejects(m.send(item()), TransientError);
  await m.send(item());
  assert.equal(f.calls.filter(isOauth).length, 2);
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
  assert.equal(f.calls.filter(isOauth).length, 1);
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

test('classifications: one authenticated GET, nested map flattened, groups skipped, deduped, sorted', async () => {
  const map = [
    { id: 'g1', title: 'הוצאות', group: true, children: [
      { id: 'c2', title: 'רכב', key: '1310', code: 1300, irsCode: 1310, type: 20, income: 100, vat: 66.67 },
      { id: 'c1', name: 'אחזקה', irsCode: '1390' },
    ] },
    { nested: { list: [{ id: 'c2', title: 'רכב' }, { id: '', title: 'no id' }, { title: 'no id either' }] } },
  ];
  const f = fakeFetch((c) => path(c).endsWith('/accounting/classifications/map') ? json(200, map) : happy(c));
  const out = await fetchMorningClassifications({ fetchImpl: f.impl });
  assert.deepEqual(out.map((x) => x.id), ['c1', 'c2']);
  assert.deepEqual(out[1], { id: 'c2', title: 'רכב', key: '1310', code: '1300', irsCode: 1310, type: 20, income: 100, vat: 66.67 });
  assert.equal(out[0].irsCode, 1390);
  const get = f.calls.find((c) => path(c).endsWith('/classifications/map'))!;
  assert.equal(get.init.method, 'GET');
  assert.equal(get.init.body, undefined);
  assert.equal((get.init.headers as Record<string, string>).Authorization, 'Bearer T');
});

test('classifications: Morning rejection surfaces as AccountingRejected', async () => {
  const f = fakeFetch((c) => path(c).endsWith('/classifications/map') ? json(403, { errorMessage: 'no access' }) : happy(c));
  await assert.rejects(fetchMorningClassifications({ fetchImpl: f.impl }), (e) => e instanceof AccountingRejected && /no access/.test(e.message));
});
