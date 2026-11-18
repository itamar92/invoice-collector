import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { serveSpa } from '../server/spa.js';
import { resetLoginLimiter } from '../server/auth.js';
import { getSettings } from '../server/settings.js';

process.env.SECRET_KEY = 'test-key-for-unit-tests-only-0123456789';
process.env.APP_PASSWORD = 'pw';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });
beforeEach(() => { openDb(':memory:'); resetLoginLimiter(); });

const INDEX = '<!doctype html><html lang="he" dir="rtl"><body><div id="root"></div></body></html>';

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-spa-'));
  fs.writeFileSync(path.join(dir, 'index.html'), INDEX);
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
  const app = createApp({
    getDeps: () => { throw new Error('not connected'); },
  });
  serveSpa(app, dir);
  const s = await new Promise<Server>((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

test('serves index.html at / and for unknown client routes; static assets as files', async () => {
  const base = await boot();
  for (const p of ['/', '/attention', '/items/abc', '/settings?connected=google']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type') ?? '', /text\/html/, p);
    assert.equal(await r.text(), INDEX, p);
  }
  const js = await fetch(`${base}/assets/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') ?? '', /javascript/);
});

test('/api paths keep precedence: JSON, never index.html', async () => {
  const base = await boot();
  const health = await fetch(`${base}/api/health`);
  assert.deepEqual(await health.json(), { ok: true });
  for (const p of ['/api/nope', '/api/v1/nope', '/api', '/api/']) {
    const r = await fetch(base + p);
    assert.notEqual(r.status, 200, p);
    assert.match(r.headers.get('content-type') ?? '', /json/, p);
  }
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const nf = await fetch(`${base}/api/nope`, { headers: { cookie } });
  assert.equal(nf.status, 404);
  assert.deepEqual(await nf.json(), { error: 'not_found' });
  const s = await fetch(`${base}/api/settings`, { headers: { cookie } });
  assert.equal(((await s.json()) as { settings: { locale: string } }).settings.locale, getSettings().locale);
});

test('a missing asset under /assets is a 404, not index.html; non-GET is not served the SPA', async () => {
  const base = await boot();
  const r = await fetch(`${base}/assets/missing.js`);
  assert.equal(r.status, 404);
  const post = await fetch(`${base}/attention`, { method: 'POST' });
  assert.equal(post.status, 404);
});
