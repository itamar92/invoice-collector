import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { apiRouter, backfillJobDone, type ApiContext } from '../server/routes.js';
import { resetLoginLimiter } from '../server/auth.js';
import { createEmail, updateItem, createItem, getItem, setItemFields, setItemVendor, transition } from '../server/core/items.js';
import { recordIngestFailure } from '../server/core/ingestFailures.js';
import { compileRecipe } from '../server/core/recipe.js';
import { saveRecipe, getVendor, upsertVendor, setVendorStatus } from '../server/core/recipeStore.js';
import { vendorKeyFor } from '../server/core/pipeline.js';
import { setSecret } from '../server/secrets.js';
import { getDb } from '../server/db.js';
import { getSettings, updateSettings } from '../server/settings.js';
import type { Deps, ExtractedFields } from '../server/core/types.js';
import type { GmailSource } from '../server/sources/gmail.js';

process.env.SECRET_KEY = 'test-key-for-unit-tests-only-0123456789';
process.env.APP_PASSWORD = 'correct horse';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });
beforeEach(() => { openDb(':memory:'); resetLoginLimiter(); });

const deps = (): Deps => ({
  storage: { exists: async () => ({ exists: false, sameContent: false }), put: async (f, n) => ({ path: `${f}/${n}`, existed: false }) },
  accounting: null, ai: null, settings: getSettings(), now: () => new Date('2026-06-15T09:00:00Z'),
});
const gmail = {} as GmailSource;

async function boot(over: Partial<ApiContext> = {}) {
  const ctx: ApiContext = { getDeps: () => ({ deps: deps(), gmail }), now: () => new Date('2026-06-15T09:00:00Z'), ...over };
  const app = createApp(ctx);
  const s = await new Promise<Server>((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  servers.push(s);
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse' }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method, headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { base, call };
}

const FIELDS: ExtractedFields = {
  vendorName: 'ספק דמו', vendorTaxId: null, docType: 'tax_invoice', docNumber: '1001', issueDate: '2026-06-01',
  total: 118, vat: 18, net: 100, currency: 'ILS', allocationNumber: null, description: 'שירות', category: null,
};

function item(state: 'needs_attention' | 'awaiting_vendor' = 'needs_attention', fields: Partial<ExtractedFields> | null = null, tag = 'a') {
  createEmail({ messageId: `m-${tag}`, threadId: 't', sender: 's@x.com', subject: 's', receivedAt: '2026-06-01T00:00:00Z', mode: 'ongoing' });
  const { id } = createItem(`m-${tag}`, 'a.pdf', Buffer.from(`%PDF-1.4 fake ${tag}`));
  if (fields) setItemFields(id, { ...FIELDS, ...fields }, 'ai');
  transition(id, state, state === 'needs_attention' ? 'missing_total' : undefined);
  return id;
}

/** The FIELDS vendor, already decided as business (so a fixed item goes on to filing). */
function businessVendor() {
  const key = vendorKeyFor(FIELDS)!;
  upsertVendor(key, FIELDS.vendorName!);
  setVendorStatus(key, 'business');
  return key;
}

function recipeJson(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, vendorKey: 'demo-cell', displayName: 'סלולר דמו',
    match: { senders: ['billing@demo-cell.co.il'] },
    fields: { total: { kind: 'regex', pattern: 'סה"כ:\\s*([\\d.]+)', parse: 'amount' } },
    ...over,
  };
}

test('every /api route in the router answers 401 without a session', async () => {
  const router = apiRouter({ getDeps: () => { throw new Error('unused'); } });
  const routes = (router.stack as { route?: { path: string; methods: Record<string, boolean> } }[])
    .filter((l) => l.route).map((l) => l.route!);
  assert.ok(routes.length >= 25, `expected the full route list, got ${routes.length}`);
  const app: express.Express = createApp({ getDeps: () => { throw new Error('unused'); } });
  const s = await new Promise<Server>((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  servers.push(s);
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  for (const route of routes) {
    for (const method of Object.keys(route.methods)) {
      const path = `/api${route.path.replace(/:\w+/g, 'x')}`;
      const res = await fetch(`${base}${path}`, { method: method.toUpperCase(), headers: { 'content-type': 'application/json' }, body: method === 'get' ? undefined : '{}' });
      assert.equal(res.status, 401, `${method.toUpperCase()} ${path}`);
    }
  }
});

test('GET /api/settings never contains a stored secret value', async () => {
  const secrets = { gmail_refresh: 'gm-refresh-SECRET-1111', morning_secret: 'mo-secret-SECRET-2222', ai_key_openai: 'sk-SECRET-3333' } as const;
  for (const [k, v] of Object.entries(secrets)) setSecret(k as keyof typeof secrets, v);
  const { call } = await boot();
  const res = await call('GET', '/api/settings');
  assert.equal(res.status, 200);
  const text = await res.text();
  for (const v of Object.values(secrets)) assert.ok(!text.includes(v));
  const body = JSON.parse(text);
  assert.equal(body.secrets.gmail_refresh, true);
  assert.equal(body.secrets.ai_key_anthropic, false);
});

test('PUT /api/secrets/:key stores write-only, rejects unknown keys', async () => {
  const { call } = await boot();
  const res = await call('PUT', '/api/secrets/ai_key_openai', { value: 'sk-SECRET-9999' });
  assert.equal(res.status, 200);
  assert.ok(!(await res.text()).includes('sk-SECRET-9999'));
  assert.equal(((await (await call('GET', '/api/settings')).json()) as any).secrets.ai_key_openai, true);
  assert.equal((await call('PUT', '/api/secrets/not_a_key', { value: 'x' })).status, 404);
  assert.equal((await call('PUT', '/api/secrets/ai_key_openai', {})).status, 400);
});

test('invalid recipe PUT -> 400 with the RecipeError message; valid one is saved as user', async () => {
  const { call } = await boot();
  const bad = await call('PUT', '/api/vendors/demo-cell/recipe', recipeJson({ fields: { total: { kind: 'regex', pattern: '(', parse: 'amount' } } }));
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as any).message, /invalid|recipe|pattern/i);
  const mismatch = await call('PUT', '/api/vendors/other/recipe', recipeJson());
  assert.equal(mismatch.status, 400);
  const ok = await call('PUT', '/api/vendors/demo-cell/recipe', recipeJson());
  assert.equal(ok.status, 200);
  const hist = (await (await call('GET', '/api/vendors/demo-cell/recipes')).json()) as any[];
  assert.deepEqual(hist.map((h) => h.source), ['user']);
});

test('ai-always toggles the active recipe flag', async () => {
  saveRecipe(compileRecipe(recipeJson()), 'starter');
  const { call } = await boot();
  assert.equal((await call('PUT', '/api/vendors/demo-cell/ai-always', { value: true })).status, 200);
  const hist = (await (await call('GET', '/api/vendors/demo-cell/recipes')).json()) as any[];
  assert.equal(hist[0].recipe.aiAlways, true);
  assert.equal((await call('PUT', '/api/vendors/nope/ai-always', { value: true })).status, 404);
});

test('manual field edit on a needs_attention item re-validates and moves it to ready', async () => {
  businessVendor();
  const id = item('needs_attention', { total: null, vat: null, net: null });
  const { call } = await boot();
  const res = await call('PUT', `/api/items/${id}/fields`, { total: 118, vat: 18, net: 100 });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.valid, true);
  assert.equal(body.item.state, 'ready');
  assert.equal(getItem(id)!.provenance, 'manual');
});

test('fixing an item that has no vendor yet routes it through the vendor decision, not straight to filing', async () => {
  const id = item('needs_attention', { vendorName: null, total: null, vat: null, net: null }, 'nv');
  assert.equal(getItem(id)!.vendorKey, null);
  const { call } = await boot();
  const body = (await (await call('PUT', `/api/items/${id}/fields`, { vendorName: 'ספק חדש לגמרי', total: 118, vat: 18, net: 100 })).json()) as any;
  assert.equal(body.valid, true);
  assert.equal(body.item.state, 'awaiting_vendor');
  const key = vendorKeyFor({ ...FIELDS, vendorName: 'ספק חדש לגמרי' })!;
  assert.equal(body.item.vendorKey, key);
  assert.equal(getVendor(key)!.status, 'unreviewed');
  // A ready item that never got a vendor: the edit that sets one also sends it to the vendor step.
  const r = item('needs_attention', { vendorName: null }, 'nv2');
  transition(r, 'ready');
  const b2 = (await (await call('PUT', `/api/items/${r}/fields`, { vendorName: 'ספק נוסף' })).json()) as any;
  assert.equal(b2.item.state, 'awaiting_vendor');
});

test('manual edit that is still invalid keeps the item in needs_attention and lists problems', async () => {
  const id = item('needs_attention', { total: null, vat: null, net: null });
  const { call } = await boot();
  const body = (await (await call('PUT', `/api/items/${id}/fields`, { description: 'x' })).json()) as any;
  assert.equal(body.valid, false);
  assert.deepEqual(body.problems, ['missing_total']);
  assert.equal(getItem(id)!.state, 'needs_attention');
});

test('bad bodies -> 400 with field messages; unknown ids -> 404; no stack traces', async () => {
  const id = item();
  const { call } = await boot();
  const bad = await call('PUT', `/api/items/${id}/fields`, { total: 'abc', bogus: 1 });
  assert.equal(bad.status, 400);
  const text = await bad.text();
  assert.match(text, /fields/);
  assert.doesNotMatch(text, /node_modules|\.ts:\d+|at \w+/);
  assert.equal((await call('GET', '/api/items/nope')).status, 404);
  assert.equal((await call('GET', '/api/items/nope/pdf')).status, 404);
  assert.equal((await call('PUT', '/api/items/nope/fields', {})).status, 404);
  assert.equal((await call('POST', '/api/items/nope/retry')).status, 404);
  assert.equal((await call('POST', '/api/items/nope/dismiss')).status, 404);
  assert.equal((await call('PUT', '/api/vendors/nope', { status: 'business' })).status, 404);
  assert.equal((await call('POST', '/api/missed/nope/hide')).status, 404);
  assert.equal((await call('GET', '/api/items?limit=0')).status, 400);
});

test('PDF route is served inert: nosniff, sandbox CSP framable only by us, inline generic filename', async () => {
  const id = item();
  const { base, call } = await boot();
  const pdf = await call('GET', `/api/items/${id}/pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('x-content-type-options'), 'nosniff');
  const csp = pdf.headers.get('content-security-policy') ?? '';
  assert.match(csp, /(^|;\s*)sandbox(;|$)/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.equal(pdf.headers.get('content-disposition'), 'inline; filename="document.pdf"');
  // Every response refuses third-party framing; our own UI may still frame the PDF route.
  const h = await fetch(`${base}/healthz`);
  assert.equal(h.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(h.headers.get('content-security-policy') ?? '', /frame-ancestors 'self'/);
});

test('items list omits text; detail has events; pdf served as application/pdf; retry and dismiss', async () => {
  const id = item();
  const { call } = await boot();
  const list = (await (await call('GET', '/api/items?state=needs_attention')).json()) as any;
  assert.equal(list.items.length, 1);
  assert.ok(!('text' in list.items[0]));
  const detail = (await (await call('GET', `/api/items/${id}`)).json()) as any;
  assert.ok(detail.events.length >= 2);
  assert.equal(detail.emailMode, 'ongoing'); // the UI hides "send" for backfill items
  const pdf = await call('GET', `/api/items/${id}/pdf`);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(Buffer.from(await pdf.arrayBuffer()).toString(), /^%PDF/);
  assert.equal(((await (await call('POST', `/api/items/${id}/retry`)).json()) as any).state, 'queued');
  assert.equal((await call('POST', `/api/items/${id}/retry`)).status, 409);
  assert.equal(((await (await call('POST', `/api/items/${id}/dismiss`)).json()) as any).state, 'dismissed');
  assert.equal((await call('POST', `/api/items/${id}/dismiss`)).status, 409);
});

test('summary: attention includes open ingest failures; lastTickError is sanitized', async () => {
  item('needs_attention', null, 'a');
  item('awaiting_vendor', null, 'b');
  recordIngestFailure('m-fail', 'ongoing', new Error('boom'));
  updateSettings({ lastTickError: `fetch failed https://api.example.com/x?token=abc ${'y'.repeat(800)}` });
  const { call } = await boot();
  const s = (await (await call('GET', '/api/summary')).json()) as any;
  assert.equal(s.attention, 3);
  assert.equal(s.awaitingVendor, 1);
  assert.equal(s.ingestFailures, 1);
  assert.ok(s.lastTickError.length <= 500);
  assert.doesNotMatch(s.lastTickError, /https?:|token=abc/);
  assert.match(s.lastTickError, /\[url\]/);
  const f = (await (await call('GET', '/api/ingest-failures')).json()) as any[];
  assert.equal(f[0].messageId, 'm-fail');
});

test('settings PUT updates editable fields only; invalid -> 400', async () => {
  const { call } = await boot();
  const ok = await call('PUT', '/api/settings', { gmailLabel: 'חשבוניות', pollMinutes: 30 });
  assert.equal(ok.status, 200);
  assert.equal(getSettings().gmailLabel, 'חשבוניות');
  assert.equal((await call('PUT', '/api/settings', { backfillDone: true })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { pollMinutes: 0 })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { timezone: 'Mars/Base' })).status, 400);
});

test('vendor decision runs through setVendorDecision when connected; persists (200, processed:false) when not', async () => {
  saveRecipe(compileRecipe(recipeJson({ vendorKey: 'acme', displayName: 'Acme' })), 'starter');
  const id = item('awaiting_vendor', {}, 'v');
  setItemVendor(id, 'acme');
  const { call } = await boot();
  const res = await call('PUT', '/api/vendors/acme', { status: 'ignored' });
  assert.equal(res.status, 200);
  assert.equal(getVendor('acme')!.status, 'ignored');
  assert.equal(getItem(id)!.state, 'ignored');
  const down = await boot({ getDeps: () => { throw new Error('gmail not connected') } });
  const r2 = await down.call('PUT', '/api/vendors/acme', { status: 'business', defaultCategory: 'מים' });
  assert.equal(r2.status, 200);
  assert.equal(((await r2.json()) as any).processed, false);
  assert.equal(getVendor('acme')!.status, 'business');
  assert.equal(getVendor('acme')!.defaultCategory, 'מים');
});

test('worker/run awaits the tick and returns the summary; 503 without a worker', async () => {
  let ran = 0;
  const a = await boot({ runTick: async () => { ran++; } });
  const res = await a.call('POST', '/api/worker/run');
  assert.equal(res.status, 200);
  assert.equal(ran, 1);
  assert.ok('attention' in ((await res.json()) as object));
  const b = await boot();
  assert.equal((await b.call('POST', '/api/worker/run')).status, 503);
});

test('ai/test pings; morning/detect reports docs-detected modes, not verified', async () => {
  const a = await boot({ getAi: () => ({ name: 'fake', supportsPdf: false, completeJson: async () => ({}), ping: async () => { throw new Error('down https://x.example/y'); } }) });
  const t = (await (await a.call('POST', '/api/ai/test')).json()) as any;
  assert.equal(t.ok, false);
  assert.doesNotMatch(t.error, /https?:/);
  const none = await boot({ getAi: () => null });
  assert.equal((await none.call('POST', '/api/ai/test')).status, 400);
  const m = await boot({ detectMorning: async () => ({ api_fields: false, api_file: true }) });
  const d = (await (await m.call('POST', '/api/morning/detect')).json()) as any;
  assert.deepEqual(d.modes, { api_fields: false, api_file: true });
  assert.equal(d.verified, false);
  assert.deepEqual(((await (await m.call('GET', '/api/settings')).json()) as any).morningModes, d.modes);
});

const post = (c: Awaited<ReturnType<typeof boot>>, path: string, body?: unknown) => c.call('POST', path, body ?? {});

test('malformed JSON -> 400 JSON without a stack; authenticated unknown /api path -> 404 JSON', async () => {
  const { base, call } = await boot();
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(login.status, 400);
  assert.match(login.headers.get('content-type') ?? '', /json/);
  const text = await login.text();
  assert.equal(JSON.parse(text).error, 'invalid_json');
  assert.doesNotMatch(text, /SyntaxError|node_modules|\.ts:\d+/);
  const nf = await call('GET', '/api/nope/at/all');
  assert.equal(nf.status, 404);
  assert.equal(((await nf.json()) as any).error, 'not_found');
});

test('GET /api/gmail/labels lists labels from the live Gmail source; 503 when not connected or unsupported', async () => {
  const withLabels = { listLabels: async () => ['Invoices', 'קבלות'] } as unknown as GmailSource;
  const { call } = await boot({ getDeps: () => ({ deps: deps(), gmail: withLabels }) });
  const ok = await call('GET', '/api/gmail/labels');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { labels: ['Invoices', 'קבלות'] });
  const off = await boot({ getDeps: () => { throw new Error('gmail not connected'); } });
  assert.equal((await off.call('GET', '/api/gmail/labels')).status, 503);
  const bare = await boot(); // a source without listLabels
  assert.equal((await bare.call('GET', '/api/gmail/labels')).status, 503);
  const failing = { listLabels: async () => { throw new Error('Gmail 401: token https://x.test/secret'); } } as unknown as GmailSource;
  const bad = await boot({ getDeps: () => ({ deps: deps(), gmail: failing }) });
  const r = await bad.call('GET', '/api/gmail/labels');
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { error: 'gmail_unavailable' });
});

test('retry resets attempts and nextAttemptAt; storage_error -> ready, accounting_error -> stored', async () => {
  const a = item('needs_attention', FIELDS, 'r1');
  transition(a, 'needs_attention', 'storage_error');
  updateItem(a, { attempts: 4, nextAttemptAt: '2030-01-01T00:00:00Z' });
  const b = item('needs_attention', FIELDS, 'r2');
  transition(b, 'needs_attention', 'accounting_error');
  const { call } = await boot();
  const ra = (await (await call('POST', `/api/items/${a}/retry`)).json()) as any;
  assert.equal(ra.state, 'ready');
  assert.equal(ra.attempts, 0);
  assert.equal(ra.nextAttemptAt, null);
  assert.equal(((await (await call('POST', `/api/items/${b}/retry`)).json()) as any).state, 'stored');
});

test('invalid edit of a ready item returns it to needs_attention; empty patch and unknown category -> 400', async () => {
  businessVendor();
  const id = item('needs_attention', FIELDS, 'e1');
  transition(id, 'ready');
  const { call } = await boot();
  assert.equal((await call('PUT', `/api/items/${id}/fields`, {})).status, 400);
  assert.equal(getItem(id)!.provenance, 'ai');
  assert.equal((await call('PUT', `/api/items/${id}/fields`, { category: 'no such category' })).status, 400);
  const body = (await (await call('PUT', `/api/items/${id}/fields`, { total: null })).json()) as any;
  assert.equal(body.valid, false);
  assert.equal(body.item.state, 'needs_attention');
  assert.equal(body.item.reason, 'missing_total');
  const ok = await call('PUT', `/api/items/${id}/fields`, { total: 118, category: getSettings().categories[0].name });
  assert.equal(((await ok.json()) as any).item.state, 'ready');
});

test('editing a done / stored / ignored item -> 409', async () => {
  const { call } = await boot();
  for (const [i, st] of (['done', 'stored', 'ignored'] as const).entries()) {
    const id = item('needs_attention', FIELDS, `x${i}`);
    transition(id, st);
    assert.equal((await call('PUT', `/api/items/${id}/fields`, { description: 'x' })).status, 409, st);
  }
});

test('worthALook counts recent recipe_failed items only; ?worth=1 lists them', async () => {
  const recent = item('needs_attention', FIELDS, 'w1');
  const old = item('needs_attention', FIELDS, 'w2');
  updateItem(recent, { recipeFailed: true });
  updateItem(old, { recipeFailed: true });
  getDb().prepare('UPDATE items SET updated_at = ? WHERE id = ?').run('2026-05-01T00:00:00Z', old);
  const { call } = await boot();
  assert.equal(((await (await call('GET', '/api/summary')).json()) as any).worthALook, 1);
  const list = (await (await call('GET', '/api/items?worth=1')).json()) as any;
  assert.deepEqual(list.items.map((i: any) => i.id), [recent]);
});

test('limit > 200 -> 400; q treats % and _ literally', async () => {
  item('needs_attention', { description: '100% off_sale' }, 'q1');
  item('needs_attention', { description: 'plain' }, 'q2');
  const { call } = await boot();
  assert.equal((await call('GET', '/api/items?limit=201')).status, 400);
  const hit = (await (await call('GET', `/api/items?q=${encodeURIComponent('100% off_')}`)).json()) as any;
  assert.equal(hit.items.length, 1);
  const none = (await (await call('GET', `/api/items?q=${encodeURIComponent('%')}`)).json()) as any;
  assert.equal(none.items.length, 1); // only the item whose text contains a literal %
});

test('lastTickError redacts a stored secret value (summary and settings)', async () => {
  setSecret('ai_key_openai', 'sk-REDACTME-12345678');
  updateSettings({ lastTickError: 'auth failed for key sk-REDACTME-12345678' });
  const { call } = await boot();
  for (const path of ['/api/summary', '/api/settings']) {
    const text = await (await call('GET', path)).text();
    assert.ok(!text.includes('sk-REDACTME-12345678'), path);
    assert.match(text, /\[redacted\]/);
  }
});

test('worker/run: 200 with summary and 503 without a worker', async () => {
  let ran = 0;
  const a = await boot({ runTick: async () => { ran++; } });
  assert.equal((await post(a, '/api/worker/run')).status, 200);
  assert.equal(ran, 1);
  assert.equal((await post(await boot(), '/api/worker/run')).status, 503);
});

test('backfill start/list/approve/skip/finish with fakes', async () => {
  const started: string[] = [];
  const g = { listCandidateMessages: async (o: { after: string }) => { started.push(o.after); return []; } } as unknown as GmailSource;
  const c = await boot({ getDeps: () => ({ deps: deps(), gmail: g }) });
  const s = await post(c, '/api/backfill/start');
  assert.equal(s.status, 202);
  assert.deepEqual(await s.json(), { started: true });
  await backfillJobDone();
  assert.equal(started.length, 1);
  assert.deepEqual(getSettings().backfillResult, { emails: 0, items: 0, failed: 0 });
  createEmail({ messageId: 'bf', threadId: 't', sender: 's', subject: 's', receivedAt: '2026-06-01T00:00:00Z', mode: 'backfill' });
  const mk = (n: string) => { const { id } = createItem('bf', 'a.pdf', Buffer.from(`%PDF bf ${n}`)); transition(id, 'awaiting_backfill_approval'); return id; };
  const [x, y, z] = [mk('1'), mk('2'), mk('3')];
  const list = (await (await c.call('GET', '/api/backfill')).json()) as any;
  assert.equal(list.rows.length, 3);
  assert.equal(list.running, false);
  assert.ok(list.startedAt);
  assert.equal(list.error, null);
  assert.equal(((await (await post(c, '/api/backfill/skip', { ids: [x] })).json()) as any).skipped, 1);
  assert.equal(getItem(x)!.state, 'dismissed');
  assert.equal((await post(c, '/api/backfill/approve', { ids: [y] })).status, 200);
  assert.notEqual(getItem(y)!.state, 'awaiting_backfill_approval');
  assert.equal((await post(c, '/api/backfill/approve', { ids: 'bad' })).status, 400);
  const fin = (await (await post(c, '/api/backfill/finish')).json()) as any;
  assert.equal(fin.dismissed, 1);
  assert.equal(getItem(z)!.state, 'dismissed');
  assert.equal(getSettings().backfillDone, true);
});

test('backfill start runs in the background: 202 at once, 409 while running (start and finish), result recorded', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const g = { listCandidateMessages: async () => { await gate; return []; } } as unknown as GmailSource;
  const c = await boot({ getDeps: () => ({ deps: deps(), gmail: g }) });
  const first = await post(c, '/api/backfill/start');
  assert.equal(first.status, 202);
  const status = (await (await c.call('GET', '/api/backfill')).json()) as any;
  assert.equal(status.running, true);
  assert.ok(getSettings().backfillStartedAt);
  const second = await post(c, '/api/backfill/start');
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { error: 'backfill_running' });
  assert.equal((await post(c, '/api/backfill/finish')).status, 409);
  release();
  await backfillJobDone();
  const after = (await (await c.call('GET', '/api/backfill')).json()) as any;
  assert.equal(after.running, false);
  assert.ok(after.finishedAt);
  assert.deepEqual(after.result, { emails: 0, items: 0, failed: 0 });
});

test('backfill start failure is recorded sanitized; a new start clears it', async () => {
  setSecret('ai_key_openai', 'sk-supersecretvalue123');
  const g = { listCandidateMessages: async () => { throw new Error('Gmail 500 at https://x.test/q key sk-supersecretvalue123'); } } as unknown as GmailSource;
  const c = await boot({ getDeps: () => ({ deps: deps(), gmail: g }) });
  assert.equal((await post(c, '/api/backfill/start')).status, 202);
  await backfillJobDone();
  const st = (await (await c.call('GET', '/api/backfill')).json()) as any;
  assert.equal(st.running, false);
  assert.match(st.error, /Gmail 500/);
  assert.doesNotMatch(st.error, /https?:|supersecret/);
  assert.equal(getSettings().backfillResult, null);
  const ok = { listCandidateMessages: async () => [] } as unknown as GmailSource;
  const c2 = await boot({ getDeps: () => ({ deps: deps(), gmail: ok }) });
  assert.equal((await post(c2, '/api/backfill/start')).status, 202);
  await backfillJobDone();
  assert.equal(((await (await c2.call('GET', '/api/backfill')).json()) as any).error, null);
});

test('valid manual edit of a backfill item waits for approval; invalid edit of an awaiting item -> needs_attention', async () => {
  businessVendor();
  const id = item('needs_attention', { total: null, vat: null, net: null }, 'bfe');
  getDb().prepare(`UPDATE emails SET mode = 'backfill' WHERE message_id = 'm-bfe'`).run();
  const { call } = await boot();
  const body = (await (await call('PUT', `/api/items/${id}/fields`, { total: 118, vat: 18, net: 100 })).json()) as any;
  assert.equal(body.valid, true);
  assert.equal(body.item.state, 'awaiting_backfill_approval');
  const bad = (await (await call('PUT', `/api/items/${id}/fields`, { total: null })).json()) as any;
  assert.equal(bad.valid, false);
  assert.equal(bad.item.state, 'needs_attention');
});

test('missed: list, queue (ingests, marks queued), hide', async () => {
  const ins = getDb().prepare(`INSERT INTO missed (message_id, sender, subject, received_at, found_at, status) VALUES (?, 's@x.com', 's', '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z', 'open')`);
  ins.run('mq'); ins.run('mh');
  const g = {
    fetchMessage: async (id: string) => ({ id, threadId: 't', sender: 's@x.com', subject: 's', receivedAt: '2026-06-01T00:00:00Z', pdfs: [{ name: 'a.pdf', data: Buffer.from('%PDF-1 missed') }], html: '', text: '' }),
    markHandled: async () => {},
  } as unknown as GmailSource;
  const c = await boot({ getDeps: () => ({ deps: deps(), gmail: g }) });
  assert.equal(((await (await c.call('GET', '/api/missed')).json()) as any[]).length, 2);
  assert.equal((await post(c, '/api/missed/mq/queue')).status, 200);
  assert.equal(getDb().prepare("SELECT status FROM missed WHERE message_id = 'mq'").pluck().get(), 'queued');
  assert.equal((await post(c, '/api/missed/mh/hide')).status, 200);
  assert.equal(getDb().prepare("SELECT status FROM missed WHERE message_id = 'mh'").pluck().get(), 'hidden');
});
