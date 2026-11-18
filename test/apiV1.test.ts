import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { resetLoginLimiter } from '../server/auth.js';
import { createEmail, createItem, setItemFields, transition, updateItem } from '../server/core/items.js';
import { recordIngestFailure } from '../server/core/ingestFailures.js';
import { updateSettings } from '../server/settings.js';
import type { Deps, ExtractedFields } from '../server/core/types.js';
import type { GmailSource } from '../server/sources/gmail.js';

process.env.SECRET_KEY = 'test-key-for-unit-tests-only-0123456789';
process.env.APP_PASSWORD = 'correct horse';
process.env.API_TOKEN = 'test-api-token-synthetic';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });
beforeEach(() => { openDb(':memory:'); resetLoginLimiter(); delete process.env.PUBLIC_URL; });

async function boot() {
  const app = createApp({ getDeps: () => ({ deps: {} as Deps, gmail: {} as GmailSource }), now: () => new Date('2026-06-15T09:00:00Z') });
  const s = await new Promise<Server>((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  servers.push(s);
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse' }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const get = (path: string, headers: Record<string, string> = { authorization: `Bearer ${process.env.API_TOKEN}` }) =>
    fetch(`${base}${path}`, { headers });
  return { get, cookie };
}

const FIELDS: ExtractedFields = {
  vendorName: 'ספק דמו', vendorTaxId: '123456789', docType: 'tax_invoice', docNumber: '1001', issueDate: '2026-06-01',
  total: 118, vat: 18, net: 100, currency: 'ILS', allocationNumber: null, description: 'שירות', category: 'office',
};

function seed(tag: string, state: 'needs_attention' | 'awaiting_vendor' | 'done', over: Partial<ExtractedFields> = {}) {
  createEmail({ messageId: `m-${tag}`, threadId: 't', sender: 's@x.com', subject: 's', receivedAt: '2026-06-01T00:00:00Z', mode: 'ongoing' });
  const { id } = createItem(`m-${tag}`, 'a.pdf', Buffer.from(`%PDF-1.4 fake ${tag}`));
  setItemFields(id, { ...FIELDS, docNumber: `d-${tag}`, ...over }, 'ai');
  transition(id, state, state === 'needs_attention' ? 'missing_total' : undefined);
  return id;
}

function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
}

test('auth: valid token 200; wrong token, no token and cookie-only 401', async () => {
  const { get, cookie } = await boot();
  assert.equal((await get('/api/v1/summary')).status, 200);
  assert.equal((await get('/api/v1/invoices')).status, 200);
  assert.equal((await get('/api/v1/summary', { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await get('/api/v1/summary', {})).status, 401);
  assert.equal((await get('/api/v1/summary', { cookie })).status, 401);
  assert.equal((await get('/api/v1/nope')).status, 404);
});

test('summary: counts match seeded items, plus reviewUrl; no CORS headers', async () => {
  seed('a', 'needs_attention');
  seed('b', 'awaiting_vendor');
  seed('c', 'done');
  recordIngestFailure('m-fail', 'ongoing', new Error('boom'));
  updateSettings({ lastTickError: 'failed https://api.example.com/x?token=abc' });
  process.env.PUBLIC_URL = 'https://ic.example.com/';
  const { get } = await boot();
  const res = await get('/api/v1/summary');
  const s = (await res.json()) as any;
  assert.equal(s.attention, 3);
  assert.equal(s.awaitingVendor, 1);
  assert.equal(s.ingestFailures, 1);
  assert.equal(s.reviewUrl, 'https://ic.example.com/attention');
  assert.ok(!String(s.lastTickError).includes('api.example.com'));
  assert.ok([...res.headers.keys()].every((h) => !h.startsWith('access-control-')));
});

test('invoices: newest first, limit validated, no text/pdf/tax ids, relative urls without PUBLIC_URL', async () => {
  const ids = ['a', 'b', 'c'].map((t) => seed(t, 'done'));
  updateItem(ids[0], { storagePath: '/x/2026/office/f.pdf', accountingMode: 'api_fields' });
  const { get } = await boot();
  const list = (await (await get('/api/v1/invoices?limit=2')).json()) as any[];
  assert.equal(list.length, 2);
  assert.equal(list[0].id, ids[2]);
  assert.deepEqual(Object.keys(list[0]).sort(), ['accountingMode', 'category', 'currency', 'date', 'id', 'reason',
    'state', 'storagePath', 'total', 'url', 'vendor']);
  assert.equal(list[0].url, `/items/${ids[2]}`);
  assert.equal(list[0].date, '2026-06-01');
  const all = (await (await get('/api/v1/invoices')).json()) as any[];
  assert.equal(all.length, 3);
  assert.equal(all.find((i) => i.id === ids[0]).storagePath, '/x/2026/office/f.pdf');
  const keys = keysDeep(all);
  for (const k of keys) assert.ok(!/text|pdf|taxid/i.test(k), `unexpected key ${k}`);
  assert.ok(!JSON.stringify(all).includes('123456789'));
  assert.equal((await get('/api/v1/invoices?limit=100')).status, 200);
  assert.equal((await get('/api/v1/invoices?limit=101')).status, 400);
  assert.equal((await get('/api/v1/invoices?limit=0')).status, 400);
});

test('invoices: url uses PUBLIC_URL; reason is the enum code only', async () => {
  const id = seed('a', 'needs_attention');
  process.env.PUBLIC_URL = 'https://ic.example.com//';
  const { get } = await boot();
  const [row] = (await (await get('/api/v1/invoices')).json()) as any[];
  assert.equal(row.url, `https://ic.example.com/items/${id}`);
  assert.equal(row.reason, 'missing_total');
});
